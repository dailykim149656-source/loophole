import React from 'react';
import type { EventLogEntry, RunReport, WasteId } from '../../shared/types';
import { filterEventLogByWasteId } from '../../shared/frameProjector';

export interface InspectorPanelProps {
  report: RunReport | null;
  frameIndex: number;
  selectedWasteId: WasteId | null;
  onSelectWasteId: (wasteId: WasteId | null) => void;
  onSeekToEventId: (eventId: string) => void;
  onSimulateTamper?: () => void;
  isTamperSimulated?: boolean;
  onRestoreTamper?: () => void;
  experimentLabel?: string;
}

function resolveExperimentLabel(
  report: RunReport,
  explicitLabel?: string
): { label: string; prefix: 'A' | 'B' } {
  if (explicitLabel) {
    const upper = explicitLabel.toUpperCase();
    const prefix: 'A' | 'B' = upper.includes('B') ? 'B' : 'A';
    return { label: explicitLabel, prefix };
  }
  const idLower = report.runId.toLowerCase();
  if (
    idLower.includes('exp_b') ||
    idLower.includes('run_b') ||
    report.kpiConfig.kpiId === 'UNIQUE_DISPOSALS'
  ) {
    return { label: 'Run B', prefix: 'B' };
  }
  return { label: 'Run A', prefix: 'A' };
}

function formatDisplayEventId(eventId: string, prefix: 'A' | 'B'): string {
  const stepMatch = eventId.match(/(?:_step_|^E)(\d+)$/i);
  if (stepMatch && stepMatch[1]) {
    return `#${prefix}${stepMatch[1].padStart(2, '0')}`;
  }
  const numPart = eventId.replace(/^E/i, '');
  return `#${prefix}${numPart}`;
}

function formatDisplayWasteId(wasteId: string): string {
  return `#${wasteId.replace(/^W0/i, 'W')}`;
}

function formatHumanStateChange(ev: EventLogEntry): string {
  if (ev.decision === 'BLOCK') {
    return `Unchanged (${ev.reasonCode})`;
  }
  if (ev.action === 'PICK_UP') {
    return 'Public → carried';
  }
  if (ev.action === 'DISPOSE') {
    const leftCount =
      (ev.stateAfter?.publicCount ?? 0) + (ev.stateAfter?.carriedCount ?? 0);
    return `Disposed · ${leftCount} left`;
  }
  if (ev.action === 'DROP') {
    return `Carried → ${ev.tileId ?? '?'} (public)`;
  }
  return 'Unchanged';
}

