/**
 * THE LOOPHOLE — CleanCo KPI Incentive Test Harness (Rev.15.2)
 * Frozen Normative DTO & Domain Contracts (§11.2, §11.3, §11.4, §12.3)
 */

export type ScenarioId = 'cleanco_v1';

export type TileId =
  | 'T01' | 'T02' | 'T03' | 'T04'
  | 'T05' | 'T06' | 'T07' | 'T08'
  | 'T09' | 'T10' | 'T11' | 'T12'
  | 'T13' | 'T14' | 'T15' | 'T16';

export type WasteId =
  | 'W01' | 'W02' | 'W03' | 'W04'
  | 'W05' | 'W06' | 'W07' | 'W08';

export type WasteStatus = 'PUBLIC' | 'CARRIED' | 'DISPOSED';

export type ActionType = 'PICK_UP' | 'DROP' | 'DISPOSE';

export type DecisionType = 'ACCEPT' | 'BLOCK';

export type ReasonCode =
  | 'OK_PICK_UP'
  | 'OK_DROP'
  | 'OK_DISPOSE'
  | 'INVALID_WASTE_ID'
  | 'WASTE_NOT_PUBLIC'
  | 'HANDS_FULL'
  | 'UNEXPECTED_TILE_ID'
  | 'MISSING_TILE_ID'
  | 'NOT_CARRYING_TARGET_WASTE'
  | 'INVALID_TILE_ID'
  | 'TILE_OCCUPIED'
  | 'ALREADY_DISPOSED';

export type KPIId = 'PICKUP_COUNT' | 'UNIQUE_DISPOSALS';

export type ProvenanceType = 'LIVE_GEMINI' | 'TEST_FIXTURE';

export type FixturePresetId =
  | 'EXP_A_LOOPHOLE_REPEATED_PICKUP'
  | 'EXP_B_CLEAN_3_DISPOSALS'
  | 'EXP_B_COST_OVERRUN_4_DISPOSALS'
  | 'EDGE_ILLEGAL_BLOCKS';

export type OutcomeStatus =
  | 'KPI_PASSED_GOAL_FAILED'
  | 'KPI_PASSED_GOAL_PASSED'
  | 'KPI_FAILED'
  | 'INTEGRITY_FAILURE'
  | 'MODEL_ERROR'
  | 'INSUFFICIENT_EVIDENCE';

export interface KPIConfig {
  kpiId: KPIId;
  target: number;
}

export interface KPIDefinition {
  kpiId: KPIId;
  label: string;
  shortLabel: string;
  description: string;
  rewardInstruction: string;
  minTarget: number;
  maxTarget: number;
  defaultTarget: number;
  unit: string;
}

export interface WasteItemState {
  wasteId: WasteId;
  status: WasteStatus;
  tileId: TileId | null;
  initialTileId: TileId;
  label: string;
  category: string;
}

export interface WorldSnapshot {
  wastes: Record<WasteId, WasteItemState>;
  carriedWasteId: WasteId | null;
  publicCount: number;
  carriedCount: number;
  disposedCount: number;
}

export interface AgentAction {
  type: ActionType;
  wasteId: string;
  tileId?: string;
}

export interface AgentPlan {
  schemaVersion: string;
  actions: AgentAction[];
}

export interface EventLogEntry {
  runId: string;
  eventId: string;
  step: number;
  round: number;
  action: ActionType;
  wasteId: string;
  tileId?: string;
  decision: DecisionType;
  reasonCode: ReasonCode;
  stateBefore: WorldSnapshot;
  stateAfter: WorldSnapshot;
  actionCost: number;
  scenarioHash: string;
  policyHash: string;
}

export interface CostModel {
  PICK_UP: number;
  DROP: number;
  DISPOSE: number;
  BLOCK: number;
}

export interface ActionBudget {
  maxRounds: number;
  actionsPerRound: number;
  maxTotalActions: number;
  carryCapacity: number;
}

export interface BusinessGoalSpec {
  description: string;
  minUniqueDisposals: number;
  maxTotalActionCost: number;
}

export interface CleanCoRulesSpec {
  gridRows: number;
  gridCols: number;
  validTiles: TileId[];
  validWasteIds: WasteId[];
  legalActions: ActionType[];
  preconditions: Record<ActionType, string>;
  effects: Record<ActionType, string>;
  invariants: string[];
}

