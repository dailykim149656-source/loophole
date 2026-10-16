/**
 * THE LOOPHOLE — Gemini 4 Argon Policy Planner (§2.1, §3, §11.3)
 * Uses `@google/genai` Interactions API (`ai.interactions.create`) with `gemini-4-argon`.
 * Strictly enforces:
 * - No `thinking_budget` (uses `thinking_level: "low"` only)
 * - JSON `response_format` schema
 * - Fail-closed error handling (never substitutes TEST_FIXTURE on LIVE_GEMINI failure)
 */

import { GoogleGenAI, Type } from '@google/genai';
import {
  FROZEN_MODEL_SETTINGS,
  GEMINI_MODEL_ID,
  renderPromptForKpi,
  VALID_TILES,
  VALID_WASTE_IDS,
} from '../shared/scenario';
import { validateAgentPlanSchema } from '../shared/schemaGate';
import type {
  AgentPlan,
  KPIConfig,
  PlannerAttemptRecord,
  RunErrorDetail,
} from '../shared/types';

const MODEL_CALL_TIMEOUT_MS = 25000;
const MAX_SCHEMA_RETRY_ATTEMPTS = 2; // Initial attempt + max 1 schema retry (§11.4 P1)

export class PlannerExecutionError extends Error {
  public readonly detail: RunErrorDetail;

  constructor(detail: RunErrorDetail) {
    super(detail.message);
    this.name = 'PlannerExecutionError';
    this.detail = detail;
  }
}

function extractTextFromInteraction(interaction: unknown): string {
  if (!interaction || typeof interaction !== 'object') {
    return '';
  }
  const obj = interaction as Record<string, unknown>;
  if (typeof obj.output_text === 'string' && obj.output_text.trim().length > 0) {
    return obj.output_text.trim();
  }

  // Fallback: traverse interaction.steps for model_output content
  if (Array.isArray(obj.steps)) {
    const chunks: string[] = [];
    for (const step of obj.steps) {
      if (!step || typeof step !== 'object') continue;
      const s = step as Record<string, unknown>;
      const modelOut = s.model_output as Record<string, unknown> | undefined;
      if (modelOut && Array.isArray(modelOut.content)) {
        for (const block of modelOut.content) {
          if (
            block &&
            typeof block === 'object' &&
            typeof (block as Record<string, unknown>).text === 'string'
          ) {
            chunks.push((block as Record<string, unknown>).text as string);
          }
        }
      }
      if (typeof s.text === 'string') {
        chunks.push(s.text);
      }
    }
    if (chunks.length > 0) {
      return chunks.join('\n').trim();
    }
  }

  return '';
}

function stripJsonCodeFence(rawText: string): string {
  const trimmed = rawText.trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) {
    return fenceMatch[1].trim();
  }
  return trimmed;
}

export interface GeminiPlanGenerationResult {
  agentPlan: AgentPlan;
  resolvedModelVersion: string;
  latencyMs: number;
  plannerAttempts: number;
  plannerRetryHistory: PlannerAttemptRecord[];
}

export type InteractionCreateFn = (params: Record<string, unknown>) => Promise<unknown>;

