/**
 * THE LOOPHOLE — Pure Read-Only 3D/2D Frame State Projector (§12.2, §12.3, AT-03, AT-16..AT-20)
 * Never re-executes Engine rules or computes unverified state: projects immutable WorldSnapshots
 * and verified EventLog entries for any frame 0..N.
 */

import { cloneWorldSnapshot, VALID_WASTE_IDS } from './scenario';
import type {
  EventLogEntry,
  RunReport,
  TileId,
  WasteId,
  WasteStatus,
  WorldSnapshot,
} from './types';

export interface WasteVisualProjection {
  wasteId: WasteId;
  label: string;
  category: string;
  status: WasteStatus;
  currentTileId: TileId | null;
  initialTileId: TileId;
  lastKnownPublicTileId: TileId;
  lastAcceptedEventId: string | null;
  pickupCountAtFrame: number;
  isActiveEventTarget: boolean;
}

export interface ProjectedFrameState {
  runId: string;
  frameIndex: number;
  totalEvents: number;
  world: WorldSnapshot;
  activeEvent: EventLogEntry | null;
  workerTargetLocation: TileId | 'DISPOSAL_BIN' | 'HOME_PAD';
  highlightedTileId: TileId | null;
  highlightDisposalBin: boolean;
  cumulativeAtFrame: {
    acceptedPickups: number;
    acceptedDrops: number;
    uniqueDisposals: number;
    wasteRemaining: number;
    totalActionCost: number;
    blockedAttempts: number;
  };
  wastes: Record<WasteId, WasteVisualProjection>;
}

export function getWorldSnapshotAtFrame(
  initialWorld: WorldSnapshot,
  eventLog: EventLogEntry[],
  requestedFrameIndex: number
): ProjectedFrameState {
  const totalEvents = eventLog.length;
  const clampedFrame = Math.max(0, Math.min(totalEvents, Math.floor(requestedFrameIndex)));

  const world =
    clampedFrame === 0
      ? cloneWorldSnapshot(initialWorld)
      : cloneWorldSnapshot(eventLog[clampedFrame - 1].stateAfter);

  const activeEvent = clampedFrame === 0 ? null : eventLog[clampedFrame - 1];
  const runId = eventLog[0]?.runId ?? 'initial';

  // Track historical tile/event metadata up to clampedFrame from verified EventLog
  const lastKnownTile: Record<WasteId, TileId> = {} as Record<WasteId, TileId>;
  const lastAcceptedEvent: Record<WasteId, string | null> = {} as Record<WasteId, string | null>;
  const pickupCountByWaste: Record<WasteId, number> = {} as Record<WasteId, number>;

  for (const id of VALID_WASTE_IDS) {
    lastKnownTile[id] = initialWorld.wastes[id].initialTileId;
    lastAcceptedEvent[id] = null;
    pickupCountByWaste[id] = 0;
  }

  let acceptedPickups = 0;
  let acceptedDrops = 0;
  const disposedSet = new Set<WasteId>();
  let totalActionCost = 0;
  let blockedAttempts = 0;
  let workerTargetLocation: TileId | 'DISPOSAL_BIN' | 'HOME_PAD' = 'HOME_PAD';

  for (let i = 0; i < clampedFrame; i++) {
    const ev = eventLog[i];
    const isKnownWaste = (VALID_WASTE_IDS as string[]).includes(ev.wasteId);
    if (ev.decision === 'ACCEPT' && isKnownWaste) {
      const wId = ev.wasteId as WasteId;
      lastAcceptedEvent[wId] = ev.eventId;
      totalActionCost += ev.actionCost;

      if (ev.action === 'PICK_UP') {
        acceptedPickups += 1;
        pickupCountByWaste[wId] += 1;
        const priorTile = ev.stateBefore.wastes[wId].tileId;
        if (priorTile) {
          lastKnownTile[wId] = priorTile;
          workerTargetLocation = priorTile;
        }
      } else if (ev.action === 'DROP') {
        acceptedDrops += 1;
        const newTile = ev.stateAfter.wastes[wId].tileId;
        if (newTile) {
          lastKnownTile[wId] = newTile;
          workerTargetLocation = newTile;
        }
      } else if (ev.action === 'DISPOSE') {
        disposedSet.add(wId);
        workerTargetLocation = 'DISPOSAL_BIN';
      }
    } else {
      blockedAttempts += 1;
      if (ev.tileId && ev.tileId.startsWith('T')) {
        // Keep worker position unchanged on BLOCK (scene state invariant per AT-17)
      }
    }
  }

  let highlightedTileId: TileId | null = null;
  let highlightDisposalBin = false;

  if (activeEvent) {
    const isKnownWaste = (VALID_WASTE_IDS as string[]).includes(activeEvent.wasteId);
    if (activeEvent.action === 'DISPOSE' && activeEvent.decision === 'ACCEPT') {
      highlightDisposalBin = true;
      if (isKnownWaste) {
        highlightedTileId = lastKnownTile[activeEvent.wasteId as WasteId];
      }
    } else if (activeEvent.tileId && activeEvent.tileId.startsWith('T')) {
      highlightedTileId = activeEvent.tileId as TileId;
    } else if (isKnownWaste) {
      const wId = activeEvent.wasteId as WasteId;
      highlightedTileId =
        activeEvent.stateBefore.wastes[wId].tileId ?? lastKnownTile[wId];
    }
  }

  const wastes = {} as Record<WasteId, WasteVisualProjection>;
  for (const id of VALID_WASTE_IDS) {
    const wState = world.wastes[id];
    wastes[id] = {
      wasteId: id,
      label: wState.label,
      category: wState.category,
      status: wState.status,
      currentTileId: wState.tileId,
      initialTileId: wState.initialTileId,
      lastKnownPublicTileId: lastKnownTile[id],
      lastAcceptedEventId: lastAcceptedEvent[id],
      pickupCountAtFrame: pickupCountByWaste[id],
      isActiveEventTarget: activeEvent?.wasteId === id,
    };
  }

  const uniqueDisposals = disposedSet.size;
  const wasteRemaining = 8 - uniqueDisposals;

  return {
    runId,
    frameIndex: clampedFrame,
    totalEvents,
    world,
    activeEvent,
    workerTargetLocation,
    highlightedTileId,
    highlightDisposalBin,
    cumulativeAtFrame: {
      acceptedPickups,
      acceptedDrops,
      uniqueDisposals,
      wasteRemaining,
      totalActionCost,
      blockedAttempts,
    },
    wastes,
  };
}

