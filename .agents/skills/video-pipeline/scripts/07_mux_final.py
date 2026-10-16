#!/usr/bin/env python3
"""
07_mux_final.py — 3-Second Lossless Audio/Video Stream Remuxer
Combines `video_master_silent.mp4` and `03_audio/master_mix.wav` without video
re-encoding (`-c:v copy -c:a aac -b:a 320k -shortest`) into `final_v1.mp4`.
Allows audio post-processing or narration updates to be remuxed in < 3 seconds.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(
        description="Losslessly remux video_master_silent.mp4 + 03_audio/master_mix.wav -> final_v1.mp4"
    )
    parser.add_argument(
        "--workspace",
        type=Path,
        default=Path("video_pipeline"),
        help="Path to video_pipeline workspace",
    )
    parser.add_argument(
        "--video",
        type=Path,
        default=None,
        help="Input silent master video (defaults to <workspace>/video_master_silent.mp4)",
    )
    parser.add_argument(
        "--audio",
        type=Path,
        default=None,
        help="Input master audio mix (defaults to <workspace>/03_audio/master_mix.wav)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Output final MP4 path (defaults to <workspace>/final_v1.mp4)",
    )
    args = parser.parse_args()

    workspace = args.workspace.resolve()
    video_in = args.video.resolve() if args.video else (workspace / "video_master_silent.mp4")
    audio_in = args.audio.resolve() if args.audio else (workspace / "03_audio" / "master_mix.wav")
    video_out = args.output.resolve() if args.output else (workspace / "final_v1.mp4")

    if not video_in.exists():
        print(f"[ERROR] Silent video master not found: {video_in}", file=sys.stderr)
        return 1
    if not audio_in.exists():
        print(f"[ERROR] Master audio mix not found: {audio_in}", file=sys.stderr)
        return 1

    video_out.parent.mkdir(parents=True, exist_ok=True)

    t0 = time.perf_counter()
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(video_in),
        "-i",
        str(audio_in),
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "320k",
        "-movflags",
        "+faststart",
        "-shortest",
        str(video_out),
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    elapsed_sec = time.perf_counter() - t0

    size_mb = video_out.stat().st_size / (1024 * 1024)
    print(
        f"[07_mux_final] Lossless stream remux complete in {elapsed_sec:.2f}s\n"
        f"  Video Stream : {video_in.name} (-c:v copy)\n"
        f"  Audio Stream : {audio_in.name} (-c:a aac -b:a 320k)\n"
        f"  Output File  : {video_out} ({size_mb:.2f} MB)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
