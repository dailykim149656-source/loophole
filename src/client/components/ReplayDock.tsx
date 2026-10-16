import React from 'react';

export interface ReplayDockProps {
  activeExperiment: 'EXP_A' | 'EXP_B';
  hasRunA: boolean;
  hasRunB: boolean;
  onSwitchExperiment: (exp: 'EXP_A' | 'EXP_B') => void;
  frameIndex: number;
  maxFrame: number;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onStepBack: () => void;
  onStepForward: () => void;
  onSeek: (frame: number) => void;
  onReset: () => void;
  onFixedPlanReplay: () => void;
  is2DFallback: boolean;
  onToggle2DFallback: () => void;
  playbackSpeed?: 0.5 | 1 | 2;
  onCycleSpeed?: () => void;
}

function formatStepClock(step: number): string {
  const clamped = Math.max(0, Math.floor(step));
  return `00:${String(clamped).padStart(2, '0')}`;
}

export const ReplayDock: React.FC<ReplayDockProps> = ({
  activeExperiment,
  hasRunA,
  hasRunB,
  onSwitchExperiment,
  frameIndex,
  maxFrame,
  isPlaying,
  onTogglePlay,
  onStepBack,
  onStepForward,
  onSeek,
  onReset,
  onFixedPlanReplay,
  is2DFallback,
  onToggle2DFallback,
  playbackSpeed = 1,
  onCycleSpeed,
}) => {
  return (
    <div
      className="bg-[#0F172A] border-t border-slate-800/90 px-3.5 py-2 flex flex-wrap items-center justify-between gap-2.5 select-none"
      data-testid="replay-dock"
    >
      {/* Left + Center: Media Transport Bar matching 3D Evidence Replay screenshot */}
      <div className="flex items-center gap-2.5 flex-1 min-w-[260px]">
        <button
          type="button"
          onClick={onTogglePlay}
          disabled={maxFrame === 0}
          data-testid="btn-play-pause"
          className="w-8 h-8 rounded-full bg-slate-800 hover:bg-blue-600 text-white font-mono text-xs font-bold border border-slate-600 hover:border-blue-400 flex items-center justify-center transition-colors cursor-pointer disabled:opacity-40 shrink-0"
          title={isPlaying ? 'Pause Replay' : 'Play Replay'}
        >
          {isPlaying ? '❚❚' : '▶'}
        </button>

        <span className="font-mono text-xs text-slate-300 whitespace-nowrap tabular-nums">
          {formatStepClock(frameIndex)} / {formatStepClock(maxFrame)}
        </span>

        {/* Smooth Blue Progress / Seek Bar */}
        <div className="flex items-center flex-1 min-w-[100px] px-1">
          <input
            type="range"
            min={0}
            max={Math.max(maxFrame, 0)}
            value={frameIndex}
            onChange={(e) => onSeek(Number(e.target.value))}
            disabled={maxFrame === 0}
            data-testid="seek-slider"
            className="w-full h-1.5 rounded-lg bg-slate-800 accent-blue-500 cursor-pointer"
          />
        </div>

        <button
          type="button"
          onClick={onCycleSpeed}
          data-testid="btn-playback-speed"
          className="hidden sm:inline-block font-mono text-[11px] font-semibold tracking-wider text-slate-300 hover:text-white px-1.5 py-0.5 rounded hover:bg-slate-800/80 whitespace-nowrap cursor-pointer transition-colors"
          title="Click to cycle replay speed (0.5x / 1x / 2x)"
        >
          {playbackSpeed}x · REPLAY
        </button>

        {/* Step Back / Step Forward / Reset */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onStepBack}
            disabled={frameIndex <= 0}
            data-testid="btn-step-back"
            className="px-2 py-1 rounded bg-slate-900 hover:bg-slate-800 text-slate-300 font-mono text-xs border border-slate-700/80 cursor-pointer disabled:opacity-40"
            title="Step Back 1 Event Frame"
          >
            ◀
          </button>
          <button
            type="button"
            onClick={onStepForward}
            disabled={frameIndex >= maxFrame}
            data-testid="btn-step-forward"
            className="px-2 py-1 rounded bg-slate-900 hover:bg-slate-800 text-slate-300 font-mono text-xs border border-slate-700/80 cursor-pointer disabled:opacity-40"
            title="Step Forward 1 Event Frame"
          >
            ▶
          </button>
          <button
            type="button"
            onClick={onReset}
            disabled={maxFrame === 0 && frameIndex === 0}
            data-testid="btn-reset"
            className="px-2 py-1 rounded bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-slate-200 font-mono text-[11px] border border-slate-800 cursor-pointer disabled:opacity-40"
            title="Reset to Frame 0 (Initial World State)"
          >
            RESET
          </button>
        </div>
      </div>

      {/* Right: Run A / Run B Switcher, Fixed-Plan Replay (AT-18), 2D Grid Toggle (AT-21) */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <div className="bg-slate-950 border border-slate-800 rounded-md p-0.5 flex items-center gap-0.5">
          <button
            type="button"
            disabled={!hasRunA}
            onClick={() => onSwitchExperiment('EXP_A')}
            data-testid="toggle-exp-a"
            className={`px-2 py-0.5 rounded font-mono text-[11px] font-semibold transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
              activeExperiment === 'EXP_A'
                ? 'bg-rose-500/20 text-rose-300 border border-rose-500/60'
                : 'text-slate-400 hover:text-slate-200 border border-transparent'
            }`}
          >
            Run A · original
          </button>
          <button
            type="button"
            disabled={!hasRunB}
            onClick={() => onSwitchExperiment('EXP_B')}
            data-testid="toggle-exp-b"
            className={`px-2 py-0.5 rounded font-mono text-[11px] font-semibold transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
              activeExperiment === 'EXP_B'
                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/60'
                : 'text-slate-400 hover:text-slate-200 border border-transparent'
            }`}
          >
            Run B · revised
          </button>
        </div>

        <button
          type="button"
          onClick={onFixedPlanReplay}
          disabled={maxFrame === 0}
          data-testid="btn-fixed-plan-replay"
          className="px-2 py-1 rounded bg-slate-900 hover:bg-slate-800 text-indigo-300 font-mono text-[11px] font-semibold border border-indigo-500/50 cursor-pointer disabled:opacity-40"
          title="Re-verify existing EventLog from Frame 0 without calling Gemini API (0 API calls)"
        >
          FIXED-PLAN
        </button>

        <button
          type="button"
          onClick={onToggle2DFallback}
          data-testid="btn-toggle-2d"
          className={`px-2 py-1 rounded font-mono text-[11px] border cursor-pointer ${
            is2DFallback
              ? 'bg-amber-500 text-slate-950 font-bold border-amber-300'
              : 'bg-slate-900 text-slate-300 border-slate-700/80 hover:border-slate-500'
          }`}
          title="Toggle between 3D WebGL 2 Viewport and 2D Deterministic Fallback Grid"
        >
          {is2DFallback ? '2D ACTIVE' : '2D GRID'}
        </button>
      </div>
    </div>
  );
};