/**
 * Finds the 1-indexed frame corresponding to a specific eventId within a RunReport.
 * Returns null if the eventId does not belong to this run (enforcing AT-19 run isolation).
 */
export function findFrameIndexForEventId(
  report: RunReport,
  eventId: string
): number | null {
  const idx = report.eventLog.findIndex(
    (e) => e.eventId === eventId && e.runId === report.runId
  );
  return idx >= 0 ? idx + 1 : null;
}

/**
 * Filters a RunReport's EventLog by a specific WasteId (P1-1 Raycaster reverse filter, AT-19).
 */
export function filterEventLogByWasteId(
  report: RunReport,
  wasteId: WasteId | null
): EventLogEntry[] {
  if (!wasteId) return report.eventLog;
  return report.eventLog.filter(
    (e) => e.runId === report.runId && e.wasteId === wasteId
  );
}

/**
 * Builds step-by-step remaining waste series (Step 0..N) for the Line Chart (§5, §11.6).
 */
export function getStepwiseRemainingWasteSeries(
  report: RunReport
): Array<{ step: number; remaining: number; disposed: number; cost: number; actionLabel: string }> {
  const series: Array<{
    step: number;
    remaining: number;
    disposed: number;
    cost: number;
    actionLabel: string;
  }> = [
    {
      step: 0,
      remaining: 8,
      disposed: 0,
      cost: 0,
      actionLabel: 'INIT (8 PUBLIC)',
    },
  ];

  for (let frame = 1; frame <= report.eventLog.length; frame++) {
    const projected = getWorldSnapshotAtFrame(
      report.initialWorld,
      report.eventLog,
      frame
    );
    const ev = report.eventLog[frame - 1];
    series.push({
      step: frame,
      remaining: projected.cumulativeAtFrame.wasteRemaining,
      disposed: projected.cumulativeAtFrame.uniqueDisposals,
      cost: projected.cumulativeAtFrame.totalActionCost,
      actionLabel: `${ev.action}(${ev.wasteId}${ev.tileId ? `,${ev.tileId}` : ''}) [${ev.decision}]`,
    });
  }

  return series;
}
