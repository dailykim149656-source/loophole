import React from 'react';
import type { RunReport } from '../../shared/types';
import { evaluateABEquivalence } from '../../shared/inspector';
import { getStepwiseRemainingWasteSeries } from '../../shared/frameProjector';

export interface OutcomeChartsProps {
  runA: RunReport | null;
  runB: RunReport | null;
}

function downloadJson(filename: string, payload: unknown): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function formatCheckValue(value: string): string {
  if (value.length > 18) {
    return `${value.slice(0, 14)}…`;
  }
  return value;
}

/**
 * "Verified Business Outcomes" card matching the reference UI screenshot:
 * - 3 side-by-side vertical bar sub-cards:
 *   1. Permanently Disposed (items · higher is better, scale 0..8)
 *   2. Trash Remaining (items · lower is better, scale 0..8)
 *   3. Total Action Cost (cost units · lower is better, scale 0..14 with <= 10 limit)
 * - Bottom "Observed in this experiment" callout box with dynamic delta summary.
 */
export const VerifiedOutcomesCard: React.FC<OutcomeChartsProps> = ({
  runA,
  runB,
}) => {
  if (!runA) {
    return (
      <div
        className="bg-[#131C2E] border border-[#1E293B] rounded-xl p-6 text-center text-xs text-slate-400"
        data-testid="verified-outcomes-card"
      >
        Run Experiment A to populate verified business outcomes.
      </div>
    );
  }

  const dispA = runA.inspector.uniquePermanentDisposals;
  const dispB = runB?.inspector.uniquePermanentDisposals ?? 0;

  const remA = runA.inspector.wasteRemaining;
  const remB = runB?.inspector.wasteRemaining ?? 0;

  const costA = runA.inspector.totalActionCost;
  const costB = runB?.inspector.totalActionCost ?? 0;

  const deltaDisposals = dispB - dispA;
  const deltaRemaining = remA - remB;
  const deltaCost = costB - costA;

  const dispSign =
    deltaDisposals >= 0 ? `+${deltaDisposals}` : `${deltaDisposals}`;
  const costSign = deltaCost >= 0 ? `+${deltaCost}` : `${deltaCost}`;

  const hasIntegrityFailure =
    !runA.inspector.integrityPass || (runB !== null && !runB.inspector.integrityPass);

  const subCards = [
    {
      id: 'disposed',
      testId: 'chart-count-metrics-panel',
      title: 'Permanently Disposed',
      subtitle: 'items · higher is better',
      valA: dispA,
      valB: runB ? dispB : null,
      maxScale: 8,
      showLimitLine: false,
    },
    {
      id: 'remaining',
      testId: 'chart-remaining-metrics-panel',
      title: 'Trash Remaining',
      subtitle: 'items · lower is better',
      valA: remA,
      valB: runB ? remB : null,
      maxScale: 8,
      showLimitLine: false,
    },
    {
      id: 'cost',
      testId: 'chart-action-cost-panel',
      title: 'Total Action Cost',
      subtitle: 'cost units · lower is better',
      valA: costA,
      valB: runB ? costB : null,
      maxScale: 14,
      showLimitLine: true,
    },
  ];

  const maxBarPx = 88;

  return (
    <div
      className="bg-[#131C2E] border border-[#1E293B] rounded-xl p-4 flex flex-col justify-between"
      data-testid="verified-outcomes-card"
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="text-[15px] font-bold text-white tracking-tight">
          Verified Business Outcomes
        </h3>
        <div className="flex items-center gap-4 text-xs text-slate-300">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-[#F87171] inline-block" />
            <span>A: Original</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-[#34D399] inline-block" />
            <span>B: Revised</span>
          </span>
        </div>
      </div>

      {/* 3 Side-by-Side Inner Sub-Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 my-3">
        {subCards.map((card) => {
          const heightA = Math.max(
            Math.round((Math.min(card.valA, card.maxScale) / card.maxScale) * maxBarPx),
            3
          );
          const heightB =
            card.valB !== null
              ? Math.max(
                  Math.round(
                    (Math.min(card.valB, card.maxScale) / card.maxScale) * maxBarPx
                  ),
                  3
                )
              : 3;

          const limitBottomPx = Math.round((10 / card.maxScale) * maxBarPx);

          return (
            <div
              key={card.id}
              data-testid={card.testId}
              className="bg-[#0F172A]/90 border border-[#1E293B] rounded-lg p-3 flex flex-col justify-between"
            >
              <div>
                <div className="text-xs font-semibold text-slate-100 leading-tight">
                  {card.title}
                </div>
                <div className="text-[11px] text-slate-400 mt-0.5">
                  {card.subtitle}
                </div>
              </div>

              {/* Vertical Bar Plot Area */}
              <div className="mt-4 pt-5 pb-1 px-2 flex flex-col">
                <div
                  className="relative flex items-end justify-center gap-7 border-b border-[#1E293B]"
                  style={{ height: `${maxBarPx + 22}px` }}
                >
                  {card.showLimitLine && (
                    <div
                      className="absolute left-0 right-0 border-t border-dashed border-slate-600/70 pointer-events-none flex justify-end"
                      style={{ bottom: `${limitBottomPx}px` }}
                      title="Business Goal Cost Guardrail (<= 10)"
                    >
                      <span className="text-[9px] font-mono text-slate-400 -mt-3.5 bg-[#0F172A]/90 px-1 rounded">
                        &lt;= 10 limit
                      </span>
                    </div>
                  )}

                  {/* Bar A (Coral #F87171) */}
                  <div className="flex flex-col items-center justify-end z-10">
                    <span className="text-sm font-bold text-white mb-1 leading-none">
                      {card.valA}
                    </span>
                    <div
                      className="w-10 rounded-t-[3px] bg-[#F87171] transition-all duration-300"
                      style={{ height: `${heightA}px` }}
                      title={`Experiment A: ${card.valA}`}
                    />
                  </div>

                  {/* Bar B (Mint #34D399) */}
                  <div className="flex flex-col items-center justify-end z-10">
                    <span className="text-sm font-bold text-white mb-1 leading-none">
                      {card.valB !== null ? card.valB : '—'}
                    </span>
                    <div
                      className={`w-10 rounded-t-[3px] bg-[#34D399] transition-all duration-300 ${
                        card.valB === null ? 'opacity-30' : ''
                      }`}
                      style={{ height: `${heightB}px` }}
                      title={
                        card.valB !== null
                          ? `Experiment B: ${card.valB}`
                          : 'Experiment B not yet run'
                      }
                    />
                  </div>
                </div>

                {/* X-Axis Labels A and B */}
                <div className="flex items-center justify-center gap-7 pt-1.5">
                  <span className="w-10 text-center text-[11px] font-medium text-slate-400">
                    A
                  </span>
                  <span className="w-10 text-center text-[11px] font-medium text-slate-400">
                    B
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Bottom Observation Box */}
      <div
        className={`bg-[#1C222B] border rounded-lg p-3.5 flex items-start gap-3 ${
          hasIntegrityFailure ? 'border-red-500/60' : 'border-amber-500/40'
        }`}
      >
        <span
          className={`text-base leading-none mt-0.5 select-none ${
            hasIntegrityFailure ? 'text-red-400' : 'text-slate-200'
          }`}
          aria-hidden="true"
        >
          ✦
        </span>
        <div className="text-xs leading-relaxed">
          <div
            className={`font-bold ${
              hasIntegrityFailure ? 'text-red-400' : 'text-amber-400'
            }`}
          >
            {hasIntegrityFailure
              ? 'Conditional Loophole / Integrity Alert'
              : 'Observed in this experiment'}
          </div>
          <p className="text-slate-300 mt-0.5">
            {hasIntegrityFailure ? (
              <>
                Independent Inspector flagged an{' '}
                <strong className="text-white font-semibold">
                  INTEGRITY_FAILURE
                </strong>{' '}
                on the active EventLog trace. Inspect or restore the un-tampered
                log before drawing conclusions.
              </>
            ) : runB ? (
              <>
                Changing the KPI coincided with{' '}
                <strong className="text-white font-semibold">
                  {dispSign} unique disposals
                </strong>{' '}
                and{' '}
                <strong className="text-white font-semibold">
                  {deltaRemaining >= 0
                    ? `${deltaRemaining} fewer items remaining`
                    : `${Math.abs(deltaRemaining)} more items remaining`}
                </strong>
                , at{' '}
                <strong className="text-white font-semibold">
                  {costSign} action cost
                </strong>
                . Inspect the exact action trace before drawing conclusions.
              </>
            ) : (
              <>
                Experiment A reached{' '}
                <strong className="text-white font-semibold">
                  {runA.inspector.acceptedPickupCount} pickups
                </strong>{' '}
                with{' '}
                <strong className="text-white font-semibold">
                  {dispA} unique disposals
                </strong>{' '}
                and{' '}
                <strong className="text-white font-semibold">
                  {remA} items remaining
                </strong>
                , at{' '}
                <strong className="text-white font-semibold">
                  {costA} action cost
                </strong>
                . Run Experiment B to compare patched KPI outcomes.
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );
};

/**
 * "Waste Remaining by Simulation Step" card matching the reference UI screenshot:
 * - Clean SVG line chart with Step 0..6 (or 0..maxStep) on X-axis and 0, 2, 4, 6, 8 on Y-axis
 * - Coral line + dots + end label for Experiment A (pickup KPI)
 * - Mint green line + dots + subtle gradient area + end label for Experiment B (disposal KPI)
 */
export const StepwiseWasteChartCard: React.FC<OutcomeChartsProps> = ({
  runA,
  runB,
}) => {
  if (!runA) {
    return (
      <div className="bg-[#131C2E] border border-[#1E293B] rounded-xl p-6 text-center text-xs text-slate-400">
        Run Experiment A to plot stepwise waste remaining.
      </div>
    );
  }

  const seriesA = getStepwiseRemainingWasteSeries(runA);
  const seriesB = runB ? getStepwiseRemainingWasteSeries(runB) : [];

  const maxStepA = seriesA[seriesA.length - 1]?.step ?? 0;
  const maxStepB = seriesB[seriesB.length - 1]?.step ?? 0;

  // Match screenshot's 0..6 step window when A has 7 steps and B has 6 steps (or before B runs)
  const isCanonicalWindow = maxStepA === 7 && (maxStepB === 6 || maxStepB === 0);
  const displayMaxStep = isCanonicalWindow
    ? 6
    : Math.max(maxStepB > 0 ? maxStepB : maxStepA, 6);

  const plottedA = seriesA.filter((p) => p.step <= displayMaxStep);
  const plottedB = seriesB.filter((p) => p.step <= displayMaxStep);

  const svgW = 560;
  const svgH = 190;
  const padL = 42;
  const padR = 26;
  const padT = 20;
  const padB = 34;
  const plotW = svgW - padL - padR;
  const plotH = svgH - padT - padB;

  const toX = (step: number) =>
    padL + (step / Math.max(displayMaxStep, 1)) * plotW;
  const toY = (remaining: number) => padT + ((8 - remaining) / 8) * plotH;

  const pointsA = plottedA
    .map((p) => `${toX(p.step)},${toY(p.remaining)}`)
    .join(' ');
  const pointsB = plottedB
    .map((p) => `${toX(p.step)},${toY(p.remaining)}`)
    .join(' ');

  const areaPointsB =
    plottedB.length > 1
      ? `${toX(plottedB[0].step)},${toY(8)} ${pointsB} ${toX(
          plottedB[plottedB.length - 1].step
        )},${toY(0)} ${toX(plottedB[0].step)},${toY(0)}`
      : '';

  const lastA = plottedA[plottedA.length - 1];
  const lastB = plottedB[plottedB.length - 1];

  return (
    <div
      className="bg-[#131C2E] border border-[#1E293B] rounded-xl p-4 flex flex-col justify-between"
      data-testid="stepwise-waste-card"
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="text-[15px] font-bold text-white tracking-tight">
          Waste Remaining by Simulation Step
        </h3>
        <span className="text-xs text-slate-400">
          Both experiments start at 8 items
        </span>
      </div>

      {/* Sub-legend */}
      <div className="flex items-center gap-5 mt-1.5 mb-2 text-xs text-slate-300">
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-[#F87171] inline-block" />
          <span>Experiment A (pickup KPI)</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-[#34D399] inline-block" />
          <span>Experiment B (disposal KPI)</span>
        </span>
      </div>

      {/* SVG Line Chart */}
      <svg
        viewBox={`0 0 ${svgW} ${svgH}`}
        className="w-full h-44 select-none"
        data-testid="stepwise-waste-svg"
      >
        <defs>
          <linearGradient id="stepwiseMintGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#34D399" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#34D399" stopOpacity="0.0" />
          </linearGradient>
        </defs>

        {/* Horizontal grid lines for 0, 2, 4, 6, 8 */}
        {[0, 2, 4, 6, 8].map((val) => {
          const y = toY(val);
          return (
            <g key={`h-${val}`}>
              <line
                x1={padL}
                y1={y}
                x2={svgW - padR}
                y2={y}
                stroke="#1E293B"
                strokeWidth="1"
              />
              <text
                x={padL - 10}
                y={y + 4}
                textAnchor="end"
                fill="#94A3B8"
                fontSize="11"
              >
                {val}
              </text>
            </g>
          );
        })}

        {/* Vertical dashed grid lines and X-axis step labels */}
        {Array.from({ length: displayMaxStep + 1 }, (_, step) => {
          const x = toX(step);
          return (
            <g key={`v-${step}`}>
              <line
                x1={x}
                y1={padT}
                x2={x}
                y2={svgH - padB}
                stroke="#1E293B"
                strokeWidth="1"
                strokeDasharray="3 3"
              />
              <text
                x={x}
                y={svgH - padB + 18}
                textAnchor="middle"
                fill="#94A3B8"
                fontSize="11"
              >
                {step}
              </text>
            </g>
          );
        })}

        {/* Subtle gradient area under Experiment B */}
        {runB && areaPointsB && (
          <polygon points={areaPointsB} fill="url(#stepwiseMintGrad)" />
        )}

        {/* Experiment A Polyline + Dots + End Label */}
        {pointsA && (
          <polyline
            fill="none"
            stroke="#F87171"
            strokeWidth="2.5"
            points={pointsA}
          />
        )}
        {plottedA.map((p) => (
          <circle
            key={`a-${p.step}`}
            cx={toX(p.step)}
            cy={toY(p.remaining)}
            r="4"
            fill="#F87171"
          >
            <title>{`EXP_A Step ${p.step}: ${p.remaining} remaining, ${p.disposed} disposed, cost ${p.cost} (${p.actionLabel})`}</title>
          </circle>
        ))}
        {lastA && (
          <text
            x={toX(lastA.step) - 8}
            y={toY(lastA.remaining) - 7}
            textAnchor="end"
            fill="#FCA5A5"
            fontSize="11"
            fontWeight="700"
          >
            {lastA.remaining}
          </text>
        )}

        {/* Experiment B Polyline + Dots + End Label */}
        {runB && pointsB && (
          <polyline
            fill="none"
            stroke="#34D399"
            strokeWidth="2.5"
            points={pointsB}
          />
        )}
        {runB &&
          plottedB.map((p) => (
            <circle
              key={`b-${p.step}`}
              cx={toX(p.step)}
              cy={toY(p.remaining)}
              r="4"
              fill="#34D399"
            >
              <title>{`EXP_B Step ${p.step}: ${p.remaining} remaining, ${p.disposed} disposed, cost ${p.cost} (${p.actionLabel})`}</title>
            </circle>
          ))}
        {runB && lastB && (
          <text
            x={toX(lastB.step) - 8}
            y={toY(lastB.remaining) + 15}
            textAnchor="end"
            fill="#6EE7B7"
            fontSize="11"
            fontWeight="700"
          >
            {lastB.remaining}
          </text>
        )}
      </svg>

      {/* Bottom Caption */}
      <div className="text-center text-[11px] text-slate-400 mt-0.5">
        Accepted action steps (0–{displayMaxStep} shown
        {maxStepA > displayMaxStep
          ? `; A has ${maxStepA - displayMaxStep === 1 ? 'one' : maxStepA - displayMaxStep} additional pickup action${maxStepA - displayMaxStep === 1 ? '' : 's'}`
          : ''}
        )
      </div>
    </div>
  );
};

/**
 * Full OutcomeCharts view (renders VerifiedOutcomesCard + StepwiseWasteChartCard +
 * A/B Cryptographic Equivalence Proof Matrix + JSON Export controls).
 */
export const OutcomeCharts: React.FC<OutcomeChartsProps> = ({ runA, runB }) => {
  if (!runA) {
    return (
      <div className="bg-[#131C2E] border border-[#1E293B] rounded-xl p-6 text-center font-mono text-xs text-slate-400">
        RUN EXPERIMENT A FIRST TO POPULATE OUTCOME ANALYTICS &amp; EXPORT ARTIFACTS.
      </div>
    );
  }

  const abProof = runB ? evaluateABEquivalence(runA, runB) : null;

  const pendingCheckRows = [
    {
      field: 'scenarioHash',
      label: 'Scenario Hash (Excl. KPI)',
      expAValue: runA.manifest.scenarioHash,
      expectedRelation: 'EQUAL' as const,
    },
    {
      field: 'initialStateHash',
      label: 'Initial World State Hash',
      expAValue: runA.manifest.initialStateHash,
      expectedRelation: 'EQUAL' as const,
    },
    {
      field: 'goalHash',
      label: 'Fixed Business Goal Hash',
      expAValue: runA.manifest.goalHash,
      expectedRelation: 'EQUAL' as const,
    },
    {
      field: 'rulesHash',
      label: 'Rules & Cost Model Hash',
      expAValue: runA.manifest.rulesHash,
      expectedRelation: 'EQUAL' as const,
    },
    {
      field: 'promptTemplateHash',
      label: 'System Prompt Template Hash',
      expAValue: runA.manifest.promptTemplateHash,
      expectedRelation: 'EQUAL' as const,
    },
    {
      field: 'seed',
      label: 'Canonical Seed',
      expAValue: String(runA.manifest.seed),
      expectedRelation: 'EQUAL' as const,
    },
    {
      field: 'modelId',
      label: 'Agent Model ID',
      expAValue: runA.manifest.modelId,
      expectedRelation: 'EQUAL' as const,
    },
    {
      field: 'kpiHash',
      label: 'Active KPI Config Hash',
      expAValue: runA.manifest.kpiHash,
      expectedRelation: 'DIFFERENT' as const,
    },
    {
      field: 'promptHash',
      label: 'Rendered Prompt Hash',
      expAValue: runA.manifest.promptHash,
      expectedRelation: 'DIFFERENT' as const,
    },
  ];

  const failedChecks = abProof ? abProof.checks.filter((c) => !c.passed) : [];

  return (
    <div className="flex flex-col gap-4" data-testid="outcome-charts-panel">
      {/* 1. Verified Business Outcomes Card */}
      <VerifiedOutcomesCard runA={runA} runB={runB} />

      {/* 2. Stepwise Waste Remaining Chart Card */}
      <StepwiseWasteChartCard runA={runA} runB={runB} />

      {/* 3. Hash Equivalence Proof Matrix (AT-05) */}
      <div className="bg-[#131C2E] border border-[#1E293B] rounded-xl p-4">
        <div className="flex items-center justify-between mb-2.5 flex-wrap gap-2">
          <span className="font-mono text-xs font-bold tracking-wider text-slate-200 uppercase">
            A/B CRYPTOGRAPHIC EQUIVALENCE PROOF MATRIX
          </span>
          {abProof ? (
            <span
              data-testid="ab-equivalence-badge"
              className={`px-2 py-0.5 rounded font-mono text-[11px] font-bold border ${
                abProof.comparable
                  ? 'bg-emerald-950 text-emerald-300 border-emerald-600'
                  : 'bg-red-950 text-red-300 border-red-600'
              }`}
            >
              {abProof.comparable
                ? 'VALID A/B ISOLATION (ONLY KPI PATCHED)'
                : 'INVALID A/B COMPARISON BLOCKED'}
            </span>
          ) : (
            <span className="px-2 py-0.5 rounded bg-slate-900 text-slate-400 border border-slate-700 font-mono text-[11px]">
              AWAITING EXPERIMENT B RUN
            </span>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse font-mono text-xs">
            <thead>
              <tr className="border-b border-[#1E293B] text-slate-400 text-[11px]">
                <th className="py-1.5 pr-2">INVARIANT / VARIABLE</th>
                <th className="py-1.5 px-2 text-[#F87171]">EXP_A (ORIGINAL)</th>
                <th className="py-1.5 px-2 text-[#34D399]">EXP_B (REVISED)</th>
                <th className="py-1.5 pl-2 text-right">VERIFICATION</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1E293B]/70">
              {(abProof
                ? abProof.checks
                : pendingCheckRows.map((r) => ({
                    ...r,
                    expBValue: '—',
                    passed: false,
                  }))
              ).map((chk) => {
                const isDiffVar = chk.expectedRelation === 'DIFFERENT';
                return (
                  <tr key={chk.field}>
                    <td className="py-1.5 pr-2 text-slate-300">{chk.label}</td>
                    <td
                      className={`py-1.5 px-2 truncate max-w-[130px] ${
                        isDiffVar ? 'text-[#FCA5A5]' : 'text-slate-300'
                      }`}
                      title={chk.expAValue}
                    >
                      {formatCheckValue(chk.expAValue)}
                    </td>
                    <td
                      className={`py-1.5 px-2 truncate max-w-[130px] ${
                        isDiffVar ? 'text-[#6EE7B7]' : 'text-slate-300'
                      }`}
                      title={chk.expBValue}
                    >
                      {runB ? formatCheckValue(chk.expBValue) : '—'}
                    </td>
                    <td className="py-1.5 pl-2 text-right whitespace-nowrap">
                      {runB ? (
                        chk.passed ? (
                          isDiffVar ? (
                            <span className="text-cyan-400 font-bold">PATCH DIFF ✓</span>
                          ) : (
                            <span className="text-[#34D399] font-bold">IDENTICAL ✓</span>
                          )
                        ) : isDiffVar ? (
                          <span className="text-amber-400 font-bold">UNCHANGED !</span>
                        ) : (
                          <span className="text-red-400 font-bold">MISMATCH ✕</span>
                        )
                      ) : (
                        <span className="text-slate-500">PENDING</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              <tr>
                <td className="py-1.5 pr-2 text-slate-300">Active KPI Rule</td>
                <td className="py-1.5 px-2 text-[#FCA5A5]">
                  {runA.kpiConfig.kpiId} &gt;= {runA.kpiConfig.target}
                </td>
                <td className="py-1.5 px-2 text-[#6EE7B7]">
                  {runB ? `${runB.kpiConfig.kpiId} >= ${runB.kpiConfig.target}` : '—'}
                </td>
                <td className="py-1.5 pl-2 text-right text-slate-400">
                  INDEPENDENT VAR
                </td>
              </tr>
              <tr>
                <td className="py-1.5 pr-2 text-slate-300">Run Provenance</td>
                <td className="py-1.5 px-2 text-slate-300">
                  {runA.manifest.provenance}
                </td>
                <td className="py-1.5 px-2 text-slate-300">
                  {runB ? runB.manifest.provenance : '—'}
                </td>
                <td className="py-1.5 pl-2 text-right text-slate-400">
                  {runB
                    ? runA.manifest.provenance === runB.manifest.provenance
                      ? 'MATCHED'
                      : 'MIXED MODE'
                    : 'PENDING'}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        {abProof && !abProof.comparable && (
          <div className="mt-2.5 p-2 rounded bg-red-950/80 border border-red-500 font-mono text-xs text-red-200">
            CRITICAL: A/B equivalence check failed (
            {!runA.inspector.integrityPass || !runB?.inspector.integrityPass
              ? 'Inspector integrityPass is false on one or both runs'
              : `Failed checks: ${failedChecks.map((c) => c.field).join(', ')}`}
            ).
          </div>
        )}
      </div>

      {/* 4. JSON Artifact Export Controls */}
      <div className="bg-[#131C2E] border border-[#1E293B] rounded-xl p-4 flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-xs font-semibold text-slate-300 uppercase">
          EXPORT VERIFICATION ARTIFACTS (NORMATIVE JSON):
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => downloadJson(`loophole-exp-a-${runA.runId}.json`, runA)}
            data-testid="btn-export-exp-a"
            className="px-2.5 py-1 rounded bg-[#0F172A] hover:bg-slate-800 text-[#FCA5A5] font-mono text-xs border border-[#F87171]/50 cursor-pointer"
          >
            EXPORT EXP_A JSON
          </button>
          {runB && (
            <button
              type="button"
              onClick={() => downloadJson(`loophole-exp-b-${runB.runId}.json`, runB)}
              data-testid="btn-export-exp-b"
              className="px-2.5 py-1 rounded bg-[#0F172A] hover:bg-slate-800 text-[#6EE7B7] font-mono text-xs border border-[#34D399]/50 cursor-pointer"
            >
              EXPORT EXP_B JSON
            </button>
          )}
          {runB && (
            <button
              type="button"
              onClick={() =>
                downloadJson(`loophole-ab-comparison.json`, {
                  exportedAt: new Date().toISOString(),
                  equivalenceProof: abProof,
                  experimentA: runA,
                  experimentB: runB,
                })
              }
              data-testid="btn-export-bundle"
              className="px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white font-mono text-xs font-bold border border-blue-400 cursor-pointer"
            >
              EXPORT FULL A/B PROOF BUNDLE
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
