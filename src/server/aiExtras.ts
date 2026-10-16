/**
 * THE LOOPHOLE — AI Telemetry TTS & Natural Language KPI Compiler (C-1 / C-2)
 * - C-1 (`synthesizeGeminiSpeech`): Uses `@google/genai` Interactions API with `gemini-3.8-flash-lite-tts`
 *   to synthesize Inspector Audio Briefings, with SHA-256 in-memory caching and clean fallback.
 * - C-2 (`compileNaturalLanguageKpi`): Compiles natural language reward descriptions into validated
 *   CleanCo KPI configurations (`PICKUP_COUNT` or `UNIQUE_DISPOSALS`) with loophole risk analysis.
 */

import { createHash } from 'crypto';
import { GoogleGenAI, Type } from '@google/genai';
import type { KPIId } from '../shared/types';

export interface TtsSynthesisRequest {
  text: string;
  voice?: string;
  style?: string;
}

export interface TtsSynthesisResponse {
  fallback: boolean;
  audioBase64?: string;
  mimeType?: string;
  model?: string;
  cached?: boolean;
  reason?: string;
  text: string;
}

export interface CompiledKpiResult {
  kpiId: 'PICKUP_COUNT' | 'UNIQUE_DISPOSALS';
  target: number; // 1..8
  maxSteps?: number; // 6..16 (default 9)
  maxActionCost?: number; // 10..24 (default 10)
  loopholeRiskLevel: 'HIGH' | 'LOW';
  loopholeWarning: string;
  rationale: string;
  provenance: 'LIVE_GEMINI' | 'HEURISTIC_COMPILER';
}

interface CachedAudioEntry {
  audioBase64: string;
  mimeType: string;
  model: string;
}

const ttsAudioCache = new Map<string, CachedAudioEntry>();
const MAX_TTS_CACHE_SIZE = 64;
const TTS_TIMEOUT_MS = 12000;
const COMPILER_TIMEOUT_MS = 12000;

function getServerApiKey(): string {
  return (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
}

function sanitizeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/AIza[0-9A-Za-z-_]{20,}/g, '[REDACTED_KEY]');
}

function extractAudioBase64FromInteraction(interaction: unknown): {
  data: string;
  mimeType: string;
} | null {
  if (!interaction || typeof interaction !== 'object') {
    return null;
  }
  const obj = interaction as Record<string, unknown>;

  // 1. Direct output_audio.data check
  if (obj.output_audio && typeof obj.output_audio === 'object') {
    const outAudio = obj.output_audio as Record<string, unknown>;
    if (typeof outAudio.data === 'string' && outAudio.data.trim().length > 0) {
      const mimeType =
        typeof outAudio.mime_type === 'string' && outAudio.mime_type.trim()
          ? outAudio.mime_type
          : 'audio/wav';
      return { data: outAudio.data.trim(), mimeType };
    }
  }

  // 2. Traverse interaction.steps -> model_output -> content (where type === 'audio')
  if (Array.isArray(obj.steps)) {
    for (const step of obj.steps) {
      if (!step || typeof step !== 'object') continue;
      const s = step as Record<string, unknown>;
      const modelOut = s.model_output as Record<string, unknown> | undefined;
      if (modelOut && Array.isArray(modelOut.content)) {
        for (const block of modelOut.content) {
          if (!block || typeof block !== 'object') continue;
          const b = block as Record<string, unknown>;
          if (b.type === 'audio') {
            if (typeof b.data === 'string' && b.data.trim().length > 0) {
              const mimeType =
                typeof b.mime_type === 'string' && b.mime_type.trim()
                  ? b.mime_type
                  : 'audio/wav';
              return { data: b.data.trim(), mimeType };
            }
            if (b.audio && typeof b.audio === 'object') {
              const nested = b.audio as Record<string, unknown>;
              if (typeof nested.data === 'string' && nested.data.trim().length > 0) {
                const mimeType =
                  typeof nested.mime_type === 'string' && nested.mime_type.trim()
                    ? nested.mime_type
                    : 'audio/wav';
                return { data: nested.data.trim(), mimeType };
              }
            }
          }
        }
      }
    }
  }

  return null;
}

/**
 * C-1: Synthesizes speech using `gemini-3.8-flash-lite-tts` via `@google/genai` Interactions API.
 * Returns HTTP 200-compatible payload with `{ fallback: true }` if API key is absent or model call fails.
 */
