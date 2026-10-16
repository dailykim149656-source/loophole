/**
 * THE LOOPHOLE — Procedural Web Audio Synthesizer & Gemini 3.8 TTS Briefing Engine
 * Zero external audio assets required. Uses native Web Audio API (`AudioContext`)
 * for action telemetry sounds and `/api/tts` (`gemini-3.8-flash-lite-tts`) with
 * automatic `window.speechSynthesis` fallback for Inspector voice briefings.
 */

import type { EventLogEntry, RunReport } from '../../shared/types';

let sharedAudioCtx: AudioContext | null = null;
let activeBufferSource: AudioBufferSourceNode | null = null;
let activeBriefingAbort: AbortController | null = null;
let activeStateCallback: ((speaking: boolean, source?: string) => void) | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return null;

  if (!sharedAudioCtx) {
    sharedAudioCtx = new AudioCtx();
  }
  if (sharedAudioCtx.state === 'suspended') {
    sharedAudioCtx.resume().catch(() => {
      // Ignore autoplay restriction errors until user gesture
    });
  }
  return sharedAudioCtx;
}

function playTelemetryAckBeep(ctx: AudioContext): void {
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(880, now);
  osc.frequency.exponentialRampToValueAtTime(1320, now + 0.06);
  gain.gain.setValueAtTime(0.06, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.075);
}

/**
 * Plays a procedural robotic telemetry sound corresponding to a simulation step event.
 */
export function playStepEventSound(event: EventLogEntry | null): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  const now = ctx.currentTime;

  if (!event) {
    // Subtle step-0 reset click
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(340, now);
    gain.gain.setValueAtTime(0.04, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.045);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.05);
    return;
  }

  // Hard constraint BLOCK: Dissonant sawtooth/square buzzer (160Hz + 172Hz, 180ms)
  if (event.decision === 'BLOCK') {
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();

    osc1.type = 'sawtooth';
    osc2.type = 'square';
    osc1.frequency.setValueAtTime(160, now);
    osc2.frequency.setValueAtTime(172, now);

    gain.gain.setValueAtTime(0.09, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + 0.185);
    osc2.stop(now + 0.185);
    return;
  }

  if (event.action === 'PICK_UP') {
    // PICK_UP (ACCEPT): Crisp rising dual-oscillator robotic servo chirp (440Hz -> 660Hz, 110ms)
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();

    osc1.type = 'triangle';
    osc2.type = 'sine';
    osc1.frequency.setValueAtTime(440, now);
    osc1.frequency.exponentialRampToValueAtTime(660, now + 0.11);
    osc2.frequency.setValueAtTime(880, now);
    osc2.frequency.exponentialRampToValueAtTime(1320, now + 0.11);

    gain.gain.setValueAtTime(0.08, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.115);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + 0.12);
    osc2.stop(now + 0.12);
    return;
  }

  if (event.action === 'DROP') {
    // DROP (ACCEPT): Low resonant mechanical thud + warning overtone (280Hz -> 140Hz, 130ms)
    const oscMain = ctx.createOscillator();
    const oscWarn = ctx.createOscillator();
    const gain = ctx.createGain();

    oscMain.type = 'triangle';
    oscWarn.type = 'sawtooth';
    oscMain.frequency.setValueAtTime(280, now);
    oscMain.frequency.exponentialRampToValueAtTime(140, now + 0.13);
    oscWarn.frequency.setValueAtTime(420, now);
    oscWarn.frequency.exponentialRampToValueAtTime(210, now + 0.13);

    gain.gain.setValueAtTime(0.09, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.135);

    oscMain.connect(gain);
    oscWarn.connect(gain);
    gain.connect(ctx.destination);

    oscMain.start(now);
    oscWarn.start(now);
    oscMain.stop(now + 0.14);
    oscWarn.stop(now + 0.14);
    return;
  }

  if (event.action === 'DISPOSE') {
    // DISPOSE (ACCEPT): Bright harmonic emerald triad chime (523.25Hz C5 + 659.25Hz E5 + 783.99Hz G5, 240ms)
    const freqs = [523.25, 659.25, 783.99];
    freqs.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      const startOffset = now + idx * 0.025;
      osc.frequency.setValueAtTime(freq, startOffset);
      gain.gain.setValueAtTime(0.06, startOffset);
      gain.gain.exponentialRampToValueAtTime(0.001, startOffset + 0.24);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(startOffset);
      osc.stop(startOffset + 0.25);
    });
  }
}

/**
 * Plays a distinct outcome verdict cue when a run completes.
 */
export function playVerdictSound(outcomeStatus: string): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  const now = ctx.currentTime;

  if (outcomeStatus === 'KPI_PASSED_GOAL_FAILED') {
    // Two-tone amber alert siren chirp (Loophole detected)
    const pulses = [
      { freq: 620, start: 0, dur: 0.11 },
      { freq: 440, start: 0.12, dur: 0.14 },
    ];
    for (const p of pulses) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(p.freq, now + p.start);
      gain.gain.setValueAtTime(0.07, now + p.start);
      gain.gain.exponentialRampToValueAtTime(0.001, now + p.start + p.dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + p.start);
      osc.stop(now + p.start + p.dur + 0.01);
    }
    return;
  }

  if (outcomeStatus === 'KPI_PASSED_GOAL_PASSED') {
    // Ascending major arpeggio fanfare
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const t = now + i * 0.055;
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(0.065, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.21);
    });
    return;
  }

  // INTEGRITY_FAILURE / MODEL_ERROR / KPI_FAILED: Urgent low alarm pulse
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'square';
  osc.frequency.setValueAtTime(195, now);
  osc.frequency.exponentialRampToValueAtTime(130, now + 0.22);
  gain.gain.setValueAtTime(0.075, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.23);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.24);
}

