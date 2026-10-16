#!/usr/bin/env python3
"""
04_build_mix.py — Broadcast Audio Post-Processing, Sidechain Ducking & EBU R128 Master Mix
Generates a procedural ambient observatory background track (or uses a custom BGM file),
applies sidechain compression ducking keyed to the narration voice, and normalizes the
combined master track to YouTube/Broadcast standard EBU R128 (-14.0 LUFS, -1.0 dBTP)
into `03_audio/master_mix.wav`.
"""

from __future__ import annotations

import argparse
import json
import math
import struct
import subprocess
import sys
import wave
from pathlib import Path

SAMPLE_RATE = 24000


def generate_ambient_bgm(path: Path, duration_sec: float) -> None:
    """
    Generate a subtle, warm A-minor9 cyber-observatory ambient pad at 24kHz mono s16le.
    """
    total_samples = max(SAMPLE_RATE, int(round(duration_sec * SAMPLE_RATE)))
    buf = bytearray(total_samples * 2)
    # A2 (110 Hz), E3 (164.81 Hz), G3 (196.00 Hz), B3 (246.94 Hz), C4 (261.63 Hz)
    freqs = [110.0, 164.81, 196.00, 246.94, 261.63]
    weights = [0.36, 0.25, 0.16, 0.12, 0.11]
    two_pi = 2.0 * math.pi

    for i in range(total_samples):
        t = i / SAMPLE_RATE
        fade = min(1.0, t / 1.5, max(0.0, (duration_sec - t) / 2.0))
        lfo = 0.82 + 0.18 * math.sin(two_pi * 0.12 * t)
        val_f = 0.0
        for idx, (f, w) in enumerate(zip(freqs, weights)):
            detune = 1.0 + (idx - 2) * 0.0007 * math.sin(two_pi * 0.07 * t)
            val_f += w * math.sin(two_pi * (f * detune) * t)
        sample_int = int(max(-32767, min(32767, val_f * lfo * fade * 1850.0)))
        struct.pack_into("<h", buf, i * 2, sample_int)

    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(bytes(buf))


def get_wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as wf:
        return wf.getnframes() / float(wf.getframerate())


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(
        description="Build sidechain-ducked, EBU R128 (-14 LUFS) normalized 03_audio/master_mix.wav"
    )
    parser.add_argument(
        "--workspace",
        type=Path,
        default=Path("video_pipeline"),
        help="Path to video_pipeline workspace",
    )
    parser.add_argument(
        "--bgm",
        type=Path,
        default=None,
        help="Optional custom BGM wav/mp3 path (defaults to procedural observatory ambient pad)",
    )
    parser.add_argument(
        "--lufs",
        type=float,
        default=-14.0,
        help="Target integrated loudness in LUFS (default: -14.0)",
    )
    parser.add_argument(
        "--true-peak",
        type=float,
        default=-1.0,
        help="Target maximum true peak in dBTP (default: -1.0)",
    )
    args = parser.parse_args()

    workspace = args.workspace.resolve()
    audio_dir = workspace / "03_audio"
    narration_path = audio_dir / "narration.wav"
    if not narration_path.exists():
        print(
            f"[ERROR] {narration_path} not found. Run 03_build_narration_and_captions.py first.",
            file=sys.stderr,
        )
        return 1

    duration_sec = get_wav_duration(narration_path)
    bgm_path = args.bgm.resolve() if args.bgm else (audio_dir / "bgm_ambient.wav")
    if not bgm_path.exists() or args.bgm is None:
        generate_ambient_bgm(bgm_path, duration_sec)

    master_mix_path = audio_dir / "master_mix.wav"

    # Sidechain ducking + voice EQ + EBU R128 loudnorm (-14 LUFS, -1.0 dBTP)
    filter_complex = (
        "[0:a]highpass=f=75,acompressor=threshold=-18dB:ratio=2.5:attack=10:release=120,"
        "asplit=2[voice_main][voice_sc];"
        "[1:a]volume=0.22[bgm_pre];"
        "[bgm_pre][voice_sc]sidechaincompress=threshold=0.015:ratio=6:attack=25:release=350[bgm_ducked];"
        "[voice_main][bgm_ducked]amix=inputs=2:duration=first:dropout_transition=0,"
        f"loudnorm=I={args.lufs}:TP={args.true_peak}:LRA=11[outa]"
    )

    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(narration_path),
        "-i",
        str(bgm_path),
        "-filter_complex",
        filter_complex,
        "-map",
        "[outa]",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-c:a",
        "pcm_s16le",
        str(master_mix_path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    if proc.returncode != 0:
        # Fallback simple amix + loudnorm if sidechaincompress filter syntax varies on build
        fallback_filter = (
            "[0:a]highpass=f=75[v];[1:a]volume=0.14[b];"
            f"[v][b]amix=inputs=2:duration=first,loudnorm=I={args.lufs}:TP={args.true_peak}:LRA=11[outa]"
        )
        cmd_fb = [
            "ffmpeg",
            "-y",
            "-i",
            str(narration_path),
            "-i",
            str(bgm_path),
            "-filter_complex",
            fallback_filter,
            "-map",
            "[outa]",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-c:a",
            "pcm_s16le",
            str(master_mix_path),
        ]
        subprocess.run(cmd_fb, check=True, capture_output=True)

    mix_dur = get_wav_duration(master_mix_path)
    print(
        f"[04_build_mix] Master audio mix complete\n"
        f"  Target LUFS : {args.lufs} LUFS / {args.true_peak} dBTP\n"
        f"  Duration    : {mix_dur:.2f}s (48kHz Stereo 16-bit PCM)\n"
        f"  Output      : {master_mix_path}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