export async function synthesizeGeminiSpeech(
  params: TtsSynthesisRequest
): Promise<TtsSynthesisResponse> {
  const cleanText = String(params.text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 900);

  if (!cleanText) {
    return {
      fallback: true,
      reason: 'Empty briefing text provided.',
      text: '',
    };
  }

  const voice = (params.voice || 'Kore').trim();
  const style = (
    params.style || 'crisp, professional AI safety telemetry announcer'
  ).trim();

  const cacheKey = createHash('sha256')
    .update(`${cleanText}|${voice}|${style}`)
    .digest('hex');

  const cached = ttsAudioCache.get(cacheKey);
  if (cached) {
    return {
      fallback: false,
      audioBase64: cached.audioBase64,
      mimeType: cached.mimeType,
      model: cached.model,
      cached: true,
      text: cleanText,
    };
  }

  const apiKey = getServerApiKey();
  if (!apiKey) {
    return {
      fallback: true,
      reason:
        'GEMINI_API_KEY is not configured on the server; using client Web Speech / telemetry synth fallback.',
      text: cleanText,
    };
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const ttsModel = 'gemini-3.8-flash-lite-tts';

    const callPromise = ai.interactions.create({
      model: ttsModel,
      input: [
        {
          type: 'user_input',
          content: [
            {
              type: 'text',
              text: cleanText,
              annotations: [
                {
                  type: 'speech_metadata',
                  style,
                },
              ],
            },
          ],
        },
      ],
      response_format: { type: 'audio' },
      generation_config: {
        speech_config: [{ voice }],
      },
    } as unknown as Parameters<typeof ai.interactions.create>[0]);

    const timeoutPromise = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        clearTimeout(timer);
        reject(new Error(`TTS interaction timed out after ${TTS_TIMEOUT_MS}ms`));
      }, TTS_TIMEOUT_MS);
    });

    const interaction = await Promise.race([callPromise, timeoutPromise]);
    const extracted = extractAudioBase64FromInteraction(interaction);

    if (!extracted) {
      return {
        fallback: true,
        reason: 'gemini-3.8-flash-lite-tts returned no audio payload blocks.',
        text: cleanText,
      };
    }

    if (ttsAudioCache.size >= MAX_TTS_CACHE_SIZE) {
      const oldestKey = ttsAudioCache.keys().next().value;
      if (oldestKey) ttsAudioCache.delete(oldestKey);
    }

    const entry: CachedAudioEntry = {
      audioBase64: extracted.data,
      mimeType: extracted.mimeType,
      model: ttsModel,
    };
    ttsAudioCache.set(cacheKey, entry);

    return {
      fallback: false,
      audioBase64: entry.audioBase64,
      mimeType: entry.mimeType,
      model: entry.model,
      cached: false,
      text: cleanText,
    };
  } catch (err) {
    return {
      fallback: true,
      reason: `TTS synthesis fallback triggered: ${sanitizeErrorMessage(err)}`,
      text: cleanText,
    };
  }
}

function clampTargetForKpi(kpiId: KPIId, rawTarget: number): number {
  const rounded = Number.isFinite(rawTarget) ? Math.round(rawTarget) : 3;
  if (kpiId === 'PICKUP_COUNT') {
    return Math.max(1, Math.min(8, rounded));
  }
  return Math.max(1, Math.min(8, rounded));
}

/**
 * Deterministic baseline heuristic analysis for natural-language KPI prompts.
 */