/**
 * Stops any currently playing Gemini TTS audio buffer or browser SpeechSynthesis utterance.
 */
export function stopActiveBriefing(): void {
  if (activeBriefingAbort) {
    activeBriefingAbort.abort();
    activeBriefingAbort = null;
  }

  if (activeBufferSource) {
    try {
      activeBufferSource.onended = null;
      activeBufferSource.stop();
      activeBufferSource.disconnect();
    } catch {
      // Ignore already stopped source
    }
    activeBufferSource = null;
  }

  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      // Ignore cancel errors
    }
  }

  if (activeStateCallback) {
    const cb = activeStateCallback;
    activeStateCallback = null;
    cb(false);
  }
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const cleaned = base64.replace(/^data:audio\/[a-z0-9.+-]+;base64,/i, '').trim();
  const binaryString = window.atob(cleaned);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

function speakWithBrowserFallback(
  text: string,
  onStateChange?: (speaking: boolean, source?: string) => void
): void {
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'en-US';
      utterance.rate = 1.05;
      utterance.pitch = 0.98;

      const finish = () => {
        if (activeStateCallback === onStateChange) {
          activeStateCallback = null;
        }
        onStateChange?.(false, 'WEB_SPEECH_SYNTH');
      };

      utterance.onend = finish;
      utterance.onerror = finish;

      onStateChange?.(true, 'WEB_SPEECH_SYNTH');
      window.speechSynthesis.speak(utterance);
      return;
    } catch {
      // Fall through to clean state reset
    }
  }

  if (activeStateCallback === onStateChange) {
    activeStateCallback = null;
  }
  onStateChange?.(false, 'TELEMETRY_BEEP_ONLY');
}

/**
 * Formats a concise, announcer-ready Inspector Voice Briefing from a RunReport.
 */
export function buildInspectorBriefingText(report: RunReport): string {
  const { inspector, kpiConfig } = report;
  if (inspector.outcomeStatus === 'KPI_PASSED_GOAL_FAILED') {
    return `Inspector Alert: Conditional Loophole Observed under ${kpiConfig.kpiId} target ${kpiConfig.target}. The policy achieved ${inspector.acceptedPickupCount} pickups and ${inspector.acceptedDropCount} drops at action cost ${inspector.totalActionCost}, but permanently disposed ${inspector.uniquePermanentDisposals} items, leaving ${inspector.wasteRemaining} waste items in public tiles.`;
  }
  if (inspector.outcomeStatus === 'KPI_PASSED_GOAL_PASSED') {
    return `Inspector Audit Verified: KPI and Business Goal both passed under ${kpiConfig.kpiId} target ${kpiConfig.target}. ${inspector.uniquePermanentDisposals} unique waste items permanently disposed at total cost ${inspector.totalActionCost}, closing the pickup-drop loophole.`;
  }
  return `Inspector Verdict: ${inspector.outcomeStatus.replace(/_/g, ' ')}. ${inspector.summaryMessage}`;
}

/**
 * C-1 Client Driver: Plays a short telemetry beep, requests Gemini 3.8 Flash-Lite TTS
 * (`POST /api/tts`), decodes & plays the returned audio buffer via Web Audio API,
 * or seamlessly falls back to `window.speechSynthesis` if offline or key-less.
 */
export async function speakInspectorBriefing(
  text: string,
  onStateChange?: (speaking: boolean, source?: string) => void
): Promise<void> {
  // If already speaking, stop first
  stopActiveBriefing();

  const cleanText = String(text ?? '').trim();
  if (!cleanText) {
    onStateChange?.(false);
    return;
  }

  const ctx = getAudioContext();
  if (ctx) {
    playTelemetryAckBeep(ctx);
  }

  const abortController = new AbortController();
  activeBriefingAbort = abortController;
  activeStateCallback = onStateChange ?? null;
  onStateChange?.(true, 'GEMINI_TTS_LOADING');

  try {
    const response = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: cleanText,
        voice: 'Kore',
        style: 'crisp, professional AI safety telemetry announcer',
      }),
      signal: abortController.signal,
    });

    if (abortController.signal.aborted) return;

    if (!response.ok) {
      speakWithBrowserFallback(cleanText, onStateChange);
      return;
    }

    const payload = (await response.json()) as {
      fallback?: boolean;
      audioBase64?: string;
      model?: string;
    };

    if (abortController.signal.aborted) return;

    if (!payload.fallback && payload.audioBase64 && ctx) {
      const arrayBuffer = base64ToArrayBuffer(payload.audioBase64);
      const decodedBuffer = await ctx.decodeAudioData(arrayBuffer);

      if (abortController.signal.aborted) return;

      const sourceNode = ctx.createBufferSource();
      sourceNode.buffer = decodedBuffer;
      sourceNode.connect(ctx.destination);
      activeBufferSource = sourceNode;

      onStateChange?.(true, payload.model || 'gemini-3.8-flash-lite-tts');

      sourceNode.onended = () => {
        if (activeBufferSource === sourceNode) {
          activeBufferSource = null;
        }
        if (activeStateCallback === onStateChange) {
          activeStateCallback = null;
        }
        onStateChange?.(false, payload.model || 'gemini-3.8-flash-lite-tts');
      };

      sourceNode.start(0);
      return;
    }

    speakWithBrowserFallback(cleanText, onStateChange);
  } catch {
    if (abortController.signal.aborted) return;
    speakWithBrowserFallback(cleanText, onStateChange);
  }
}
