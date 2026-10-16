/**
 * THE LOOPHOLE — Express API Application (§7, §11.3, §11.6)
 * Provides /health, /api/scenario, /api/run, /api/run/:runId, and /api/selftest.
 */

import express from 'express';
import {
  buildDynamicFixtureForKpiConfig,
  CANONICAL_FIXTURES,
} from '../shared/fixtures';
import { buildVerifiedRunReport } from '../shared/runHarness';
import {
  EVALUATOR_VERSION,
  getCleanCoSpec,
  SCENARIO_ID,
  validateKpiTargetFeasibility,
} from '../shared/scenario';
import { validateAgentPlanSchema } from '../shared/schemaGate';
import { runAllAcceptanceTests } from '../shared/selfTestSuite';
import type {
  AgentPlan,
  FixturePresetId,
  ProvenanceType,
  RunErrorDetail,
  RunReport,
} from '../shared/types';
import { compileNaturalLanguageKpi, synthesizeGeminiSpeech } from './aiExtras';
import { generateLiveGeminiPlan, PlannerExecutionError } from './geminiPlanner';

const volatileRunCache = new Map<string, RunReport>();
const MAX_CACHE_ENTRIES = 100;

function cacheRunReport(report: RunReport): void {
  if (volatileRunCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = volatileRunCache.keys().next().value;
    if (oldestKey) volatileRunCache.delete(oldestKey);
  }
  volatileRunCache.set(report.runId, report);
}

