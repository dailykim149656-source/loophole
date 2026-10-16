#!/usr/bin/env python3
"""
02_sync_assets.py — Deterministic Asset Verification & Lockfile Generator
Verifies that all video recordings (.mp4/.webm/.mkv) and still images (.png/.jpg)
referenced in `02_manifests/script_manifest.json` exist on disk, inspects their
resolution/duration/codec via `ffprobe` (with PIL/binary header fallback),
computes SHA-256 checksums, and writes `02_manifests/assets_lock.json`.
Fails fast (exit code 1) if any required asset is missing.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def probe_media(path: Path) -> Dict[str, Any]:
    """Inspect media resolution, duration, and codec via ffprobe with PIL fallback."""
    info: Dict[str, Any] = {
        "width": 0,
        "height": 0,
        "duration_sec": None,
        "codec": "unknown",
        "fps": None,
        "size_bytes": path.stat().st_size,
    }
    try:
        cmd = [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height,codec_name,r_frame_rate,duration:format=duration",
            "-of",
            "json",
            str(path),
        ]
        proc = subprocess.run(
            cmd, capture_output=True, text=True, encoding="utf-8", timeout=15
        )
        if proc.returncode == 0 and proc.stdout.strip():
            data = json.loads(proc.stdout)
            streams = data.get("streams") or []
            if streams:
                st = streams[0]
                info["width"] = int(st.get("width") or 0)
                info["height"] = int(st.get("height") or 0)
                info["codec"] = st.get("codec_name") or "unknown"
                r_fps = st.get("r_frame_rate")
                if r_fps and "/" in r_fps:
                    num, den = r_fps.split("/", 1)
                    if float(den) > 0:
                        info["fps"] = round(float(num) / float(den), 3)
                if st.get("duration") not in (None, "N/A"):
                    info["duration_sec"] = round(float(st["duration"]), 3)
            fmt = data.get("format") or {}
            if info["duration_sec"] is None and fmt.get("duration") not in (None, "N/A"):
                info["duration_sec"] = round(float(fmt["duration"]), 3)
    except Exception:
        pass

    if info["width"] == 0 or info["height"] == 0:
        try:
            from PIL import Image

            with Image.open(path) as im:
                info["width"], info["height"] = im.size
                info["codec"] = (im.format or "image").lower()
        except Exception:
            pass

    return info


def synthesize_placeholder_asset(
    target_path: Path, scene: Dict[str, Any], max_trim_end: float = 95.0
) -> None:
    """Create a 1920x1080 diagnostic slate image or video for dry-run testing."""
    target_path.parent.mkdir(parents=True, exist_ok=True)
    ext = target_path.suffix.lower()

    if ext in {".mp4", ".webm", ".mkv", ".mov"}:
        dur = max(15.0, max_trim_end + 2.0)
        cmd = [
            "ffmpeg",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"color=c=0x0b1020:s=1920x1080:r=30:d={dur:.2f}",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            str(target_path),
        ]
        subprocess.run(cmd, check=True, capture_output=True)
    else:
        from PIL import Image, ImageDraw

        img = Image.new("RGB", (1920, 1080), (11, 16, 32))
        draw = ImageDraw.Draw(img)
        draw.rectangle([60, 60, 1860, 1020], outline=(34, 211, 238), width=3)
        draw.text(
            (120, 140),
            f"THE LOOPHOLE // {scene['scene_id']} // {scene['title']}",
            fill=(240, 246, 252),
        )
        if scene.get("hud"):
            draw.text((120, 200), str(scene["hud"]), fill=(34, 211, 238))
        img.save(target_path)


def resolve_asset_path(workspace: Path, rel_path: str) -> Path:
    cand1 = workspace / "04_assets" / rel_path
    if cand1.exists():
        return cand1
    cand2 = workspace / rel_path
    if cand2.exists():
        return cand2
    return cand1


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(
        description="Verify all video/image assets and produce 02_manifests/assets_lock.json"
    )
    parser.add_argument(
        "--workspace",
        type=Path,
        default=Path("video_pipeline"),
        help="Path to video_pipeline workspace",
    )
    parser.add_argument(
        "--generate-placeholders",
        action="store_true",
        help="Synthesize diagnostic 1920x1080 assets if any referenced files are missing",
    )
    args = parser.parse_args()

    workspace = args.workspace.resolve()
    manifest_path = workspace / "02_manifests" / "script_manifest.json"
    if not manifest_path.exists():
        print(
            f"[ERROR] script_manifest.json not found at {manifest_path}. Run 01_compile_script.py first.",
            file=sys.stderr,
        )
        return 1

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    # Find maximum trim_end per asset path in case a single video recording is shared across scenes
    max_trim_by_path: Dict[str, float] = {}
    for sec in manifest.get("sections", []):
        for sc in sec.get("scenes", []):
            asset = sc.get("asset", {})
            p = asset.get("path", "")
            t_end = asset.get("trim_end_sec")
            if t_end is not None:
                max_trim_by_path[p] = max(max_trim_by_path.get(p, 0.0), float(t_end))

    scene_bindings: List[Dict[str, Any]] = []
    missing_assets: List[Dict[str, Any]] = []
    file_cache: Dict[str, Dict[str, Any]] = {}
    referenced_abs_paths = set()

    for sec in manifest.get("sections", []):
        for sc in sec.get("scenes", []):
            asset = sc.get("asset", {})
            rel_path = asset.get("path", "")
            resolved = resolve_asset_path(workspace, rel_path)

            if not resolved.exists() and args.generate_placeholders:
                print(f"[PLACEHOLDER] Generating diagnostic asset for {rel_path}...")
                synthesize_placeholder_asset(
                    resolved, sc, max_trim_end=max_trim_by_path.get(rel_path, 95.0)
                )

            if not resolved.exists():
                missing_assets.append(
                    {
                        "scene_id": sc["scene_id"],
                        "section_id": sec["section_id"],
                        "declared_path": rel_path,
                        "expected_location": str(resolved.as_posix()),
                    }
                )
                continue

            abs_key = str(resolved.resolve().as_posix())
            referenced_abs_paths.add(abs_key)

            if abs_key not in file_cache:
                media_meta = probe_media(resolved)
                media_meta["sha256"] = sha256_file(resolved)
                media_meta["resolved_path"] = abs_key
                file_cache[abs_key] = media_meta

            meta = file_cache[abs_key]
            trim_start = asset.get("trim_start_sec")
            trim_end = asset.get("trim_end_sec")
            trim_valid = True
            trim_note = "ok"

            if trim_start is not None and trim_end is not None:
                if trim_end <= trim_start:
                    trim_valid = False
                    trim_note = f"Invalid trim range [{trim_start}, {trim_end}]"
                elif (
                    meta["duration_sec"] is not None
                    and trim_start >= meta["duration_sec"]
                ):
                    trim_note = (
                        f"trim_start ({trim_start}s) exceeds source duration "
                        f"({meta['duration_sec']}s); renderer will clamp to last frame"
                    )

            scene_bindings.append(
                {
                    "scene_id": sc["scene_id"],
                    "section_id": sec["section_id"],
                    "declared_path": rel_path,
                    "resolved_path": abs_key,
                    "asset_type": asset.get("type", "image"),
                    "trim_start_sec": trim_start,
                    "trim_end_sec": trim_end,
                    "trim_valid": trim_valid,
                    "trim_note": trim_note,
                    "width": meta["width"],
                    "height": meta["height"],
                    "duration_sec": meta["duration_sec"],
                    "codec": meta["codec"],
                    "fps": meta["fps"],
                    "size_bytes": meta["size_bytes"],
                    "sha256": meta["sha256"],
                }
            )

    # Scan for orphan files in 04_assets/scenes
    orphan_files: List[str] = []
    scenes_dir = workspace / "04_assets" / "scenes"
    if scenes_dir.exists():
        for f in sorted(scenes_dir.rglob("*")):
            if f.is_file() and not f.name.startswith("."):
                f_abs = str(f.resolve().as_posix())
                if f_abs not in referenced_abs_paths:
                    orphan_files.append(f_abs)

    status = "LOCKED" if not missing_assets else "MISSING_ASSETS"
    lock_payload = {
        "schema_version": "2.0.0",
        "locked_at": datetime.now(timezone.utc).isoformat(),
        "script_hash": manifest.get("script_hash"),
        "status": status,
        "summary": {
            "total_scene_slots": len(scene_bindings) + len(missing_assets),
            "verified_slots": len(scene_bindings),
            "unique_files": len(file_cache),
            "missing_count": len(missing_assets),
            "orphan_count": len(orphan_files),
        },
        "scene_bindings": scene_bindings,
        "missing_assets": missing_assets,
        "orphan_files": orphan_files,
    }

    lock_path = workspace / "02_manifests" / "assets_lock.json"
    lock_path.write_text(
        json.dumps(lock_payload, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    if missing_assets:
        print(
            f"[02_sync_assets] FAILED — {len(missing_assets)} required asset(s) missing:",
            file=sys.stderr,
        )
        for m in missing_assets:
            print(
                f"  - [{m['scene_id']}] {m['declared_path']} (expected: {m['expected_location']})",
                file=sys.stderr,
            )
        print(
            "Tip: Place your recorded video in `video_pipeline/04_assets/scenes/` or run `01_compile_script.py --bind-video <path>`.",
            file=sys.stderr,
        )
        return 1

    print(
        f"[02_sync_assets] LOCKED — {len(scene_bindings)} scene slots verified across {len(file_cache)} unique file(s).\n"
        f"  Orphan files : {len(orphan_files)}\n"
        f"  Lockfile     : {lock_path}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