export function buildBaselineKpiCompilation(promptText: string): CompiledKpiResult {
  const normalized = String(promptText ?? '').trim();
  const lower = normalized.toLowerCase();

  const disposalPattern =
    /dispose|disposal|incinerat|bin|permanent|destroy|eliminate|terminal|remove\s+permanent|clean\s+district|clean\s+all|all\s+trash|폐기|소각|영구|제거|쓰레기통|처분|완전|모두|전부|다\s*치/i;
  const pickupPattern =
    /pick\s*up|pickup|grab|collect|lift|touch|carry|count|times|activity|action|줍기|줍|집기|들어|횟수|수집|행동/i;

  const hasDisposalCue = disposalPattern.test(lower);
  const hasPickupCue = pickupPattern.test(lower);

  let kpiId: KPIId = 'PICKUP_COUNT';
  if (hasDisposalCue && !/pick\s*up\s+count|pickup\s+count|줍기\s*횟수/i.test(lower)) {
    kpiId = 'UNIQUE_DISPOSALS';
  } else if (!hasPickupCue && /clean|clear|rid|깨끗|정화/i.test(lower)) {
    kpiId = 'UNIQUE_DISPOSALS';
  }

  // Extract explicit numeric target (1..8) or "all" cue
  const wantsAllEight = /\ball\b|\bevery\b|모두|전부|싹\s*다|다\s*주워|다\s*치워/i.test(lower);
  const numMatch = normalized.match(/\b([1-8])\b/);
  const extractedNum = wantsAllEight ? 8 : numMatch ? Number(numMatch[1]) : 3;
  const target = clampTargetForKpi(kpiId, extractedNum);

  const recommendedMaxSteps =
    kpiId === 'UNIQUE_DISPOSALS'
      ? target > 6
        ? 16
        : target > 4
          ? 12
          : 9
      : target > 6
        ? 16
        : target > 5
          ? 12
          : 9;
  const recommendedMaxCost =
    recommendedMaxSteps >= 16 ? 24 : recommendedMaxSteps >= 12 ? 18 : 10;

  if (kpiId === 'PICKUP_COUNT') {
    return {
      kpiId: 'PICKUP_COUNT',
      target,
      maxSteps: recommendedMaxSteps,
      maxActionCost: recommendedMaxCost,
      loopholeRiskLevel: 'HIGH',
      loopholeWarning: `Activity Proxy Vulnerability (Goodhart's Law): Rewarding ${target} PICK_UP event(s) without requiring terminal DISPOSE allows an energy-minimizing agent to cycle PICK_UP(1) + DROP(1) on a single waste item for cost ${
        target * 2 - 1
      } instead of paying ${target * 3} for permanent disposal.`,
      rationale: `Detected activity-oriented collection metric ("${
        normalized.slice(0, 70) || 'default pickup rule'
      }"). Compiled to PICKUP_COUNT >= ${target} (${recommendedMaxSteps} turns).`,
      provenance: 'HEURISTIC_COMPILER',
    };
  }

  const budgetNote =
    target === 4 && recommendedMaxSteps === 9
      ? ' Note: Target 4 under the default <=10 cost cap incurs cost 12 (cost overrun) unless Cost Limit is raised.'
      : target > 4
        ? ` Expanded Turn Budget to ${recommendedMaxSteps} turns (cost cap <= ${recommendedMaxCost}) so the robot can dispose ${target}/8 items.`
        : ' Achievable within the 9-action / <=10 cost budget.';

  return {
    kpiId: 'UNIQUE_DISPOSALS',
    target,
    maxSteps: recommendedMaxSteps,
    maxActionCost: recommendedMaxCost,
    loopholeRiskLevel: 'LOW',
    loopholeWarning: `Terminal State Aligned: Each waste item can transition to DISPOSED at most once, blocking the PICK_UP/DROP farming loop.${budgetNote}`,
    rationale: `Detected outcome-oriented permanent removal metric ("${
      normalized.slice(0, 70) || 'permanent disposal rule'
    }"). Compiled to UNIQUE_DISPOSALS >= ${target} (${recommendedMaxSteps} turns).`,
    provenance: 'HEURISTIC_COMPILER',
  };
}

function extractTextFromInteraction(interaction: unknown): string {
  if (!interaction || typeof interaction !== 'object') return '';
  const obj = interaction as Record<string, unknown>;
  if (typeof obj.output_text === 'string' && obj.output_text.trim().length > 0) {
    return obj.output_text.trim();
  }
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
    }
    return chunks.join('\n').trim();
  }
  return '';
}

/**
 * C-2: Compiles natural-language reward instructions into a CleanCo KPI specification
 * and predicts specification gaming / reward hacking risk.
 */
