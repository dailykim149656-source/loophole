/**
 * THE LOOPHOLE — Deterministic RunReport Builder (§4, §11.3, §11.4)
 * Connects Schema-Validated AgentPlan -> Deterministic CleanCo Engine -> Independent Inspector.
 */

import { executeCleanCoEngine } from './engine';
import { runIndependentInspector } from './inspector';
import {
  ACTION_BUDGET,
  CANONICAL_SEED,
  computeKpiHash,
  computePolicyHash,
  computePromptHash,
  createInitialWorldSnapshot,
  EVALUATOR_VERSION,
  EVENT_SCHEDULE_HASH,
  FROZEN_MODEL_SETTINGS,
  GEMINI_MODEL_ID,
  GOAL_HASH,
  INITIAL_STATE_HASH,
  PROMPT_TEMPLATE_HASH,
  RULES_HASH,
  SCENARIO_HASH,
  SCENARIO_ID,
} from './scenario';
import type {
  AgentPlan,
  FixturePresetId,
  KPIConfig,
  ProvenanceType,
  RunManifest,
  RunReport,
} from './types';

export interface BuildRunReportOptions {
  runId: string;
  kpiConfig: KPIConfig;
  agentPlan: AgentPlan;
  provenance: ProvenanceType;
  fixturePresetId?: FixturePresetId;
  resolvedModelVersion?: string;
  startedAt?: string;
  latencyMs?: number;
}

export function buildVerifiedRunReport(options: BuildRunReportOptions): RunReport {
  const {
    runId,
    kpiConfig,
    agentPlan,
    provenance,
    fixturePresetId,
    resolvedModelVersion = provenance === 'LIVE_GEMINI' ? 'UNKNOWN' : 'DETERMINISTIC_FIXTURE_V15.2',
    startedAt = new Date().toISOString(),
    latencyMs = 0,
  } = options;

  const initialWorld = createInitialWorldSnapshot();
  const policyHash = computePolicyHash(agentPlan);
  const kpiHash = computeKpiHash(kpiConfig);
  const promptHash = computePromptHash(kpiConfig);

  const engineResult = executeCleanCoEngine({
    runId,
    initialWorld,
    agentPlan,
    scenarioHash: SCENARIO_HASH,
    policyHash,
  });

  const inspectorVerdict = runIndependentInspector({
    initialWorld,
    eventLog: engineResult.eventLog,
    reportedFinalWorld: engineResult.finalWorld,
    kpiConfig,
    expectedScenarioHash: SCENARIO_HASH,
    expectedPolicyHash: policyHash,
  });

  const manifest: RunManifest = {
    runId,
    scenarioId: SCENARIO_ID,
    scenarioHash: SCENARIO_HASH,
    initialStateHash: INITIAL_STATE_HASH,
    goalHash: GOAL_HASH,
    rulesHash: RULES_HASH,
    kpiHash,
    promptTemplateHash: PROMPT_TEMPLATE_HASH,
    promptHash,
    modelId: GEMINI_MODEL_ID,
    resolvedModelVersion,
    modelSettings: { ...FROZEN_MODEL_SETTINGS },
    seed: CANONICAL_SEED,
    eventScheduleHash: EVENT_SCHEDULE_HASH,
    actionBudget: { ...ACTION_BUDGET },
    policyHash,
    provenance,
    ...(fixturePresetId ? { fixturePresetId } : {}),
    startedAt,
    latencyMs,
    evaluatorVersion: EVALUATOR_VERSION,
  };

  return {
    runId,
    kpiConfig,
    manifest,
    agentPlan,
    eventLog: engineResult.eventLog,
    initialWorld,
    finalWorld: engineResult.finalWorld,
    inspector: inspectorVerdict,
  };
}
