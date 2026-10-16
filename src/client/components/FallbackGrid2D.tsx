import React from 'react';
import type { TileId, WasteId } from '../../shared/types';
import { VALID_TILES, VALID_WASTE_IDS } from '../../shared/scenario';
import type { ProjectedFrameState, WasteVisualProjection } from '../../shared/frameProjector';

export interface FallbackGrid2DProps {
  projected: ProjectedFrameState;
  selectedWasteId: WasteId | null;
  onSelectWasteId: (wasteId: WasteId | null) => void;
  fallbackReason?: string;
  onRetry3D?: () => void;
}

export const FallbackGrid2D: React.FC<FallbackGrid2DProps> = ({
  projected,
  selectedWasteId,
  onSelectWasteId,
  fallbackReason,
  onRetry3D,
}) => {
  const activeEv = projected.activeEvent;
  const wasteList: WasteVisualProjection[] = VALID_WASTE_IDS.map((id) => projected.wastes[id]);
  const carriedWaste = projected.world.carriedWasteId
    ? projected.wastes[projected.world.carriedWasteId]
    : null;
  const disposedWastes = wasteList.filter((w) => w.status === 'DISPOSED');

  return (
    <div
      className="w-full h-full bg-[#0B0F17] p-4 flex flex-col gap-4 overflow-y-auto"
      data-testid="fallback-grid-2d"
    >
      {/* Mandatory AT-21 2D Fallback Mode Banner */}
      <div className="bg-amber-950/60 border border-amber-500/70 rounded-md px-4 py-2.5 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span
            className="px-2 py-0.5 rounded bg-amber-500 text-slate-950 font-mono text-xs font-bold tracking-wider uppercase"
            data-testid="fallback-mode-badge"
          >
            2D FALLBACK MODE (3D UNVERIFIED)
          </span>
          <span className="text-xs text-amber-200 font-mono">
            {fallbackReason ||
              'WebGL 2 context unavailable or degraded — rendering deterministic 2D state grid.'}
          </span>
        </div>
        {onRetry3D && (
          <button
            type="button"
            onClick={onRetry3D}
            className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 font-mono text-xs border border-slate-600 cursor-pointer shrink-0"
          >
            RETURN TO 3D VIEWPORT
          </button>
        )}
      </div>

      {/* Main 2D Grid + Containment Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 flex-1 min-h-0">
        {/* 4x4 Tile Grid (T01..T16) */}
        <div className="lg:col-span-7 bg-[#111827] border border-slate-800 rounded-md p-4 flex flex-col">
          <div className="flex items-center justify-between mb-3">
            <span className="font-mono text-xs font-semibold text-slate-300 uppercase tracking-wider">
              CLEANCO_V1 4×4 PUBLIC DISTRICT GRID (T01–T16)
            </span>
            <span className="font-mono text-xs text-slate-400">
              FRAME {projected.frameIndex} / {projected.totalEvents}
            </span>
          </div>

          <div className="grid grid-cols-4 gap-2.5 flex-1">
            {VALID_TILES.map((tileId: TileId) => {
              const occupant = wasteList.find(
                (w) => w.status === 'PUBLIC' && w.currentTileId === tileId
              );
              const ghostOccupants = wasteList.filter(
                (w) =>
                  w.status === 'DISPOSED' &&
                  w.lastKnownPublicTileId === tileId &&
                  (selectedWasteId === w.wasteId || w.isActiveEventTarget)
              );
              const isEventTarget = projected.highlightedTileId === tileId;
              const isWorkerHere = projected.workerTargetLocation === tileId;

              return (
                <div
                  key={tileId}
                  className={`rounded-md p-2.5 border flex flex-col justify-between transition-colors ${
                    isEventTarget
                      ? activeEv?.decision === 'BLOCK'
                        ? 'bg-red-950/40 border-red-500'
                        : 'bg-blue-950/40 border-cyan-400'
                      : occupant
                      ? 'bg-slate-900 border-slate-700'
                      : 'bg-slate-950/70 border-slate-800/80'
                  }`}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-mono text-xs font-semibold text-slate-400">
                      {tileId}
                    </span>
                    <div className="flex items-center gap-1">
                      {isWorkerHere && (
                        <span className="font-mono text-[9px] px-1 py-0.5 rounded bg-blue-900/80 text-cyan-300 border border-cyan-500/40">
                          BOT
                        </span>
                      )}
                      {isEventTarget && activeEv && (
                        <span
                          className={`font-mono text-[10px] px-1.5 py-0.5 rounded font-bold ${
                            activeEv.decision === 'BLOCK'
                              ? 'bg-red-600 text-white'
                              : 'bg-cyan-500 text-slate-950'
                          }`}
                        >
                          {activeEv.action}
                        </span>
                      )}
                    </div>
                  </div>

                  {occupant ? (
                    <button
                      type="button"
                      onClick={() =>
                        onSelectWasteId(
                          selectedWasteId === occupant.wasteId ? null : occupant.wasteId
                        )
                      }
                      className={`mt-2 w-full px-2 py-1.5 rounded font-mono text-xs font-bold flex items-center justify-between border cursor-pointer ${
                        selectedWasteId === occupant.wasteId
                          ? 'bg-amber-500 text-slate-950 border-white'
                          : 'bg-amber-950/80 text-amber-300 border-amber-600/70 hover:border-amber-400'
                      }`}
                    >
                      <span>{occupant.wasteId}</span>
                      <span className="text-[10px]">PUBLIC</span>
                    </button>
                  ) : ghostOccupants.length > 0 ? (
                    <div className="mt-2 px-2 py-1 rounded border border-dashed border-cyan-400/70 bg-cyan-950/30 font-mono text-[11px] text-cyan-300">
                      GHOST ORIGIN: {ghostOccupants.map((g) => g.wasteId).join(', ')}
                    </div>
                  ) : (
                    <div className="mt-2 font-mono text-[11px] text-slate-600">EMPTY</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Right Side: Worker Bay, Disposal Bin & W01..W08 Status Registry */}
        <div className="lg:col-span-5 flex flex-col gap-3">
          {/* AI Worker Carry Slot */}
          <div className="bg-[#111827] border border-slate-800 rounded-md p-3.5">
            <div className="flex items-center justify-between mb-2">
              <span className="font-mono text-xs font-semibold text-cyan-400 uppercase">
                AI WORKER CARRY BAY (CAPACITY: 1)
              </span>
              <span className="font-mono text-xs text-slate-400">
                CARRIED: {projected.world.carriedCount}/1 · LOC: {projected.workerTargetLocation}
              </span>
            </div>
            {carriedWaste ? (
              <button
                type="button"
                onClick={() =>
                  onSelectWasteId(
                    selectedWasteId === carriedWaste.wasteId ? null : carriedWaste.wasteId
                  )
                }
                className="w-full px-3 py-2 rounded bg-cyan-950/70 border border-cyan-500 text-cyan-200 font-mono text-xs font-bold flex items-center justify-between cursor-pointer"
              >
                <span>{carriedWaste.wasteId} · IN TRANSIT (CARRIED)</span>
                <span>LAST TILE: {carriedWaste.lastKnownPublicTileId}</span>
              </button>
            ) : (
              <div className="px-3 py-2 rounded bg-slate-900 border border-slate-800 font-mono text-xs text-slate-500">
                EMPTY — NO WASTE CURRENTLY CARRIED
              </div>
            )}
          </div>

          {/* Central Disposal Bin */}
          <div
            className={`bg-[#111827] border rounded-md p-3.5 ${
              projected.highlightDisposalBin ? 'border-emerald-400' : 'border-slate-800'
            }`}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="font-mono text-xs font-semibold text-emerald-400 uppercase">
                CENTRAL DISPOSAL BIN (PERMANENT)
              </span>
              <span className="font-mono text-xs text-slate-400">
                DISPOSED: {projected.world.disposedCount}/8
              </span>
            </div>
            {disposedWastes.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {disposedWastes.map((w) => (
                  <button
                    key={w.wasteId}
                    type="button"
                    onClick={() =>
                      onSelectWasteId(selectedWasteId === w.wasteId ? null : w.wasteId)
                    }
                    className={`px-2.5 py-1 rounded font-mono text-xs font-semibold border cursor-pointer ${
                      selectedWasteId === w.wasteId
                        ? 'bg-emerald-500 text-slate-950 border-white'
                        : 'bg-emerald-950/70 text-emerald-300 border-emerald-600/70'
                    }`}
                  >
                    {w.wasteId} (FROM {w.lastKnownPublicTileId})
                  </button>
                ))}
              </div>
            ) : (
              <div className="px-3 py-2 rounded bg-slate-900 border border-slate-800 font-mono text-xs text-slate-500">
                0 UNITS DISPOSED
              </div>
            )}
          </div>

          {/* Complete W01..W08 Registry */}
          <div className="bg-[#111827] border border-slate-800 rounded-md p-3.5 flex-1">
            <div className="flex items-center justify-between mb-2">
              <span className="font-mono text-xs font-semibold text-slate-300 uppercase">
                WASTE REGISTRY (CLICK TO FILTER TIMELINE)
              </span>
              {selectedWasteId && (
                <button
                  type="button"
                  onClick={() => onSelectWasteId(null)}
                  className="font-mono text-[11px] text-cyan-400 hover:underline cursor-pointer"
                >
                  CLEAR FILTER ({selectedWasteId})
                </button>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {VALID_WASTE_IDS.map((wId) => {
                const w = projected.wastes[wId];
                const isSel = selectedWasteId === wId;
                return (
                  <button
                    key={wId}
                    type="button"
                    onClick={() => onSelectWasteId(isSel ? null : wId)}
                    className={`px-2.5 py-1.5 rounded border font-mono text-xs flex items-center justify-between cursor-pointer ${
                      isSel
                        ? 'bg-blue-600 text-white border-white font-bold'
                        : 'bg-slate-900 text-slate-300 border-slate-800 hover:border-slate-700'
                    }`}
                    title={`${w.label} (${w.category}) · Pickups: ${w.pickupCountAtFrame}`}
                  >
                    <span>
                      {wId}
                      {w.pickupCountAtFrame > 1 ? ` (×${w.pickupCountAtFrame})` : ''}
                    </span>
                    <span
                      className={`text-[11px] ${
                        isSel
                          ? 'text-white'
                          : w.status === 'PUBLIC'
                          ? 'text-amber-400'
                          : w.status === 'CARRIED'
                          ? 'text-cyan-400'
                          : 'text-emerald-400'
                      }`}
                    >
                      {w.status === 'PUBLIC' ? `PUBLIC@${w.currentTileId}` : w.status}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