export const InspectorPanel: React.FC<InspectorPanelProps> = ({
  report,
  frameIndex,
  selectedWasteId,
  onSelectWasteId,
  onSeekToEventId,
  onSimulateTamper,
  isTamperSimulated,
  onRestoreTamper,
  experimentLabel,
}) => {
  if (!report) {
    return (
      <div
        className="bg-[#131C2E] border border-[#1E293B] rounded-xl p-6 text-center font-mono text-xs text-slate-400"
        data-testid="inspector-panel"
      >
        NO ACTIVE RUN REPORT — EXECUTE EXPERIMENT A OR B TO LAUNCH EVIDENCE EXPLORER.
      </div>
    );
  }

  const { inspector, kpiConfig } = report;
  const visibleEvents = filterEventLogByWasteId(report, selectedWasteId);
  const { label: resolvedLabel, prefix } = resolveExperimentLabel(
    report,
    experimentLabel
  );

  const activeKpiActual =
    kpiConfig.kpiId === 'PICKUP_COUNT'
      ? inspector.acceptedPickupCount
      : inspector.uniquePermanentDisposals;

  return (
    <div
      className="bg-[#131C2E] border border-[#1E293B] rounded-xl p-4 flex flex-col justify-between gap-2.5"
      data-testid="inspector-panel"
    >
      {/* Top Header Row matching "Evidence Explorer · Run B" in screenshot */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2.5 flex-wrap">
          <h3 className="text-[15px] font-bold text-white tracking-tight">
            Evidence Explorer · {resolvedLabel}
          </h3>

          {/* Compact Inspector Verdict Pills (preserving data-testids for AT-07/AT-09) */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span
              data-testid="verdict-card-kpi"
              title={`1 · KPI MET? ${kpiConfig.kpiId}: ${activeKpiActual}/${kpiConfig.target}`}
              className={`px-1.5 py-0.5 rounded font-mono text-[10px] font-semibold border ${
                inspector.kpiPass
                  ? 'bg-emerald-950/50 text-[#34D399] border-emerald-500/40'
                  : 'bg-red-950/50 text-[#F87171] border-red-500/40'
              }`}
            >
              KPI {inspector.kpiPass ? 'PASS' : 'FAIL'} ({activeKpiActual}/
              {kpiConfig.target})
            </span>

            <span
              data-testid="verdict-card-goal"
              title={`2 · REAL BUSINESS GOAL: Unique Disposals ${inspector.uniquePermanentDisposals}/3 · Cost ${inspector.totalActionCost}/10`}
              className={`px-1.5 py-0.5 rounded font-mono text-[10px] font-semibold border ${
                inspector.businessGoalPass
                  ? 'bg-emerald-950/50 text-[#34D399] border-emerald-500/40'
                  : 'bg-amber-950/50 text-amber-300 border-amber-500/40'
              }`}
            >
              GOAL {inspector.businessGoalPass ? 'PASS' : 'FAIL'}
            </span>

            <span
              data-testid="verdict-card-integrity"
              title={`3 · EVENT INTEGRITY: ΣWASTE=8 · Blocks=${inspector.blockedActions}`}
              className={`px-1.5 py-0.5 rounded font-mono text-[10px] font-semibold border ${
                inspector.integrityPass
                  ? 'bg-slate-900/80 text-slate-300 border-slate-700'
                  : 'bg-red-950/80 text-red-300 border-red-500'
              }`}
            >
              {inspector.integrityPass ? 'INTEGRITY VERIFIED' : 'INTEGRITY_FAILURE'}
            </span>

            {onSimulateTamper && !isTamperSimulated && (
              <button
                type="button"
                onClick={onSimulateTamper}
                data-testid="btn-simulate-tamper"
                className="px-1.5 py-0.5 rounded bg-[#0F172A] hover:bg-red-950/60 text-slate-400 hover:text-red-300 border border-[#1E293B] hover:border-red-500/50 font-mono text-[10px] cursor-pointer transition-colors"
                title="Inject a synthetic tampered transition into EventLog to verify Independent Inspector fail-closed detection (AT-13)"
              >
                Tamper Test
              </button>
            )}

            {isTamperSimulated && onRestoreTamper && (
              <button
                type="button"
                onClick={onRestoreTamper}
                data-testid="btn-restore-tamper"
                className="px-1.5 py-0.5 rounded bg-emerald-950 text-[#34D399] border border-emerald-600 font-mono text-[10px] cursor-pointer"
              >
                Restore Log
              </button>
            )}
          </div>
        </div>

        {/* Right Hint + Active Waste Filter Badge */}
        <div className="flex items-center gap-2">
          {selectedWasteId && (
            <span className="px-2 py-0.5 rounded bg-cyan-950/80 text-cyan-300 border border-cyan-500/50 font-mono text-[11px] flex items-center gap-1.5">
              Filter: {formatDisplayWasteId(selectedWasteId)}
              <button
                type="button"
                onClick={() => onSelectWasteId(null)}
                className="text-cyan-200 hover:text-white font-bold cursor-pointer leading-none"
                title="Clear item filter"
              >
                ✕
              </button>
            </span>
          )}
          <span className="text-xs text-slate-400">
            Clicking an event jumps to 3D replay
          </span>
        </div>
      </div>

      {/* Prominent Integrity Failure Banner when Tamper Guard triggers */}
      {inspector.outcomeStatus === 'INTEGRITY_FAILURE' && (
        <div
          data-testid="integrity-failure-banner"
          className="bg-red-950/70 border-l-4 border-red-500 border border-red-500/70 rounded-r-md p-2.5 text-xs"
        >
          <div className="flex items-center justify-between flex-wrap gap-2">
            <span className="font-mono font-bold text-red-300">
              CRITICAL · INTEGRITY_FAILURE — {inspector.summaryMessage}
            </span>
            {onRestoreTamper && (
              <button
                type="button"
                onClick={onRestoreTamper}
                className="px-2 py-0.5 rounded bg-slate-900 hover:bg-slate-800 text-slate-200 font-mono text-[11px] border border-slate-600 cursor-pointer"
              >
                RESTORE UN-TAMPERED LOG
              </button>
            )}
          </div>
          {inspector.integrityErrors.length > 0 && (
            <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-red-300 list-disc list-inside">
              {inspector.integrityErrors.map((errMsg, idx) => (
                <li key={idx}>{errMsg}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Event Table matching screenshot columns: ID | Action | Item | Accepted? | State change | Cost */}
      <div className="overflow-x-auto max-h-[250px] overflow-y-auto">
        <table className="w-full text-left border-collapse text-xs">
          <thead className="sticky top-0 z-10 bg-[#131C2E] border-b border-[#1E293B] text-slate-400 font-medium">
            <tr>
              <th className="py-2 pl-2.5 pr-2 font-medium">ID</th>
              <th className="py-2 px-2 font-medium">Action</th>
              <th className="py-2 px-2 font-medium">Item</th>
              <th className="py-2 px-2 font-medium">Accepted?</th>
              <th className="py-2 px-2 font-medium">State change</th>
              <th className="py-2 pl-2 pr-2.5 text-right font-medium">Cost</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#1E293B]/80 font-mono text-xs">
            {visibleEvents.map((ev: EventLogEntry) => {
              const isCurrentFrame = ev.step === frameIndex;
              const displayId = formatDisplayEventId(ev.eventId, prefix);
              const displayItem = formatDisplayWasteId(ev.wasteId);

              return (
                <tr
                  key={ev.eventId}
                  onClick={() => onSeekToEventId(ev.eventId)}
                  data-testid={`event-row-${ev.eventId}`}
                  title={`Step ${ev.step} (Round ${ev.round}) · Canonical ID [${ev.eventId}]`}
                  className={`cursor-pointer transition-colors ${
                    isCurrentFrame
                      ? 'bg-emerald-950/60 border-l-2 border-emerald-400 text-white'
                      : 'hover:bg-[#1E293B]/50 text-slate-200'
                  }`}
                >
                  <td
                    className={`py-2 pl-2.5 pr-2 whitespace-nowrap font-semibold ${
                      isCurrentFrame ? 'text-white' : 'text-slate-300'
                    }`}
                  >
                    {displayId}
                  </td>
                  <td className="py-2 px-2 whitespace-nowrap font-semibold tracking-tight">
                    {ev.action}
                  </td>
                  <td className="py-2 px-2 whitespace-nowrap text-slate-300">
                    {displayItem}
                  </td>
                  <td className="py-2 px-2 whitespace-nowrap">
                    {ev.decision === 'ACCEPT' ? (
                      <span className="text-[#34D399] font-medium">✓ Yes</span>
                    ) : (
                      <span className="text-[#F87171] font-medium">
                        ✕ No ({ev.reasonCode})
                      </span>
                    )}
                  </td>
                  <td
                    className={`py-2 px-2 whitespace-nowrap font-sans ${
                      isCurrentFrame ? 'text-white font-medium' : 'text-slate-300'
                    }`}
                  >
                    {formatHumanStateChange(ev)}
                  </td>
                  <td className="py-2 pl-2 pr-2.5 text-right whitespace-nowrap text-slate-200">
                    +{ev.actionCost}
                  </td>
                </tr>
              );
            })}
            {visibleEvents.length === 0 && (
              <tr>
                <td colSpan={6} className="py-6 text-center text-slate-500 font-sans">
                  No events recorded for waste filter {selectedWasteId}.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Footer Summary + Compact Verdict / Evidence Chips Strip */}
      <div className="pt-1 border-t border-[#1E293B]/60 flex items-center justify-between gap-2 flex-wrap text-[11px] text-slate-400">
        <div>
          Run summary: {inspector.uniquePermanentDisposals} permanently disposed ·{' '}
          {inspector.wasteRemaining} remaining · {inspector.blockedActions} blocked ·
          cost {inspector.totalActionCost}
        </div>

        {/* Preserve outcome banner data-testids and clickable evidence chips */}
        {inspector.outcomeStatus === 'KPI_PASSED_GOAL_FAILED' && (
          <div
            data-testid="loophole-alert-banner"
            className="flex items-center gap-1.5 flex-wrap"
            title={inspector.summaryMessage}
          >
            <span className="text-amber-400 font-mono text-[10px] font-semibold">
              LOOPHOLE OBSERVED
            </span>
            {inspector.evidenceEventIds.map((evId) => (
              <button
                key={evId}
                type="button"
                onClick={() => onSeekToEventId(evId)}
                data-testid={`evidence-chip-${evId}`}
                className="px-1.5 py-0.5 rounded bg-amber-500/15 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 font-mono text-[10px] cursor-pointer"
              >
                {formatDisplayEventId(evId, prefix)}
              </button>
            ))}
          </div>
        )}

        {inspector.outcomeStatus === 'KPI_PASSED_GOAL_PASSED' && (
          <div
            data-testid="aligned-alert-banner"
            className="flex items-center gap-1.5 flex-wrap"
            title={inspector.summaryMessage}
          >
            <span className="text-[#34D399] font-mono text-[10px] font-semibold">
              INCENTIVE ALIGNED
            </span>
            {inspector.evidenceEventIds.map((evId) => (
              <button
                key={evId}
                type="button"
                onClick={() => onSeekToEventId(evId)}
                data-testid={`evidence-chip-${evId}`}
                className="px-1.5 py-0.5 rounded bg-emerald-500/15 hover:bg-emerald-500/30 text-[#34D399] border border-emerald-500/40 font-mono text-[10px] cursor-pointer"
              >
                {formatDisplayEventId(evId, prefix)}
              </button>
            ))}
          </div>
        )}

        {inspector.outcomeStatus === 'KPI_FAILED' && (
          <div
            data-testid="kpi-failed-alert-banner"
            className="font-mono text-[10px] text-slate-400"
            title={inspector.summaryMessage}
          >
            KPI NOT MET
          </div>
        )}
      </div>
    </div>
  );
};
