#!/usr/bin/env python3
"""
09_archive_bundle.py — Final Provenance Manifest & Release Archiver
Generates `02_manifests/build_manifest.json` recording cryptographic SHA-256
checksums, file sizes, and build provenance across the final video (`final_v1.mp4`),
silent video stream (`video_master_silent.mp4`), audio tracks (`narration.wav`,
`master_mix.wav`), SSOT script (`대본_녹음용.md`), and all pipeline lockfiles.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def artifact_entry(path: Path, workspace: Path) -> Dict[str, Any]:
    if not path.exists():
        return {"exists": False, "path": str(path.as_posix())}
    try:
        rel = str(path.resolve().relative_to(workspace.resolve()).as_posix())
    except ValueError:
        rel = str(path.as_posix())
    return {
        "exists": True,
        "path": rel,
        "size_bytes": path.stat().st_size,
        "sha256": sha256_file(path),
    }


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(
        description="Write 02_manifests/build_manifest.json with full SHA-256 build provenance"
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
        help="Path to final video (defaults to <workspace>/final_v1.mp4)",
    )
    args = parser.parse_args()

    workspace = args.workspace.resolve()
    final_video = args.video.resolve() if args.video else (workspace / "final_v1.mp4")

    if not final_video.exists():
        print(f"[ERROR] Final video not found: {final_video}", file=sys.stderr)
        return 1

    manifests_dir = workspace / "02_manifests"
    script_manifest_path = manifests_dir / "script_manifest.json"
    timeline_path = manifests_dir / "timeline.json"

    script_manifest = (
        json.loads(script_manifest_path.read_text(encoding="utf-8"))
        if script_manifest_path.exists()
        else {}
    )
    timeline = (
        json.loads(timeline_path.read_text(encoding="utf-8"))
        if timeline_path.exists()
        else {}
    )

    build_manifest = {
        "schema_version": "2.0.0",
        "archived_at": datetime.now(timezone.utc).isoformat(),
        "title": script_manifest.get("title", "THE LOOPHOLE — CleanCo v1 (Rev.15.2)"),
        "script_hash": script_manifest.get("script_hash"),
        "total_duration_sec": timeline.get("total_duration_sec"),
        "total_frames": timeline.get("total_frames"),
        "cumulative_drift_ms": timeline.get("cumulative_drift_ms", 0.0),
        "artifacts": {
            "final_video": artifact_entry(final_video, workspace),
            "silent_video_master": artifact_entry(
                workspace / "video_master_silent.mp4", workspace
            ),
            "master_audio_mix": artifact_entry(
                workspace / "03_audio" / "master_mix.wav", workspace
            ),
            "narration_wav": artifact_entry(
                workspace / "03_audio" / "narration.wav", workspace
            ),
            "ssot_script": artifact_entry(
                workspace / "01_docs" / "대본_녹음용.md", workspace
            ),
            "script_manifest": artifact_entry(
                manifests_dir / "script_manifest.json", workspace
            ),
            "assets_lock": artifact_entry(
                manifests_dir / "assets_lock.json", workspace
            ),
            "timeline": artifact_entry(manifests_dir / "timeline.json", workspace),
            "captions": artifact_entry(manifests_dir / "captions.json", workspace),
            "captions_srt": artifact_entry(manifests_dir / "captions.srt", workspace),
            "captions_ass": artifact_entry(manifests_dir / "captions.ass", workspace),
            "qa_report": artifact_entry(manifests_dir / "qa_report.json", workspace),
        },
    }

    out_path = manifests_dir / "build_manifest.json"
    out_path.write_text(
        json.dumps(build_manifest, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    fv = build_manifest["artifacts"]["final_video"]
    print(
        f"[09_archive_bundle] Build provenance locked\n"
        f"  Final Video  : {fv['path']} ({fv['size_bytes'] / (1024*1024):.2f} MB)\n"
        f"  Video SHA256 : {fv['sha256']}\n"
        f"  Manifest     : {out_path}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