function generateRunId(provenance: ProvenanceType): string {
  const prefix = provenance === 'LIVE_GEMINI' ? 'run_live' : 'run_fix';
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

export function createApiRouter(): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));

  // GET /health
  router.get('/health', (_req, res) => {
    const hasKey = Boolean(
      (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim()
    );
    res.status(200).json({
      status: 'ok',
      version: EVALUATOR_VERSION,
      scenarioId: SCENARIO_ID,
      liveGeminiKeyConfigured: hasKey,
    });
  });

  // GET /api/scenario
  router.get('/api/scenario', (_req, res) => {
    const hasKey = Boolean(
      (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim()
    );
    res.status(200).json({
      spec: getCleanCoSpec(),
      fixtures: Object.values(CANONICAL_FIXTURES).map((f) => ({
        presetId: f.presetId,
        label: f.label,
        description: f.description,
        recommendedKpi: f.recommendedKpi,
        recommendedTarget: f.recommendedTarget,
        actionCount: f.plan.actions.length,
      })),
      liveGeminiKeyConfigured: hasKey,
    });
  });

  // GET /api/selftest
  router.get('/api/selftest', (_req, res) => {
    const report = runAllAcceptanceTests();
    res.status(200).json(report);
  });

  // GET /api/run/:runId (Optional volatile cache lookup per §7)
  router.get('/api/run/:runId', (req, res) => {
    const report = volatileRunCache.get(req.params.runId);
    if (!report) {
      res.status(404).json({
        error: 'RUN_NOT_FOUND',
        message: `Run ID "${req.params.runId}" not found in volatile server cache.`,
      });
      return;
    }
    res.status(200).json(report);
  });

  // POST /api/run
  router.post('/api/run', async (req, res) => {
    const traceId = `tr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const startedAt = new Date().toISOString();
    const body = (req.body ?? {}) as Record<string, unknown>;

    const scenarioId = body.scenarioId ?? SCENARIO_ID;
    if (scenarioId !== SCENARIO_ID) {
      const errorDetail: RunErrorDetail = {
        code: 'INVALID_REQUEST',
        httpStatus: 422,
        stage: 'FEASIBILITY_GATE',
        message: `Unsupported scenarioId "${String(scenarioId)}". Only "${SCENARIO_ID}" is permitted.`,
        traceId,
        retryable: false,
      };
      res.status(422).json({ error: errorDetail });
      return;
    }

    const kpiIdRaw = typeof body.kpiId === 'string' ? body.kpiId : '';
    const targetRaw = typeof body.target === 'number' ? body.target : Number(body.target);
    const maxStepsRaw =
      body.maxSteps !== undefined && body.maxSteps !== null
        ? Number(body.maxSteps)
        : undefined;
    const maxActionCostRaw =
      body.maxActionCost !== undefined && body.maxActionCost !== null
        ? Number(body.maxActionCost)
        : undefined;

    // 1. 422 Feasibility Gate (Executed BEFORE any model API call per AT-11)
    const feasibility = validateKpiTargetFeasibility(
      kpiIdRaw,
      targetRaw,
      maxStepsRaw,
      maxActionCostRaw
    );
    if (!feasibility.valid) {
      const errorDetail: RunErrorDetail = {
        code: 'IMPOSSIBLE_TARGET',
        httpStatus: 422,
        stage: 'FEASIBILITY_GATE',
        message: feasibility.message,
        traceId,
        retryable: false,
      };
      res.status(422).json({ error: errorDetail });
      return;
    }

    const { kpiConfig } = feasibility;
    const effectiveMaxSteps = kpiConfig.maxSteps ?? 9;
    const requestedMode: ProvenanceType =
      body.mode === 'TEST_FIXTURE' ? 'TEST_FIXTURE' : 'LIVE_GEMINI';
    const fixturePresetId =
      typeof body.fixturePresetId === 'string'
        ? (body.fixturePresetId as FixturePresetId)
        : undefined;

    const runId = generateRunId(requestedMode);
    let agentPlan: AgentPlan;
    let resolvedModelVersion = 'UNKNOWN';
    let latencyMs = 0;
    let usedFixturePreset: FixturePresetId | undefined;
    let plannerAttempts = 1;
    let plannerRetryHistory: import('../shared/types').PlannerAttemptRecord[] | undefined;

    try {
      if (body.fixedPlanOverride !== undefined) {
        // Fixed-Plan Replay (§3 line 53, AT-02)
        const schemaCheck = validateAgentPlanSchema(body.fixedPlanOverride, effectiveMaxSteps);
        if (!schemaCheck.valid || !schemaCheck.plan) {
          throw new PlannerExecutionError({
            code: 'MODEL_ERROR',
            httpStatus: 502,
            stage: 'SCHEMA_GATE',
            message: `Fixed-Plan Replay rejected by Schema Gate: ${schemaCheck.error}`,
            traceId,
            retryable: false,
          });
        }
        agentPlan = schemaCheck.plan;
        resolvedModelVersion =
          requestedMode === 'LIVE_GEMINI' ? 'FIXED_PLAN_REPLAY' : 'DETERMINISTIC_FIXTURE_V15.2';
      } else if (requestedMode === 'TEST_FIXTURE') {
        const fixture = buildDynamicFixtureForKpiConfig(kpiConfig, fixturePresetId);
        usedFixturePreset = fixture.presetId;
        const schemaCheck = validateAgentPlanSchema(fixture.plan, effectiveMaxSteps);
        if (!schemaCheck.valid || !schemaCheck.plan) {
          throw new PlannerExecutionError({
            code: 'MODEL_ERROR',
            httpStatus: 502,
            stage: 'SCHEMA_GATE',
            message: `Fixture plan failed Schema Gate: ${schemaCheck.error}`,
            traceId,
            retryable: false,
          });
        }
        agentPlan = schemaCheck.plan;
        resolvedModelVersion = 'DETERMINISTIC_FIXTURE_V15.2';
        latencyMs = 2;
      } else {
        // LIVE_GEMINI: Actual call to gemini-4-argon via @google/genai Interactions API
        const liveResult = await generateLiveGeminiPlan(kpiConfig, traceId);
        agentPlan = liveResult.agentPlan;
        resolvedModelVersion = liveResult.resolvedModelVersion;
        latencyMs = liveResult.latencyMs;
        plannerAttempts = liveResult.plannerAttempts;
        plannerRetryHistory = liveResult.plannerRetryHistory;
      }
    } catch (err) {
      if (err instanceof PlannerExecutionError) {
        res.status(err.detail.httpStatus).json({
          outcomeStatus: 'MODEL_ERROR',
          error: err.detail,
        });
        return;
      }
      const fallbackError: RunErrorDetail = {
        code: 'MODEL_ERROR',
        httpStatus: 502,
        stage: 'GEMINI_POLICY_PLANNER',
        message: err instanceof Error ? err.message : 'Unexpected planner failure.',
        traceId,
        retryable: true,
      };
      res.status(502).json({
        outcomeStatus: 'MODEL_ERROR',
        error: fallbackError,
      });
      return;
    }

    // Execute Deterministic Engine + Independent Inspector
    const runReport = buildVerifiedRunReport({
      runId,
      kpiConfig,
      agentPlan,
      provenance: requestedMode,
      fixturePresetId: usedFixturePreset,
      resolvedModelVersion,
      startedAt,
      latencyMs,
      plannerAttempts,
      plannerRetryHistory,
    });

    if (!runReport.inspector.integrityPass) {
      const integrityError: RunErrorDetail = {
        code: 'INTEGRITY_FAILURE',
        httpStatus: 500,
        stage: 'INSPECTOR_AUDIT',
        message: runReport.inspector.summaryMessage,
        traceId,
        retryable: true,
      };
      runReport.errors = integrityError;
      cacheRunReport(runReport);
      res.status(500).json(runReport);
      return;
    }

    cacheRunReport(runReport);
    res.status(200).json(runReport);
  });

  // POST /api/tts (C-1: Inspector Audio Briefing via gemini-3.8-flash-lite-tts with fallback)
  router.post('/api/tts', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const text = typeof body.text === 'string' ? body.text : '';
    const voice = typeof body.voice === 'string' ? body.voice : undefined;
    const style = typeof body.style === 'string' ? body.style : undefined;
    const result = await synthesizeGeminiSpeech({ text, voice, style });
    res.status(200).json(result);
  });

  // POST /api/compile-kpi (C-2: Natural Language KPI Compiler & Loophole Risk Predictor)
  router.post('/api/compile-kpi', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const promptText =
      typeof body.promptText === 'string'
        ? body.promptText
        : typeof body.prompt === 'string'
          ? body.prompt
          : '';
    if (!promptText.trim()) {
      res.status(400).json({
        error: 'EMPTY_PROMPT',
        message: 'Please provide a natural-language reward instruction in "promptText".',
      });
      return;
    }
    const mode = body.mode === 'TEST_FIXTURE' ? 'TEST_FIXTURE' : 'LIVE_GEMINI';
    const compiled = await compileNaturalLanguageKpi({ promptText, mode });
    res.status(200).json(compiled);
  });

  return router;
}
