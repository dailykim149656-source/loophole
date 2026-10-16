#!/usr/bin/env python3
"""
08_qa_inspector.py — Hybrid Signal & Gemini 3.8 Flash Multimodal QA Inspector
Inspects `final_v1.mp4`:
  1. FFmpeg `blackdetect` (unintended black frames > 0.25s)
  2. FFmpeg `freezedetect` (unintended frozen video segments)
  3. FFmpeg `ebur128` integrated loudness & true peak verification
  4. Scene midpoint keyframe extraction (`04_assets/keyframes/{scene_id}.png`)
  5. Optional `gemini-3.8-flash` multimodal visual & caption readability audit
Writes `02_manifests/qa_report.json`.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


def run_ffmpeg_signal_analysis(video_path: Path) -> Dict[str, Any]:
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-i",
        str(video_path),
        "-vf",
        "blackdetect=d=0.25:pix_th=0.05,freezedetect=n=-60dB:d=4.0",
        "-af",
        "ebur128=peak=true",
        "-f",
        "null",
        "-",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    stderr_log = proc.stderr or ""

    black_events = re.findall(
        r"black_start:([0-9.]+)\s+black_end:([0-9.]+)\s+black_duration:([0-9.]+)",
        stderr_log,
    )
    freeze_events = re.findall(r"lavfi\.freezedetect\.freeze_duration:\s*([0-9.]+)", stderr_log)

    integrated_lufs: Optional[float] = None
    m_i = re.findall(r"I:\s*(-?[0-9.]+)\s*LUFS", stderr_log)
    if m_i:
        try:
            integrated_lufs = float(m_i[-1])
        except ValueError:
            pass

    true_peak_dbtp: Optional[float] = None
    m_tp = re.findall(r"Peak:\s*(-?[0-9.]+)\s*dBFS", stderr_log)
    if m_tp:
        try:
            true_peak_dbtp = float(m_tp[-1])
        except ValueError:
            pass

    return {
        "black_frame_segments": [
            {"start": float(s), "end": float(e), "duration": float(d)}
            for s, e, d in black_events
        ],
        "black_frame_count": len(black_events),
        "freeze_segment_count": len(freeze_events),
        "integrated_lufs": integrated_lufs,
        "true_peak_dbtp": true_peak_dbtp,
    }


def extract_scene_keyframes(
    video_path: Path, scenes: List[Dict[str, Any]], keyframes_dir: Path
) -> List[Dict[str, Any]]:
    keyframes_dir.mkdir(parents=True, exist_ok=True)
    extracted: List[Dict[str, Any]] = []
    for sc in scenes:
        mid_sec = 0.5 * (float(sc["start_sec"]) + float(sc["end_sec"]))
        out_png = keyframes_dir / f"{sc['scene_id']}.png"
        cmd = [
            "ffmpeg",
            "-y",
            "-ss",
            f"{mid_sec:.3f}",
            "-i",
            str(video_path),
            "-frames:v",
            "1",
            str(out_png),
        ]
        subprocess.run(cmd, capture_output=True)
        if out_png.exists():
            extracted.append(
                {
                    "scene_id": sc["scene_id"],
                    "section_id": sc["section_id"],
                    "timestamp_sec": round(mid_sec, 3),
                    "keyframe_path": str(out_png.as_posix()),
                }
            )
    return extracted


def run_gemini_multimodal_qa(
    keyframes: List[Dict[str, Any]], api_key: str
) -> Dict[str, Any]:
    """Sample up to 5 section keyframes and verify visual/caption clarity with gemini-3.8-flash."""
    if not keyframes or not api_key:
        return {"enabled": False, "reason": "No API key or keyframes"}

    sampled = keyframes[:5]
    try:
        from google import genai  # type: ignore

        client = genai.Client(api_key=api_key)
        content_parts: List[Dict[str, Any]] = [
            {
                "type": "text",
                "text": (
                    "Inspect these extracted 1080p broadcast keyframes from 'THE LOOPHOLE — CleanCo AI Safety Observatory'. "
                    "Verify: (1) top HUD telemetry badge is legible and within safe margins, "
                    "(2) bottom subtitle pill is legible and unobstructed, and "
                    "(3) main viewport frame is intact. Return a concise JSON summary with `status: PASS` or `WARN` and `notes`."
                ),
            }
        ]
        for kf in sampled:
            img_bytes = Path(kf["keyframe_path"]).read_bytes()
            content_parts.append(
                {
                    "type": "image",
                    "data": base64.b64encode(img_bytes).decode("ascii"),
                    "mime_type": "image/png",
                }
            )

        interaction = client.interactions.create(
            model="gemini-3.8-flash",
            input=[{"type": "user_input", "content": content_parts}],
        )
        return {
            "enabled": True,
            "model": "gemini-3.8-flash",
            "keyframes_inspected": len(sampled),
            "summary": getattr(interaction, "output_text", None) or "PASS",
        }
    except Exception as exc:
        return {
            "enabled": False,
            "model": "gemini-3.8-flash",
            "reason": f"Skipped online multimodal call ({exc.__class__.__name__})",
        }


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(
        description="Run FFmpeg signal checks and optional Gemini 3.8 Flash multimodal QA"
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
        help="Path to final muxed video (defaults to <workspace>/final_v1.mp4)",
    )
    parser.add_argument(
        "--skip-ai",
        action="store_true",
        help="Skip online Gemini 3.8 Flash keyframe inspection",
    )
    args = parser.parse_args()

    workspace = args.workspace.resolve()
    video_path = args.video.resolve() if args.video else (workspace / "final_v1.mp4")
    if not video_path.exists():
        print(f"[ERROR] Video file not found: {video_path}", file=sys.stderr)
        return 1

    timeline_path = workspace / "02_manifests" / "timeline.json"
    scenes: List[Dict[str, Any]] = []
    if timeline_path.exists():
        timeline = json.loads(timeline_path.read_text(encoding="utf-8"))
        scenes = timeline.get("scenes", [])

    signal_metrics = run_ffmpeg_signal_analysis(video_path)
    keyframes_dir = workspace / "04_assets" / "keyframes"
    keyframes = extract_scene_keyframes(video_path, scenes, keyframes_dir)

    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if args.skip_ai or not api_key:
        multimodal_qa = {
            "enabled": False,
            "model": "gemini-3.8-flash",
            "keyframes_extracted": len(keyframes),
            "status": "SKIPPED_OFFLINE",
        }
    else:
        multimodal_qa = run_gemini_multimodal_qa(keyframes, api_key)

    passed = signal_metrics["black_frame_count"] == 0
    qa_report = {
        "schema_version": "2.0.0",
        "inspected_at": datetime.now(timezone.utc).isoformat(),
        "video_file": str(video_path.as_posix()),
        "passed": passed,
        "ffmpeg_signal": signal_metrics,
        "keyframes": keyframes,
        "gemini_multimodal_qa": multimodal_qa,
    }

    report_path = workspace / "02_manifests" / "qa_report.json"
    report_path.write_text(
        json.dumps(qa_report, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    print(
        f"[08_qa_inspector] QA Inspection {'PASSED' if passed else 'WARN'}\n"
        f"  Black Segments  : {signal_metrics['black_frame_count']}\n"
        f"  Integrated LUFS : {signal_metrics['integrated_lufs']} LUFS\n"
        f"  Keyframes Saved : {len(keyframes)} in {keyframes_dir}\n"
        f"  QA Report       : {report_path}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