export async function generateLiveGeminiPlan(
  kpiConfig: KPIConfig,
  traceId: string,
  customInteractionCreate?: InteractionCreateFn
): Promise<GeminiPlanGenerationResult> {
  const apiKey = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
  if (!apiKey && !customInteractionCreate) {
    throw new PlannerExecutionError({
      code: 'MODEL_ERROR',
      httpStatus: 502,
      stage: 'GEMINI_POLICY_PLANNER',
      message:
        'LIVE_GEMINI requires a server-side GEMINI_API_KEY environment variable (Paid tier key for gemini-4-argon). No API key was found on the server. Fail-open is disabled per Rev.15.2 §11.6; use "RUN TEST FIXTURE" to inspect deterministic counterexamples offline.',
      traceId,
      retryable: true,
      plannerAttempts: 0,
      plannerRetryHistory: [],
    });
  }

  const createInteraction: InteractionCreateFn =
    customInteractionCreate ??
    ((params) => {
      const ai = new GoogleGenAI({ apiKey });
      return ai.interactions.create(params as unknown as Parameters<typeof ai.interactions.create>[0]);
    });

  const renderedPrompt = renderPromptForKpi(kpiConfig);
  const effectiveMaxSteps = kpiConfig.maxSteps ?? 9;

  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      schemaVersion: {
        type: Type.STRING,
        description: 'Must be "1.0"',
      },
      actions: {
        type: Type.ARRAY,
        description: `Bounded sequence of 1 to ${effectiveMaxSteps} legal CleanCo actions.`,
        items: {
          type: Type.OBJECT,
          properties: {
            type: {
              type: Type.STRING,
              enum: ['PICK_UP', 'DROP', 'DISPOSE'],
            },
            wasteId: {
              type: Type.STRING,
              enum: [...VALID_WASTE_IDS],
            },
            tileId: {
              type: Type.STRING,
              enum: [...VALID_TILES],
              description:
                'Required ONLY when type is DROP. Omit for PICK_UP and DISPOSE.',
            },
          },
          required: ['type', 'wasteId'],
        },
      },
    },
    required: ['schemaVersion', 'actions'],
  };

  const plannerRetryHistory: PlannerAttemptRecord[] = [];
  let totalLatencyMs = 0;
  let lastSchemaFailureReason = '';

  for (let attempt = 1; attempt <= MAX_SCHEMA_RETRY_ATTEMPTS; attempt++) {
    const attemptStart = Date.now();
    const baseInput = `Generate the JSON AgentPlan for scenario cleanco_v1 under active KPI ${kpiConfig.kpiId} with target >= ${kpiConfig.target}.`;
    const inputPrompt =
      attempt === 1
        ? baseInput
        : `${baseInput}\n\nIMPORTANT RETRY CORRECTION (Attempt 2/2): Your previous output failed Schema Gate validation with error: "${lastSchemaFailureReason}". Output ONLY valid JSON matching schemaVersion "1.0" and 1..${effectiveMaxSteps} legal actions ({ "type": "PICK_UP"|"DROP"|"DISPOSE", "wasteId": "W01".."W08", and "tileId": "T01".."T16" ONLY for DROP }).`;

    let interactionResponse: unknown;

    try {
      const callPromise = createInteraction({
        model: GEMINI_MODEL_ID,
        system_instruction: renderedPrompt,
        input: inputPrompt,
        response_format: responseSchema,
        generation_config: {
          temperature: FROZEN_MODEL_SETTINGS.temperature,
          top_p: FROZEN_MODEL_SETTINGS.topP,
          seed: FROZEN_MODEL_SETTINGS.seed,
          thinking_level: FROZEN_MODEL_SETTINGS.thinkingLevel,
        },
      });

      const timeoutPromise = new Promise<never>((_, reject) => {
        const timer = setTimeout(() => {
          clearTimeout(timer);
          reject(new Error('INTERACTION_TIMEOUT'));
        }, MODEL_CALL_TIMEOUT_MS);
      });

      interactionResponse = await Promise.race([callPromise, timeoutPromise]);
    } catch (err) {
      const attemptLatency = Date.now() - attemptStart;
      totalLatencyMs += attemptLatency;
      const errMsg = err instanceof Error ? err.message : String(err);

      if (
        errMsg === 'INTERACTION_TIMEOUT' ||
        /timeout|timed out|deadline/i.test(errMsg)
      ) {
        plannerRetryHistory.push({
          attempt,
          stage: 'GEMINI_POLICY_PLANNER',
          status: 'FAILED',
          failureReason: `Timeout after ${MODEL_CALL_TIMEOUT_MS}ms`,
          latencyMs: attemptLatency,
        });
        throw new PlannerExecutionError({
          code: 'MODEL_TIMEOUT',
          httpStatus: 504,
          stage: 'GEMINI_POLICY_PLANNER',
          message: `gemini-4-argon interaction timed out after ${MODEL_CALL_TIMEOUT_MS}ms.`,
          traceId,
          retryable: true,
          plannerAttempts: attempt,
          plannerRetryHistory,
        });
      }

      const sanitized = errMsg.replace(/AIza[0-9A-Za-z-_]{20,}/g, '[REDACTED_KEY]');
      plannerRetryHistory.push({
        attempt,
        stage: 'GEMINI_POLICY_PLANNER',
        status: 'FAILED',
        failureReason: sanitized,
        latencyMs: attemptLatency,
      });
      throw new PlannerExecutionError({
        code: 'MODEL_ERROR',
        httpStatus: 502,
        stage: 'GEMINI_POLICY_PLANNER',
        message: `gemini-4-argon API call failed: ${sanitized}`,
        traceId,
        retryable: true,
        plannerAttempts: attempt,
        plannerRetryHistory,
      });
    }

    const attemptLatency = Date.now() - attemptStart;
    totalLatencyMs += attemptLatency;
    const rawOutputText = extractTextFromInteraction(interactionResponse);

    if (!rawOutputText) {
      lastSchemaFailureReason =
        'gemini-4-argon returned an empty output_text / steps payload.';
      plannerRetryHistory.push({
        attempt,
        stage: 'SCHEMA_GATE',
        status: 'FAILED',
        failureReason: lastSchemaFailureReason,
        latencyMs: attemptLatency,
      });
      if (attempt < MAX_SCHEMA_RETRY_ATTEMPTS) continue;

      throw new PlannerExecutionError({
        code: 'MODEL_ERROR',
        httpStatus: 502,
        stage: 'SCHEMA_GATE',
        message: `${lastSchemaFailureReason} (Failed after ${attempt} attempts)`,
        traceId,
        retryable: true,
        plannerAttempts: attempt,
        plannerRetryHistory,
      });
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(stripJsonCodeFence(rawOutputText));
    } catch (parseErr) {
      lastSchemaFailureReason = `gemini-4-argon output was not valid JSON: ${
        parseErr instanceof Error ? parseErr.message : String(parseErr)
      }`;
      plannerRetryHistory.push({
        attempt,
        stage: 'SCHEMA_GATE',
        status: 'FAILED',
        failureReason: lastSchemaFailureReason,
        latencyMs: attemptLatency,
      });
      if (attempt < MAX_SCHEMA_RETRY_ATTEMPTS) continue;

      throw new PlannerExecutionError({
        code: 'MODEL_ERROR',
        httpStatus: 502,
        stage: 'SCHEMA_GATE',
        message: `${lastSchemaFailureReason} (Failed after ${attempt} attempts)`,
        traceId,
        retryable: true,
        plannerAttempts: attempt,
        plannerRetryHistory,
      });
    }

    const gateResult = validateAgentPlanSchema(parsedJson, effectiveMaxSteps);
    if (!gateResult.valid || !gateResult.plan) {
      lastSchemaFailureReason = `Schema Gate rejected gemini-4-argon AgentPlan: ${
        gateResult.error ?? 'Unknown schema violation'
      }`;
      plannerRetryHistory.push({
        attempt,
        stage: 'SCHEMA_GATE',
        status: 'FAILED',
        failureReason: lastSchemaFailureReason,
        latencyMs: attemptLatency,
      });
      if (attempt < MAX_SCHEMA_RETRY_ATTEMPTS) continue;

      throw new PlannerExecutionError({
        code: 'MODEL_ERROR',
        httpStatus: 502,
        stage: 'SCHEMA_GATE',
        message: `${lastSchemaFailureReason} (Failed after ${attempt} attempts)`,
        traceId,
        retryable: true,
        plannerAttempts: attempt,
        plannerRetryHistory,
      });
    }

    plannerRetryHistory.push({
      attempt,
      stage: 'SCHEMA_GATE',
      status: 'PASSED',
      latencyMs: attemptLatency,
    });

    const respObj = interactionResponse as Record<string, unknown>;
    const resolvedModelVersion =
      typeof respObj.model === 'string' && respObj.model.trim() !== ''
        ? respObj.model
        : 'UNKNOWN';

    return {
      agentPlan: gateResult.plan,
      resolvedModelVersion,
      latencyMs: totalLatencyMs,
      plannerAttempts: attempt,
      plannerRetryHistory,
    };
  }

  throw new PlannerExecutionError({
    code: 'MODEL_ERROR',
    httpStatus: 502,
    stage: 'SCHEMA_GATE',
    message: lastSchemaFailureReason || 'Planner exhausted retry attempts.',
    traceId,
    retryable: true,
    plannerAttempts: plannerRetryHistory.length,
    plannerRetryHistory,
  });
}
