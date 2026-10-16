import React, { useEffect, useState } from 'react';
import { runAllAcceptanceTests } from '../../shared/selfTestSuite';
import type { SelfTestResultItem, SelfTestSuiteReport } from '../../shared/types';

export interface SelfTestModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const SelfTestModal: React.FC<SelfTestModalProps> = ({ isOpen, onClose }) => {
  const [suiteReport, setSuiteReport] = useState<SelfTestSuiteReport | null>(null);
  const [loading, setLoading] = useState(false);

  const executeSuite = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/selftest');
      if (res.ok) {
        const data = (await res.json()) as SelfTestSuiteReport;
        if (
          data &&
          typeof data.allPassed === 'boolean' &&
          typeof data.passedCount === 'number' &&
          typeof data.totalCount === 'number' &&
          Array.isArray(data.results)
        ) {
          setSuiteReport(data);
          setLoading(false);
          return;
        }
      }
    } catch {
      // Fallback to in-browser deterministic execution
    }
    setSuiteReport(runAllAcceptanceTests());
    setLoading(false);
  };

  useEffect(() => {
    if (isOpen && !suiteReport) {
      void executeSuite();
    }
  }, [isOpen, suiteReport]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-950/85 flex items-center justify-center p-4"
      data-testid="selftest-modal"
    >
      <div className="bg-[#111827] border border-slate-700 rounded-md w-full max-w-5xl max-h-[88vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="font-mono text-sm font-bold text-slate-100 uppercase tracking-wider">
              REV.15.2 ACCEPTANCE TEST SUITE (AT-01 — AT-21)
            </span>
            {suiteReport && (
              <>
                <span
                  data-testid="selftest-summary-badge"
                  className={`px-2 py-0.5 rounded font-mono text-xs font-bold border ${
                    suiteReport.allPassed
                      ? 'bg-emerald-950 text-emerald-300 border-emerald-500'
                      : 'bg-red-950 text-red-300 border-red-500'
                  }`}
                >
                  {suiteReport.passedCount} / {suiteReport.totalCount} PASSED
                </span>
                <span className="font-mono text-[11px] text-slate-400">
                  v{suiteReport.suiteVersion}
                </span>
              </>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void executeSuite()}
              disabled={loading}
              data-testid="btn-rerun-selftest"
              className="px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white font-mono text-xs font-semibold cursor-pointer disabled:opacity-50"
            >
              {loading ? 'RUNNING…' : 'RE-RUN ALL 21 TESTS'}
            </button>
            <button
              type="button"
              onClick={onClose}
              data-testid="btn-close-selftest"
              className="px-3 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 font-mono text-xs border border-slate-600 cursor-pointer"
            >
              CLOSE ✕
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="p-4 overflow-y-auto flex-1">
          {suiteReport ? (
            <table className="w-full text-left border-collapse font-mono text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400 text-[11px]">
                  <th className="py-2 pr-3">ID</th>
                  <th className="py-2 px-2">CATEGORY</th>
                  <th className="py-2 px-2">REQUIREMENT</th>
                  <th className="py-2 px-2">STATUS</th>
                  <th className="py-2 px-2">TIME</th>
                  <th className="py-2 pl-2">VERIFICATION EVIDENCE</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80">
                {suiteReport.results.map((item: SelfTestResultItem) => (
                  <tr
                    key={item.id}
                    data-testid={`selftest-row-${item.id}`}
                    className="hover:bg-slate-900/60"
                  >
                    <td className="py-2.5 pr-3 font-bold text-slate-200 whitespace-nowrap">
                      {item.id}
                    </td>
                    <td className="py-2.5 px-2 text-slate-400 whitespace-nowrap text-[11px]">
                      <div>{item.category}</div>
                      <div className="text-[10px] text-slate-500">{item.requirementRef}</div>
                    </td>
                    <td className="py-2.5 px-2 text-slate-200 font-semibold">
                      {item.title}
                    </td>
                    <td className="py-2.5 px-2 whitespace-nowrap">
                      {item.status === 'PASS' ? (
                        <span className="px-2 py-0.5 rounded bg-emerald-950 text-emerald-300 border border-emerald-600 text-[11px] font-bold">
                          PASS ✓
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded bg-red-950 text-red-300 border border-red-600 text-[11px] font-bold">
                          FAIL ✕
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 px-2 text-slate-400 whitespace-nowrap text-[11px]">
                      {item.durationMs.toFixed(2)}ms
                    </td>
                    <td className="py-2.5 pl-2 text-slate-300 text-[11px]">
                      {item.detail}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="py-12 text-center font-mono text-xs text-slate-400">
              Executing AT-01..AT-21 verification suite…
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
