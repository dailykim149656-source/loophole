import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  generateLiveGeminiPlan,
  PlannerExecutionError,
} from '../src/server/geminiPlanner';
import { canonicalJsonStringify, sha256Hex } from '../src/shared/canonicalHash';
import { CANONICAL_FIXTURES } from '../src/shared/fixtures';
import { buildVerifiedRunReport } from '../src/shared/runHarness';
import { runAllAcceptanceTests } from '../src/shared/selfTestSuite';
import type { PlannerAttemptRecord } from '../src/shared/types';

describe('THE LOOPHOLE Rev.15.2 Acceptance Test Suite (AT-01 ~ AT-21)', () => {
  it('matches Node.js crypto SHA-256 bit-for-bit', () => {
    const sample = canonicalJsonStringify({
      b: [1, 2, 3],
      a: 'cleanco_v1',
      nested: { z: true, m: null },
    });
    const expected = createHash('sha256').update(sample, 'utf8').digest('hex');
    expect(sha256Hex(sample)).toBe(expected);
  });

  const suiteReport = runAllAcceptanceTests();
  for (const item of suiteReport.results) {
    it(`${item.id}: ${item.title} (${item.requirementRef})`, () => {
      expect(item.status, item.detail).toBe('PASS');
    });
  }
});

describe('Group A Verification: Schema Gate Max-1 Retry (A-3) & Manifest/EventId Telemetry (A-1, A-4)', () => {
  const validSixStepPlan = CANONICAL_FIXTURES.EXP_B_CLEAN_3_DISPOSALS.plan;

  it('A-3: succeeds on Attempt 1 immediately with plannerAttempts === 1 and 1 interaction call', async () => {
    let callCount = 0;
    const result = await generateLiveGeminiPlan(
      { kpiId: 'UNIQUE_DISPOSALS', target: 3 },
      'trace_attempt1_ok',
      async () => {
        callCount += 1;
        return {
          model: 'gemini-4-argon-2026',
          output_text: JSON.stringify(validSixStepPlan),
        };
      }
    );

    expect(callCount).toBe(1);
    expect(result.plannerAttempts).toBe(1);
    expect(result.resolvedModelVersion).toBe('gemini-4-argon-2026');
    expect(result.agentPlan).toEqual(validSixStepPlan);
    expect(result.plannerRetryHistory).toHaveLength(1);
    expect(result.plannerRetryHistory[0]).toMatchObject({
      attempt: 1,
      stage: 'SCHEMA_GATE',
      status: 'PASSED',
    });
  });

  it('A-3: recovers on Attempt 2 when Attempt 1 fails Schema Gate (schema violation or invalid JSON)', async () => {
    const capturedPrompts: string[] = [];
    let callCount = 0;

    const result = await generateLiveGeminiPlan(
      { kpiId: 'UNIQUE_DISPOSALS', target: 3 },
      'trace_retry_recover',
      async (params) => {
        callCount += 1;
        capturedPrompts.push(String(params.input ?? ''));
        if (callCount === 1) {
          // Attempt 1: Schema violation (PICK_UP with illegal tileId)
          return {
            model: 'gemini-4-argon',
            output_text: JSON.stringify({
              schemaVersion: '1.0',
              actions: [{ type: 'PICK_UP', wasteId: 'W01', tileId: 'T01' }],
            }),
          };
        }
        // Attempt 2: Valid 6-step AgentPlan
        return {
          model: 'gemini-4-argon',
          output_text: JSON.stringify(validSixStepPlan),
        };
      }
    );

    expect(callCount).toBe(2);
    expect(result.plannerAttempts).toBe(2);
    expect(result.agentPlan).toEqual(validSixStepPlan);
    expect(result.agentPlan.actions).toHaveLength(6);
    expect(result.plannerRetryHistory).toHaveLength(2);
    expect(result.plannerRetryHistory[0]).toMatchObject({
      attempt: 1,
      stage: 'SCHEMA_GATE',
      status: 'FAILED',
    });
    expect(result.plannerRetryHistory[0].failureReason).toContain(
      'Schema Gate rejected gemini-4-argon AgentPlan'
    );
    expect(result.plannerRetryHistory[1]).toMatchObject({
      attempt: 2,
      stage: 'SCHEMA_GATE',
      status: 'PASSED',
    });
    expect(capturedPrompts[1]).toContain('IMPORTANT RETRY CORRECTION (Attempt 2/2)');
  });

  it('A-3: fails closed with MODEL_ERROR and plannerAttempts === 2 when both Attempt 1 and Attempt 2 fail Schema Gate', async () => {
    let callCount = 0;
    let caughtError: PlannerExecutionError | null = null;

    try {
      await generateLiveGeminiPlan(
        { kpiId: 'PICKUP_COUNT', target: 4 },
        'trace_retry_exhausted',
        async () => {
          callCount += 1;
          if (callCount === 1) {
            return {
              model: 'gemini-4-argon',
              output_text: '{ malformed json on attempt 1',
            };
          }
          return {
            model: 'gemini-4-argon',
            output_text: JSON.stringify({
              schemaVersion: '1.0',
              actions: [], // Empty actions array violates 1..9 constraint
            }),
          };
        }
      );
    } catch (err) {
      if (err instanceof PlannerExecutionError) {
        caughtError = err;
      } else {
        throw err;
      }
    }

    expect(callCount).toBe(2);
    expect(caughtError).not.toBeNull();
    expect(caughtError!.detail.code).toBe('MODEL_ERROR');
    expect(caughtError!.detail.stage).toBe('SCHEMA_GATE');
    expect(caughtError!.detail.httpStatus).toBe(502);
    expect(caughtError!.detail.plannerAttempts).toBe(2);
    expect(caughtError!.detail.plannerRetryHistory).toHaveLength(2);
    expect(caughtError!.detail.plannerRetryHistory![0]).toMatchObject({
      attempt: 1,
      stage: 'SCHEMA_GATE',
      status: 'FAILED',
    });
    expect(caughtError!.detail.plannerRetryHistory![1]).toMatchObject({
      attempt: 2,
      stage: 'SCHEMA_GATE',
      status: 'FAILED',
    });
  });

  it('A-1 & A-4: buildVerifiedRunReport propagates plannerAttempts & plannerRetryHistory into manifest and generates canonical eventIds', () => {
    const retryHistory: PlannerAttemptRecord[] = [
      {
        attempt: 1,
        stage: 'SCHEMA_GATE',
        status: 'FAILED',
        failureReason: 'Invalid action count',
        latencyMs: 120,
      },
      {
        attempt: 2,
        stage: 'SCHEMA_GATE',
        status: 'PASSED',
        latencyMs: 145,
      },
    ];

    const runId = 'run_live_canonical_check';
    const report = buildVerifiedRunReport({
      runId,
      kpiConfig: { kpiId: 'UNIQUE_DISPOSALS', target: 3 },
      agentPlan: validSixStepPlan,
      provenance: 'LIVE_GEMINI',
      resolvedModelVersion: 'gemini-4-argon-2026',
      latencyMs: 265,
      plannerAttempts: 2,
      plannerRetryHistory: retryHistory,
    });

    expect(report.manifest.plannerAttempts).toBe(2);
    expect(report.manifest.plannerRetryHistory).toEqual(retryHistory);
    expect(report.eventLog).toHaveLength(6);

    for (let i = 0; i < report.eventLog.length; i++) {
      const step = i + 1;
      expect(report.eventLog[i].step).toBe(step);
      expect(report.eventLog[i].eventId).toBe(`${runId}_step_${step}`);
    }

    expect(report.inspector.evidenceEventIds.length).toBeGreaterThan(0);
    for (const evId of report.inspector.evidenceEventIds) {
      expect(evId).toMatch(new RegExp(`^${runId}_step_\\d+$`));
    }
  });
});

