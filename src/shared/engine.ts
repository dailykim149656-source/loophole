/**
 * THE LOOPHOLE — Deterministic CleanCo Engine (§4, §11.2, §11.3)
 * Executes a schema-validated AgentPlan against an immutable initialWorldSnapshot
 * and produces an append-only EventLog and final WorldSnapshot.
 */

import {
  cloneWorldSnapshot,
  COST_MODEL,
  VALID_TILES,
  VALID_WASTE_IDS,
} from './scenario';
import type {
  AgentPlan,
  DecisionType,
  EventLogEntry,
  ReasonCode,
  TileId,
  WasteId,
  WorldSnapshot,
} from './types';

export interface EngineExecutionInput {
  runId: string;
  initialWorld: WorldSnapshot;
  agentPlan: AgentPlan;
  scenarioHash: string;
  policyHash: string;
}

export interface EngineExecutionOutput {
  eventLog: EventLogEntry[];
  finalWorld: WorldSnapshot;
}

function isValidWasteId(id: string): id is WasteId {
  return (VALID_WASTE_IDS as string[]).includes(id);
}

function isValidTileId(id: string): id is TileId {
  return (VALID_TILES as string[]).includes(id);
}

function recomputeWorldCounts(world: WorldSnapshot): void {
  let pub = 0;
  let car = 0;
  let disp = 0;
  for (const id of VALID_WASTE_IDS) {
    const st = world.wastes[id].status;
    if (st === 'PUBLIC') pub++;
    else if (st === 'CARRIED') car++;
    else if (st === 'DISPOSED') disp++;
  }
  world.publicCount = pub;
  world.carriedCount = car;
  world.disposedCount = disp;
}

export function executeCleanCoEngine(input: EngineExecutionInput): EngineExecutionOutput {
  const { runId, initialWorld, agentPlan, scenarioHash, policyHash } = input;
  let currentWorld = cloneWorldSnapshot(initialWorld);
  const eventLog: EventLogEntry[] = [];

  const boundedActions = agentPlan.actions.slice(0, 9);

  for (let index = 0; index < boundedActions.length; index++) {
    const step = index + 1;
    const round = Math.floor(index / 3) + 1;
    const eventId = `${runId}_step_${step}`;
    const rawAction = boundedActions[index];
    const stateBefore = cloneWorldSnapshot(currentWorld);
    const nextWorld = cloneWorldSnapshot(currentWorld);

    let decision: DecisionType = 'BLOCK';
    let reasonCode: ReasonCode = 'INVALID_WASTE_ID';
    let actionCost = 0;

    if (!isValidWasteId(rawAction.wasteId)) {
      decision = 'BLOCK';
      reasonCode = 'INVALID_WASTE_ID';
    } else {
      const targetWaste = nextWorld.wastes[rawAction.wasteId];

      if (rawAction.type === 'PICK_UP') {
        if (rawAction.tileId !== undefined) {
          decision = 'BLOCK';
          reasonCode = 'UNEXPECTED_TILE_ID';
        } else if (nextWorld.carriedWasteId !== null) {
          decision = 'BLOCK';
          reasonCode = 'HANDS_FULL';
        } else if (targetWaste.status !== 'PUBLIC') {
          decision = 'BLOCK';
          reasonCode = 'WASTE_NOT_PUBLIC';
        } else {
          decision = 'ACCEPT';
          reasonCode = 'OK_PICK_UP';
          actionCost = COST_MODEL.PICK_UP;
          targetWaste.status = 'CARRIED';
          targetWaste.tileId = null;
          nextWorld.carriedWasteId = targetWaste.wasteId;
          recomputeWorldCounts(nextWorld);
        }
      } else if (rawAction.type === 'DROP') {
        if (nextWorld.carriedWasteId !== targetWaste.wasteId) {
          decision = 'BLOCK';
          reasonCode = 'NOT_CARRYING_TARGET_WASTE';
        } else if (!rawAction.tileId) {
          decision = 'BLOCK';
          reasonCode = 'MISSING_TILE_ID';
        } else if (!isValidTileId(rawAction.tileId)) {
          decision = 'BLOCK';
          reasonCode = 'INVALID_TILE_ID';
        } else {
          const tileOccupied = VALID_WASTE_IDS.some(
            (wId) =>
              nextWorld.wastes[wId].status === 'PUBLIC' &&
              nextWorld.wastes[wId].tileId === rawAction.tileId
          );
          if (tileOccupied) {
            decision = 'BLOCK';
            reasonCode = 'TILE_OCCUPIED';
          } else {
            decision = 'ACCEPT';
            reasonCode = 'OK_DROP';
            actionCost = COST_MODEL.DROP;
            targetWaste.status = 'PUBLIC';
            targetWaste.tileId = rawAction.tileId;
            nextWorld.carriedWasteId = null;
            recomputeWorldCounts(nextWorld);
          }
        }
      } else if (rawAction.type === 'DISPOSE') {
        if (rawAction.tileId !== undefined) {
          decision = 'BLOCK';
          reasonCode = 'UNEXPECTED_TILE_ID';
        } else if (targetWaste.status === 'DISPOSED') {
          decision = 'BLOCK';
          reasonCode = 'ALREADY_DISPOSED';
        } else if (nextWorld.carriedWasteId !== targetWaste.wasteId) {
          decision = 'BLOCK';
          reasonCode = 'NOT_CARRYING_TARGET_WASTE';
        } else {
          decision = 'ACCEPT';
          reasonCode = 'OK_DISPOSE';
          actionCost = COST_MODEL.DISPOSE;
          targetWaste.status = 'DISPOSED';
          targetWaste.tileId = null;
          nextWorld.carriedWasteId = null;
          recomputeWorldCounts(nextWorld);
        }
      }
    }

    const stateAfter = decision === 'ACCEPT' ? nextWorld : cloneWorldSnapshot(stateBefore);
    currentWorld = cloneWorldSnapshot(stateAfter);

    const entry: EventLogEntry = {
      runId,
      eventId,
      step,
      round,
      action: rawAction.type,
      wasteId: rawAction.wasteId,
      ...(rawAction.tileId !== undefined ? { tileId: rawAction.tileId } : {}),
      decision,
      reasonCode,
      stateBefore,
      stateAfter,
      actionCost,
      scenarioHash,
      policyHash,
    };

    eventLog.push(entry);
  }

  return {
    eventLog,
    finalWorld: currentWorld,
  };
}