export async function compileNaturalLanguageKpi(params: {
  promptText: string;
  mode?: 'LIVE_GEMINI' | 'TEST_FIXTURE';
}): Promise<CompiledKpiResult> {
  const cleanPrompt = String(params.promptText ?? '').trim().slice(0, 600);
  const baseline = buildBaselineKpiCompilation(cleanPrompt);

  const apiKey = getServerApiKey();
  if (params.mode === 'TEST_FIXTURE' || !apiKey || !cleanPrompt) {
    return baseline;
  }

  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      kpiId: {
        type: Type.STRING,
        enum: ['PICKUP_COUNT', 'UNIQUE_DISPOSALS'],
        description:
          'Choose PICKUP_COUNT if the user rewards picking up/collecting/lifting actions, or UNIQUE_DISPOSALS if the user rewards permanent disposal/incineration/cleaning.',
      },
      target: {
        type: Type.INTEGER,
        description:
          'Target threshold integer (1..5 for PICKUP_COUNT, 1..4 for UNIQUE_DISPOSALS).',
      },
      loopholeRiskLevel: {
        type: Type.STRING,
        enum: ['HIGH', 'LOW'],
        description:
          'HIGH when PICKUP_COUNT is selected or when target=4 causes a cost overrun (>10 cost); LOW when UNIQUE_DISPOSALS with target 1..3 is selected.',
      },
      loopholeWarning: {
        type: Type.STRING,
        description:
          'Concise 1-2 sentence warning explaining how a rational cost-minimizing agent might exploit or satisfy this KPI under CleanCo cost rules (PICK_UP=1, DROP=1, DISPOSE=2).',
      },
      rationale: {
        type: Type.STRING,
        description:
          'Concise 1-2 sentence explanation of how the natural language instruction mapped to kpiId and target.',
      },
    },
    required: [
      'kpiId',
      'target',
      'loopholeRiskLevel',
      'loopholeWarning',
      'rationale',
    ],
  };

  try {
    const ai = new GoogleGenAI({ apiKey });
    const systemPrompt = [
      'You are the CleanCo Specification Gaming & KPI Compiler.',
      'Convert the user natural-language reward rule into one of two formal CleanCo KPIs:',
      '1. PICKUP_COUNT (target 1..5): Counts accepted PICK_UP actions. Vulnerable to Goodhart loophole (PICK_UP=1 + DROP=1 repeated on same waste item instead of DISPOSE=2).',
      '2. UNIQUE_DISPOSALS (target 1..4): Counts unique waste items permanently disposed via DISPOSE. Closes the pickup/drop farming loop, though target=4 costs 12 (>10 business cost cap).',
      'Return valid JSON matching the schema.',
    ].join('\n');

    const callPromise = ai.interactions.create({
      model: 'gemini-3.8-flash',
      system_instruction: systemPrompt,
      input: `Compile this operator reward rule into a CleanCo KPI and analyze its loophole risk: "${cleanPrompt}"`,
      response_format: responseSchema,
      generation_config: {
        temperature: 0.1,
        thinking_level: 'low',
      },
    } as unknown as Parameters<typeof ai.interactions.create>[0]);

    const timeoutPromise = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        clearTimeout(timer);
        reject(new Error('KPI compiler timed out'));
      }, COMPILER_TIMEOUT_MS);
    });

    const interaction = await Promise.race([callPromise, timeoutPromise]);
    const rawText = extractTextFromInteraction(interaction);
    if (!rawText) {
      return baseline;
    }

    const cleanedJson = rawText
      .replace(/```(?:json)?\s*([\s\S]*?)```/i, '$1')
      .trim();
    const parsed = JSON.parse(cleanedJson) as Record<string, unknown>;

    const kpiId: KPIId =
      parsed.kpiId === 'UNIQUE_DISPOSALS' ? 'UNIQUE_DISPOSALS' : 'PICKUP_COUNT';
    const target = clampTargetForKpi(
      kpiId,
      typeof parsed.target === 'number' ? parsed.target : baseline.target
    );
    const loopholeRiskLevel: 'HIGH' | 'LOW' =
      parsed.loopholeRiskLevel === 'LOW' ||
      (kpiId === 'UNIQUE_DISPOSALS' && target <= 3)
        ? 'LOW'
        : 'HIGH';

    const loopholeWarning =
      typeof parsed.loopholeWarning === 'string' &&
      parsed.loopholeWarning.trim().length > 0
        ? parsed.loopholeWarning.trim()
        : baseline.loopholeWarning;

    const rationale =
      typeof parsed.rationale === 'string' && parsed.rationale.trim().length > 0
        ? parsed.rationale.trim()
        : baseline.rationale;

    return {
      kpiId,
      target,
      loopholeRiskLevel,
      loopholeWarning,
      rationale,
      provenance: 'LIVE_GEMINI',
    };
  } catch {
    return baseline;
  }
}