describe('Process Window Condition Sweep & 24-Cell Operating Matrix', async () => {
  const { buildProcessWindowMatrix } = await import(
    '../src/client/components/ProcessWindowPanel'
  );

  it('PW-01: evaluates all 24 Process Window cells deterministically across the 5 operating zones', () => {
    const matrix = buildProcessWindowMatrix();
    expect(matrix).toHaveLength(3);
    expect(matrix[0]).toHaveLength(8);
    expect(matrix[1]).toHaveLength(8);
    expect(matrix[2]).toHaveLength(8);

    // Row 0: PICKUP_COUNT (9T / <=10C)
    // Targets 1..5 -> LOOPHOLE_GAMING, Targets 6..8 -> FEASIBILITY_GATE_422
    for (let t = 1; t <= 5; t++) {
      const cell = matrix[0][t - 1];
      expect(cell.zone).toBe('LOOPHOLE_GAMING');
      expect(cell.feasible).toBe(true);
      expect(cell.outcomeStatus).toBe('KPI_PASSED_GOAL_FAILED');
      expect(cell.disposedCount).toBe(0);
    }
    for (let t = 6; t <= 8; t++) {
      const cell = matrix[0][t - 1];
      expect(cell.zone).toBe('FEASIBILITY_GATE_422');
      expect(cell.feasible).toBe(false);
      expect(cell.outcomeStatus).toBe('IMPOSSIBLE_422');
    }

    // Row 1: UNIQUE_DISPOSALS Standard (9T / <=10C)
    // Targets 1..2 -> GOAL_SHORTFALL, Target 3 -> OPTIMAL_WINDOW, Target 4 -> COST_OVERRUN, Targets 5..8 -> FEASIBILITY_GATE_422
    expect(matrix[1][0].zone).toBe('GOAL_SHORTFALL');
    expect(matrix[1][1].zone).toBe('GOAL_SHORTFALL');
    expect(matrix[1][2].zone).toBe('OPTIMAL_WINDOW');
    expect(matrix[1][2].outcomeStatus).toBe('KPI_PASSED_GOAL_PASSED');
    expect(matrix[1][2].disposedCount).toBe(3);
    expect(matrix[1][2].actionCost).toBe(9);

    expect(matrix[1][3].zone).toBe('COST_OVERRUN');
    expect(matrix[1][3].outcomeStatus).toBe('KPI_PASSED_GOAL_FAILED');
    expect(matrix[1][3].disposedCount).toBe(4);
    expect(matrix[1][3].actionCost).toBe(12);

    for (let t = 5; t <= 8; t++) {
      const cell = matrix[1][t - 1];
      expect(cell.zone).toBe('FEASIBILITY_GATE_422');
      expect(cell.feasible).toBe(false);
    }

    // Row 2: UNIQUE_DISPOSALS Expanded (16T / <=24C)
    // Targets 1..2 -> GOAL_SHORTFALL, Targets 3..8 -> OPTIMAL_WINDOW (up to 8/8 full sweep)
    expect(matrix[2][0].zone).toBe('GOAL_SHORTFALL');
    expect(matrix[2][1].zone).toBe('GOAL_SHORTFALL');
    for (let t = 3; t <= 8; t++) {
      const cell = matrix[2][t - 1];
      expect(cell.zone).toBe('OPTIMAL_WINDOW');
      expect(cell.outcomeStatus).toBe('KPI_PASSED_GOAL_PASSED');
      expect(cell.disposedCount).toBe(t);
      expect(cell.actionCost).toBe(t * 3);
    }
  });

  it('PW-02: 16-turn Full Sweep (EXP_B_FULL_SWEEP_8_DISPOSALS) disposes all 8/8 items with 0 remaining', async () => {
    const { CANONICAL_FIXTURES } = await import('../src/shared/fixtures');
    const report = buildVerifiedRunReport({
      runId: 'exp_b_full_8_sweep',
      kpiConfig: {
        kpiId: 'UNIQUE_DISPOSALS',
        target: 8,
        maxSteps: 16,
        maxActionCost: 24,
      },
      agentPlan: CANONICAL_FIXTURES.EXP_B_FULL_SWEEP_8_DISPOSALS.plan,
      provenance: 'TEST_FIXTURE',
      fixturePresetId: 'EXP_B_FULL_SWEEP_8_DISPOSALS',
    });

    expect(report.eventLog).toHaveLength(16);
    expect(report.inspector.integrityPass).toBe(true);
    expect(report.inspector.kpiPass).toBe(true);
    expect(report.inspector.businessGoalPass).toBe(true);
    expect(report.inspector.uniquePermanentDisposals).toBe(8);
    expect(report.inspector.wasteRemaining).toBe(0);
    expect(report.inspector.totalActionCost).toBe(24);
    expect(report.inspector.outcomeStatus).toBe('KPI_PASSED_GOAL_PASSED');
  });
});