export interface CleanCoSpec {
  scenarioId: ScenarioId;
  version: string;
  title: string;
  seed: number;
  initialWorld: WorldSnapshot;
  rules: CleanCoRulesSpec;
  costModel: CostModel;
  actionBudget: ActionBudget;
  eventSchedule: never[];
  businessGoal: BusinessGoalSpec;
  availableKpis: Record<KPIId, KPIDefinition>;
  hashes: {
    scenarioHash: string;
    initialStateHash: string;
    goalHash: string;
    rulesHash: string;
    eventScheduleHash: string;
    promptTemplateHash: string;
  };
}

export interface ModelSettings {
  temperature: number;
  topP: number;
  seed: number;
  thinkingLevel: 'low' | 'medium';
}

export interface PlannerAttemptRecord {
  attempt: number;
  stage: 'GEMINI_POLICY_PLANNER' | 'SCHEMA_GATE';
  status: 'PASSED' | 'FAILED';
  failureReason?: string;
  latencyMs: number;
}

export interface RunManifest {
  runId: string;
  scenarioId: ScenarioId;
  scenarioHash: string;
  initialStateHash: string;
  goalHash: string;
  rulesHash: string;
  kpiHash: string;
  promptTemplateHash: string;
  promptHash: string;
  modelId: string;
  resolvedModelVersion: string;
  modelSettings: ModelSettings;
  seed: number;
  eventScheduleHash: string;
  actionBudget: ActionBudget;
  policyHash: string;
  provenance: ProvenanceType;
  fixturePresetId?: FixturePresetId;
  startedAt: string;
  latencyMs: number;
  evaluatorVersion: string;
  plannerAttempts?: number;
  plannerRetryHistory?: PlannerAttemptRecord[];
}

export interface InspectorVerdict {
  integrityPass: boolean;
  validTransitions: boolean;
  kpiPass: boolean;
  businessGoalPass: boolean;
  conditionalLoopholeObserved: boolean;
  acceptedPickupCount: number;
  acceptedDropCount: number;
  uniquePermanentDisposals: number;
  disposedWasteIds: WasteId[];
  wasteRemaining: number;
  totalActionCost: number;
  blockedActions: number;
  hardConstraintBlocks: number;
  outcomeStatus: OutcomeStatus;
  evidenceEventIds: string[];
  integrityErrors: string[];
  summaryMessage: string;
}

export interface RunErrorDetail {
  code: 'IMPOSSIBLE_TARGET' | 'INVALID_REQUEST' | 'MODEL_ERROR' | 'MODEL_TIMEOUT' | 'INTEGRITY_FAILURE';
  httpStatus: 422 | 500 | 502 | 504;
  stage: 'FEASIBILITY_GATE' | 'GEMINI_POLICY_PLANNER' | 'SCHEMA_GATE' | 'ENGINE_EXECUTION' | 'INSPECTOR_AUDIT';
  message: string;
  traceId: string;
  retryable: boolean;
  plannerAttempts?: number;
  plannerRetryHistory?: PlannerAttemptRecord[];
}

export interface RunReport {
  runId: string;
  kpiConfig: KPIConfig;
  manifest: RunManifest;
  agentPlan: AgentPlan;
  eventLog: EventLogEntry[];
  initialWorld: WorldSnapshot;
  finalWorld: WorldSnapshot;
  inspector: InspectorVerdict;
  errors?: RunErrorDetail;
}

export interface RunRequestPayload {
  scenarioId: ScenarioId;
  kpiId: KPIId;
  target: number;
  mode?: ProvenanceType;
  fixturePresetId?: FixturePresetId;
  fixedPlanOverride?: AgentPlan;
}

export interface ComparisonEquivalenceCheck {
  comparable: boolean;
  checks: Array<{
    field: string;
    label: string;
    expAValue: string;
    expBValue: string;
    expectedRelation: 'EQUAL' | 'DIFFERENT';
    passed: boolean;
  }>;
}

export interface SelfTestResultItem {
  id: string;
  category: 'ENGINE_DOMAIN' | 'INSPECTOR_SECURITY' | 'THREE_D_PROJECTION' | 'API_HARNESS';
  title: string;
  requirementRef: string;
  status: 'PASS' | 'FAIL';
  detail: string;
  durationMs: number;
}

export interface SelfTestSuiteReport {
  suiteVersion: string;
  executedAt: string;
  allPassed: boolean;
  passedCount: number;
  totalCount: number;
  results: SelfTestResultItem[];
}
