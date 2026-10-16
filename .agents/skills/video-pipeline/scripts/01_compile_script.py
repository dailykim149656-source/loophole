#!/usr/bin/env python3
"""
01_compile_script.py — Declarative SSOT Script Compiler
Parses `01_docs/대본_녹음용.md` into `02_manifests/script_manifest.json` with
per-utterance, per-scene, and per-section SHA-256 content hashes, asset slots
(supporting both recorded video clips with [trimStart, trimEnd] timestamps and
still images), and motion presets.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

VIDEO_EXTENSIONS = {".mp4", ".webm", ".mkv", ".mov", ".avi"}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
VALID_MOTIONS = {
    "zoom_in_slow",
    "zoom_in",
    "zoom_out",
    "pan_right",
    "pan_left",
    "static",
}


def sha256_str(payload: str) -> str:
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def parse_timestamp_to_seconds(ts: str) -> float:
    """Parse 'HH:MM:SS.mmm', 'MM:SS.mmm', or 'SS.mmm' into float seconds."""
    ts = ts.strip().rstrip("sS")
    parts = ts.split(":")
    if len(parts) == 3:
        return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
    if len(parts) == 2:
        return int(parts[0]) * 60 + float(parts[1])
    return float(parts[0])


def parse_asset_directive(raw_value: str) -> Tuple[str, str, Optional[float], Optional[float]]:
    """
    Parse `@asset: scenes/recording.mp4 [00:00.000-00:14.500]` or `@asset: scenes/hero.png`.
    Returns (asset_rel_path, asset_type, trim_start_sec, trim_end_sec).
    """
    raw_value = raw_value.strip()
    trim_match = re.search(r"\[([^\[\]-]+)-([^\[\]-]+)\]\s*$", raw_value)
    trim_start: Optional[float] = None
    trim_end: Optional[float] = None

    if trim_match:
        trim_start = round(parse_timestamp_to_seconds(trim_match.group(1)), 3)
        trim_end = round(parse_timestamp_to_seconds(trim_match.group(2)), 3)
        asset_path = raw_value[: trim_match.start()].strip()
    else:
        asset_path = raw_value

    asset_path = asset_path.replace("\\", "/")
    ext = Path(asset_path).suffix.lower()
    if ext in VIDEO_EXTENSIONS or trim_start is not None:
        asset_type = "video"
    elif ext in IMAGE_EXTENSIONS:
        asset_type = "image"
    else:
        asset_type = "video" if ext else "image"

    return asset_path, asset_type, trim_start, trim_end


def parse_utterance_attrs(attr_str: str, defaults: Dict[str, str]) -> Dict[str, str]:
    """Parse `(speaker=Narrator, voice=Kore, style="calm, analytical")`."""
    result = dict(defaults)
    if not attr_str:
        return result
    pattern = re.compile(r'(\w+)\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([^,\s\)]+))')
    for match in pattern.finditer(attr_str):
        key = match.group(1).strip().lower()
        val = (
            match.group(2)
            if match.group(2) is not None
            else (match.group(3) if match.group(3) is not None else match.group(4))
        )
        if val is not None:
            result[key] = val.strip()
    return result


def compile_markdown_script(
    script_path: Path,
    bind_video_rel: Optional[str] = None,
) -> Dict[str, Any]:
    raw_text = script_path.read_text(encoding="utf-8")
    raw_script_hash = sha256_str(raw_text)

    title = "THE LOOPHOLE — CleanCo AI Safety Observatory"
    global_meta: Dict[str, Any] = {
        "fps": 30,
        "width": 1920,
        "height": 1080,
        "default_speaker": "Narrator",
        "default_voice": "Kore",
        "default_style": "confident, clear, analytical technical documentary narrator",
    }

    sections: List[Dict[str, Any]] = []
    current_section: Optional[Dict[str, Any]] = None
    current_scene: Optional[Dict[str, Any]] = None

    section_re = re.compile(r"^##\s+\[(S\d+)\]\s+(.+)$")
    scene_re = re.compile(r"^###\s+\[(S\d+_SC\d+)\]\s+(.+)$")
    directive_re = re.compile(r"^\s*-\s*@(\w+)\s*:\s*(.+)$")
    utterance_re = re.compile(
        r"^\s*-\s*\[(U\d+)\]\s*(?:\(([^)]*)\))?\s*(.+)$"
    )

    for line_no, raw_line in enumerate(raw_text.splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith("<!--"):
            continue

        if line.startswith("# ") and not line.startswith("## "):
            title = line[2:].strip()
            continue

        sec_m = section_re.match(line)
        if sec_m:
            current_scene = None
            current_section = {
                "section_id": sec_m.group(1).strip(),
                "title": sec_m.group(2).strip(),
                "scenes": [],
            }
            sections.append(current_section)
            continue

        sc_m = scene_re.match(line)
        if sc_m:
            if current_section is None:
                raise ValueError(f"Line {line_no}: Scene {sc_m.group(1)} declared before any ## [Sxx] section.")
            current_scene = {
                "scene_id": sc_m.group(1).strip(),
                "section_id": current_section["section_id"],
                "title": sc_m.group(2).strip(),
                "asset": {
                    "path": f"scenes/{sc_m.group(1).strip()}.png",
                    "type": "image",
                    "trim_start_sec": None,
                    "trim_end_sec": None,
                },
                "motion": "zoom_in_slow",
                "hud": "",
                "utterances": [],
            }
            current_section["scenes"].append(current_scene)
            continue

        dir_m = directive_re.match(line)
        if dir_m:
            key = dir_m.group(1).strip().lower()
            val = dir_m.group(2).strip()
            if current_scene is None:
                # Global metadata directive
                if key == "fps":
                    global_meta["fps"] = int(val)
                elif key == "resolution" and "x" in val.lower():
                    w_str, h_str = val.lower().split("x", 1)
                    global_meta["width"] = int(w_str.strip())
                    global_meta["height"] = int(h_str.strip())
                elif key in ("default_voice", "voice"):
                    global_meta["default_voice"] = val
                elif key in ("default_speaker", "speaker"):
                    global_meta["default_speaker"] = val
                elif key in ("default_style", "style"):
                    global_meta["default_style"] = val
            else:
                if key == "asset":
                    asset_path, asset_type, t_start, t_end = parse_asset_directive(val)
                    if bind_video_rel and (
                        asset_type == "video" or "master_recording" in asset_path
                    ):
                        asset_path = bind_video_rel
                        asset_type = "video"
                    current_scene["asset"] = {
                        "path": asset_path,
                        "type": asset_type,
                        "trim_start_sec": t_start,
                        "trim_end_sec": t_end,
                    }
                elif key == "motion":
                    motion_val = val.lower().strip()
                    current_scene["motion"] = (
                        motion_val if motion_val in VALID_MOTIONS else "zoom_in_slow"
                    )
                elif key == "hud":
                    current_scene["hud"] = val
            continue

        utt_m = utterance_re.match(line)
        if utt_m:
            if current_scene is None or current_section is None:
                raise ValueError(
                    f"Line {line_no}: Utterance [{utt_m.group(1)}] must be inside a ### [Sxx_SCxx] scene."
                )
            utt_id = utt_m.group(1).strip()
            attr_str = utt_m.group(2) or ""
            utt_text = utt_m.group(3).strip()
            if (utt_text.startswith('"') and utt_text.endswith('"')) or (
                utt_text.startswith("“") and utt_text.endswith("”")
            ):
                utt_text = utt_text[1:-1].strip()

            attrs = parse_utterance_attrs(
                attr_str,
                {
                    "speaker": global_meta["default_speaker"],
                    "voice": global_meta["default_voice"],
                    "style": global_meta["default_style"],
                },
            )
            utt_hash = sha256_str(
                f"{utt_id}|{attrs['speaker']}|{attrs['voice']}|{attrs['style']}|{utt_text}"
            )
            current_scene["utterances"].append(
                {
                    "utterance_id": utt_id,
                    "section_id": current_section["section_id"],
                    "scene_id": current_scene["scene_id"],
                    "speaker": attrs["speaker"],
                    "voice": attrs["voice"],
                    "style": attrs["style"],
                    "text": utt_text,
                    "utterance_hash": utt_hash,
                }
            )

    # Compute scene and section SHA-256 hashes
    total_scenes = 0
    total_utterances = 0
    for sec in sections:
        scene_hashes: List[str] = []
        for sc in sec["scenes"]:
            total_scenes += 1
            total_utterances += len(sc["utterances"])
            asset = sc["asset"]
            utt_hashes = ",".join(u["utterance_hash"] for u in sc["utterances"])
            sc_payload = (
                f"{sc['scene_id']}|{sc['title']}|{asset['path']}|{asset['type']}|"
                f"{asset['trim_start_sec']}|{asset['trim_end_sec']}|"
                f"{sc['motion']}|{sc['hud']}|{utt_hashes}"
            )
            sc["scene_hash"] = sha256_str(sc_payload)
            scene_hashes.append(sc["scene_hash"])
        sec_payload = f"{sec['section_id']}|{sec['title']}|{','.join(scene_hashes)}"
        sec["section_hash"] = sha256_str(sec_payload)

    manifest = {
        "schema_version": "2.0.0",
        "compiled_at": datetime.now(timezone.utc).isoformat(),
        "title": title,
        "source_script": str(script_path.as_posix()),
        "script_hash": raw_script_hash,
        "config": global_meta,
        "summary": {
            "total_sections": len(sections),
            "total_scenes": total_scenes,
            "total_utterances": total_utterances,
        },
        "sections": sections,
    }
    return manifest


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(
        description="Compile 01_docs/대본_녹음용.md into 02_manifests/script_manifest.json"
    )
    parser.add_argument(
        "--workspace",
        type=Path,
        default=Path("video_pipeline"),
        help="Path to the video_pipeline workspace directory",
    )
    parser.add_argument(
        "--script",
        type=Path,
        default=None,
        help="Explicit path to 대본_녹음용.md (defaults to <workspace>/01_docs/대본_녹음용.md)",
    )
    parser.add_argument(
        "--bind-video",
        type=Path,
        default=None,
        help="Optional path to a recorded video (.mp4/.webm/.mkv) to stage into 04_assets/scenes/ and bind to video scenes",
    )
    args = parser.parse_args()

    workspace: Path = args.workspace.resolve()
    script_path: Path = (
        args.script.resolve()
        if args.script
        else workspace / "01_docs" / "대본_녹음용.md"
    )
    if not script_path.exists():
        print(f"[ERROR] SSOT script not found at: {script_path}", file=sys.stderr)
        return 1

    bind_video_rel: Optional[str] = None
    if args.bind_video:
        src_vid = args.bind_video.resolve()
        if not src_vid.exists():
            print(f"[ERROR] --bind-video file does not exist: {src_vid}", file=sys.stderr)
            return 1
        scenes_dir = workspace / "04_assets" / "scenes"
        scenes_dir.mkdir(parents=True, exist_ok=True)
        dest_vid = scenes_dir / src_vid.name
        if src_vid != dest_vid.resolve():
            shutil.copy2(src_vid, dest_vid)
            print(f"[BIND] Staged recorded video -> {dest_vid}")
        bind_video_rel = f"scenes/{src_vid.name}"

    manifest = compile_markdown_script(script_path, bind_video_rel=bind_video_rel)

    manifests_dir = workspace / "02_manifests"
    manifests_dir.mkdir(parents=True, exist_ok=True)
    out_path = manifests_dir / "script_manifest.json"
    out_path.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    s = manifest["summary"]
    print(
        f"[01_compile_script] Compiled '{manifest['title']}'\n"
        f"  Sections   : {s['total_sections']}\n"
        f"  Scenes     : {s['total_scenes']}\n"
        f"  Utterances : {s['total_utterances']}\n"
        f"  Script SHA : {manifest['script_hash'][:16]}...\n"
        f"  Manifest   : {out_path}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
