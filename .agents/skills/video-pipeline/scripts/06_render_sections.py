#!/usr/bin/env python3
"""
06_render_sections.py — Incremental Section Renderer with Sub-Pixel Motion & HUD Overlay
Renders each section (`S01..S05`) independently into `04_assets/chunks/{section_id}.mp4`:
  - Recorded video clips (.mp4/.webm/.mkv): slices `[trimStart, trimEnd]` and smoothly
    rate-matches/pads (`setpts` + `tpad`) to the exact frame count of the scene's narration.
  - Still images (.png/.jpg): upscales to 4K Lanczos prior to floating-point motion
    interpolation (`zoom_in_slow`, `zoom_in`, `zoom_out`, `pan_right`, `pan_left`) to prevent
    1px quantization jitter.
  - Overlays crisp 1080p HUD telemetry header and 0ms-drift broadcast subtitles.
  - Caches unchanged sections by `section_hash` and concatenates (`concat -c copy`)
    all sections into `video_master_silent.mp4`.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from PIL import Image, ImageDraw, ImageFont


def load_font(size: int, bold: bool = True) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = (
        [
            "C:/Windows/Fonts/malgunbd.ttf",
            "C:/Windows/Fonts/segoeuib.ttf",
            "C:/Windows/Fonts/arialbd.ttf",
            "C:/Windows/Fonts/malgun.ttf",
        ]
        if bold
        else [
            "C:/Windows/Fonts/malgun.ttf",
            "C:/Windows/Fonts/segoeui.ttf",
            "C:/Windows/Fonts/arial.ttf",
        ]
    )
    for fp in candidates:
        if Path(fp).exists():
            try:
                return ImageFont.truetype(fp, size=size)
            except Exception:
                continue
    return ImageFont.load_default()


def render_hud_and_caption_png(
    out_png: Path,
    width: int,
    height: int,
    section_id: str,
    scene_id: str,
    scene_title: str,
    hud_text: str,
    caption_text: str,
) -> None:
    """
    Render a 1920x1080 RGBA overlay containing:
      1. Sleek top-left observatory HUD telemetry pill (`[S01 // S01_SC01] Title` + `@hud` status)
      2. Crisp bottom broadcast subtitle pill for `caption_text`
    """
    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    font_badge = load_font(18, bold=True)
    font_hud = load_font(17, bold=False)
    font_sub = load_font(32, bold=True)

    # 1. Top HUD bar (Safe Area top-left)
    header_left = 48
    header_top = 32
    badge_label = f"{section_id} · {scene_id}  |  {scene_title}"
    hud_label = hud_text if hud_text else "THE LOOPHOLE · CLEANCO v1 (Rev.15.2)"

    b_box = draw.textbbox((0, 0), badge_label, font=font_badge)
    h_box = draw.textbbox((0, 0), hud_label, font=font_hud)
    panel_w = max(b_box[2] - b_box[0], h_box[2] - h_box[0]) + 44
    panel_h = 68

    draw.rounded_rectangle(
        [header_left, header_top, header_left + panel_w, header_top + panel_h],
        radius=10,
        fill=(7, 11, 22, 205),
        outline=(34, 211, 238, 160),
        width=2,
    )
    draw.text(
        (header_left + 20, header_top + 10),
        badge_label,
        font=font_badge,
        fill=(240, 246, 252, 255),
    )
    draw.text(
        (header_left + 20, header_top + 38),
        hud_label,
        font=font_hud,
        fill=(34, 211, 238, 240),
    )

    # 2. Bottom broadcast caption pill
    if caption_text.strip():
        c_box = draw.textbbox((0, 0), caption_text, font=font_sub)
        tw = c_box[2] - c_box[0]
        th = c_box[3] - c_box[1]
        pad_x = 34
        pad_y = 16
        box_w = tw + pad_x * 2
        box_h = th + pad_y * 2
        x0 = (width - box_w) // 2
        y0 = height - box_h - 54

        draw.rounded_rectangle(
            [x0, y0, x0 + box_w, y0 + box_h],
            radius=12,
            fill=(6, 9, 18, 222),
            outline=(148, 163, 184, 95),
            width=1,
        )
        draw.text(
            (x0 + pad_x, y0 + pad_y - 2),
            caption_text,
            font=font_sub,
            fill=(255, 255, 255, 255),
        )

    out_png.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_png, format="PNG")


def build_image_motion_vf(
    motion: str, duration_frames: int, fps: int, width: int, height: int
) -> str:
    """
    Build a sub-pixel smooth FFmpeg filterchain for still images by upscaling to
    3840x2160 Lanczos before applying floating-point zoompan down to 1920x1080.
    """
    d = max(1, duration_frames)
    if motion == "zoom_in_slow":
        z_expr = f"1.0+0.045*(on/{d})"
        x_expr = "iw/2-(iw/zoom/2)"
        y_expr = "ih/2-(ih/zoom/2)"
    elif motion == "zoom_in":
        z_expr = f"1.0+0.085*(on/{d})"
        x_expr = "iw/2-(iw/zoom/2)"
        y_expr = "ih/2-(ih/zoom/2)"
    elif motion == "zoom_out":
        z_expr = f"1.085-0.085*(on/{d})"
        x_expr = "iw/2-(iw/zoom/2)"
        y_expr = "ih/2-(ih/zoom/2)"
    elif motion == "pan_right":
        z_expr = "1.06"
        x_expr = f"(iw-iw/zoom)*(on/{d})"
        y_expr = "ih/2-(ih/zoom/2)"
    elif motion == "pan_left":
        z_expr = "1.06"
        x_expr = f"(iw-iw/zoom)*(1-on/{d})"
        y_expr = "ih/2-(ih/zoom/2)"
    else:
        z_expr = "1.005"
        x_expr = "iw/2-(iw/zoom/2)"
        y_expr = "ih/2-(ih/zoom/2)"

    return (
        f"scale={width*2}:{height*2}:force_original_aspect_ratio=decrease,"
        f"pad={width*2}:{height*2}:(ow-iw)/2:(oh-ih)/2:color=0x050811,"
        f"zoompan=z='{z_expr}':x='{x_expr}':y='{y_expr}':d={d}:s={width}x{height}:fps={fps},"
        f"setsar=1"
    )


def render_scene_clip(
    scene: Dict[str, Any],
    binding: Dict[str, Any],
    scene_cues: List[Dict[str, Any]],
    out_scene_mp4: Path,
    tmp_dir: Path,
    width: int,
    height: int,
    fps: int,
) -> None:
    """Render a single scene with exact frame count `duration_frames` and HUD/caption overlays."""
    duration_frames = int(scene["duration_frames"])
    target_sec = duration_frames / float(fps)
    sc_start_sec = float(scene["start_sec"])
    src_path = Path(binding["resolved_path"])
    asset_type = binding["asset_type"]

    # Prepare cue overlay PNGs for this scene
    overlay_specs: List[Tuple[Path, float, float]] = []
    if not scene_cues:
        png_path = tmp_dir / f"{scene['scene_id']}_hud_00.png"
        render_hud_and_caption_png(
            out_png=png_path,
            width=width,
            height=height,
            section_id=scene["section_id"],
            scene_id=scene["scene_id"],
            scene_title=scene["title"],
            hud_text=scene.get("hud", ""),
            caption_text="",
        )
        overlay_specs.append((png_path, 0.0, target_sec))
    else:
        for idx, cue in enumerate(scene_cues):
            png_path = tmp_dir / f"{scene['scene_id']}_cue_{idx:02d}.png"
            render_hud_and_caption_png(
                out_png=png_path,
                width=width,
                height=height,
                section_id=scene["section_id"],
                scene_id=scene["scene_id"],
                scene_title=scene["title"],
                hud_text=scene.get("hud", ""),
                caption_text=cue["text"],
            )
            rel_start = max(0.0, float(cue["start_sec"]) - sc_start_sec)
            if idx == len(scene_cues) - 1:
                rel_end = target_sec
            else:
                rel_end = min(
                    target_sec,
                    max(rel_start + 0.05, float(scene_cues[idx + 1]["start_sec"]) - sc_start_sec),
                )
            overlay_specs.append((png_path, rel_start, rel_end))

    cmd: List[str] = ["ffmpeg", "-y"]

    if asset_type == "video":
        src_dur = float(binding.get("duration_sec") or target_sec)
        t_start = binding.get("trim_start_sec")
        t_end = binding.get("trim_end_sec")

        if t_start is not None and t_end is not None and t_end > t_start:
            eff_start = min(float(t_start), max(0.0, src_dur - 0.5))
            eff_end = min(float(t_end), src_dur) if src_dur > eff_start + 0.2 else float(t_end)
            clip_span = max(0.2, eff_end - eff_start)
            cmd.extend(["-ss", f"{eff_start:.3f}", "-to", f"{eff_end:.3f}", "-i", str(src_path)])
        else:
            clip_span = max(0.2, src_dur)
            cmd.extend(["-i", str(src_path)])

        pts_ratio = target_sec / clip_span
        # Smooth time-stretch if within [0.35, 3.0], plus clone-pad tail safety
        pts_ratio_clamped = max(0.35, min(3.0, pts_ratio))
        base_v_filter = (
            f"[0:v]setpts={pts_ratio_clamped:.6f}*(PTS-STARTPTS),"
            f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=0x050811,"
            f"setsar=1,fps={fps},"
            f"tpad=stop_mode=clone:stop_duration={target_sec + 2.0:.2f},"
            f"trim=duration={target_sec:.6f},setpts=PTS-STARTPTS[v0]"
        )
    else:
        cmd.extend(["-loop", "1", "-t", f"{target_sec + 0.5:.3f}", "-i", str(src_path)])
        motion_vf = build_image_motion_vf(
            scene.get("motion", "zoom_in_slow"), duration_frames, fps, width, height
        )
        base_v_filter = f"[0:v]{motion_vf},trim=duration={target_sec:.6f},setpts=PTS-STARTPTS[v0]"

    for png_path, _, _ in overlay_specs:
        cmd.extend(["-i", str(png_path)])

    filter_parts = [base_v_filter]
    prev_label = "v0"
    for idx, (_, r_start, r_end) in enumerate(overlay_specs):
        in_idx = idx + 1
        next_label = f"v{idx + 1}"
        enable_expr = f"between(t,{r_start:.4f},{r_end:.4f})"
        filter_parts.append(
            f"[{prev_label}][{in_idx}:v]overlay=0:0:enable='{enable_expr}'[{next_label}]"
        )
        prev_label = next_label

    filter_parts.append(f"[{prev_label}]format=yuv420p[vout]")
    filter_complex = ";".join(filter_parts)

    cmd.extend(
        [
            "-filter_complex",
            filter_complex,
            "-map",
            "[vout]",
            "-an",
            "-frames:v",
            str(duration_frames),
            "-r",
            str(fps),
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            str(out_scene_mp4),
        ]
    )

    subprocess.run(cmd, check=True, capture_output=True)


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(
        description="Incremental section renderer producing video_master_silent.mp4"
    )
    parser.add_argument(
        "--workspace",
        type=Path,
        default=Path("video_pipeline"),
        help="Path to video_pipeline workspace",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Force re-render of all sections ignoring section_hash cache",
    )
    args = parser.parse_args()

    workspace = args.workspace.resolve()
    manifests_dir = workspace / "02_manifests"
    timeline_path = manifests_dir / "timeline.json"
    captions_path = manifests_dir / "captions.json"
    lock_path = manifests_dir / "assets_lock.json"

    for p in (timeline_path, captions_path, lock_path):
        if not p.exists():
            print(f"[ERROR] Required manifest missing: {p}", file=sys.stderr)
            return 1

    timeline = json.loads(timeline_path.read_text(encoding="utf-8"))
    captions = json.loads(captions_path.read_text(encoding="utf-8"))
    assets_lock = json.loads(lock_path.read_text(encoding="utf-8"))

    fps = int(timeline.get("fps", 30))
    width = 1920
    height = 1080

    binding_by_scene: Dict[str, Dict[str, Any]] = {
        b["scene_id"]: b for b in assets_lock.get("scene_bindings", [])
    }
    scene_by_id: Dict[str, Dict[str, Any]] = {
        s["scene_id"]: s for s in timeline.get("scenes", [])
    }
    cues_by_scene: Dict[str, List[Dict[str, Any]]] = {}
    for cue in captions.get("cues", []):
        cues_by_scene.setdefault(cue["scene_id"], []).append(cue)

    chunks_dir = workspace / "04_assets" / "chunks"
    tmp_dir = chunks_dir / "_tmp_overlays"
    chunks_dir.mkdir(parents=True, exist_ok=True)
    tmp_dir.mkdir(parents=True, exist_ok=True)

    cache_index_path = chunks_dir / "render_cache.json"
    cache_index: Dict[str, Any] = {}
    if cache_index_path.exists():
        try:
            cache_index = json.loads(cache_index_path.read_text(encoding="utf-8"))
        except Exception:
            cache_index = {}

    section_mp4_paths: List[Path] = []
    rendered_sections = 0
    reused_sections = 0

    for sec in timeline.get("sections", []):
        sec_id = sec["section_id"]
        # Composite hash includes section_hash + asset sha256s + exact duration_frames
        asset_hashes = ",".join(
            binding_by_scene[sc_id]["sha256"]
            for sc_id in sec["scene_ids"]
            if sc_id in binding_by_scene
        )
        composite_hash = hashlib.sha256(
            f"{sec['section_hash']}|{sec['duration_frames']}|{asset_hashes}".encode("utf-8")
        ).hexdigest()

        sec_out_mp4 = chunks_dir / f"{sec_id}.mp4"
        cached_entry = cache_index.get(sec_id, {})

        if (
            not args.force
            and sec_out_mp4.exists()
            and cached_entry.get("composite_hash") == composite_hash
        ):
            print(f"[06_render_sections] [CACHE HIT] {sec_id} ({sec['duration_sec']:.2f}s) -> {sec_out_mp4.name}")
            section_mp4_paths.append(sec_out_mp4)
            reused_sections += 1
            continue

        print(f"[06_render_sections] [RENDERING] {sec_id}: {sec['title']} ({sec['duration_sec']:.2f}s, {sec['duration_frames']} frames)...")
        scene_clip_paths: List[Path] = []
        for sc_id in sec["scene_ids"]:
            sc_obj = scene_by_id[sc_id]
            b_obj = binding_by_scene[sc_id]
            sc_cues = cues_by_scene.get(sc_id, [])
            sc_mp4 = tmp_dir / f"{sc_id}.mp4"
            render_scene_clip(
                scene=sc_obj,
                binding=b_obj,
                scene_cues=sc_cues,
                out_scene_mp4=sc_mp4,
                tmp_dir=tmp_dir,
                width=width,
                height=height,
                fps=fps,
            )
            scene_clip_paths.append(sc_mp4)

        if len(scene_clip_paths) == 1:
            sec_out_mp4.write_bytes(scene_clip_paths[0].read_bytes())
        else:
            concat_list_file = tmp_dir / f"concat_{sec_id}.txt"
            concat_lines = [f"file '{p.resolve().as_posix()}'" for p in scene_clip_paths]
            concat_list_file.write_text("\n".join(concat_lines) + "\n", encoding="utf-8")
            cmd_concat_sec = [
                "ffmpeg",
                "-y",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                str(concat_list_file),
                "-c",
                "copy",
                str(sec_out_mp4),
            ]
            subprocess.run(cmd_concat_sec, check=True, capture_output=True)

        cache_index[sec_id] = {
            "section_id": sec_id,
            "section_hash": sec["section_hash"],
            "composite_hash": composite_hash,
            "duration_frames": sec["duration_frames"],
            "duration_sec": sec["duration_sec"],
            "rendered_at": datetime.now(timezone.utc).isoformat(),
            "chunk_file": str(sec_out_mp4.relative_to(workspace).as_posix()),
        }
        cache_index_path.write_text(
            json.dumps(cache_index, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        section_mp4_paths.append(sec_out_mp4)
        rendered_sections += 1

    # Concatenate all section chunks into video_master_silent.mp4 via lossless stream copy
    master_concat_txt = chunks_dir / "concat_sections.txt"
    master_concat_txt.write_text(
        "\n".join(f"file '{p.resolve().as_posix()}'" for p in section_mp4_paths) + "\n",
        encoding="utf-8",
    )
    master_silent_mp4 = workspace / "video_master_silent.mp4"
    cmd_master = [
        "ffmpeg",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        str(master_concat_txt),
        "-c",
        "copy",
        str(master_silent_mp4),
    ]
    subprocess.run(cmd_master, check=True, capture_output=True)

    print(
        f"[06_render_sections] Master silent video ready\n"
        f"  Sections Rendered : {rendered_sections} (Cache Reused: {reused_sections})\n"
        f"  Total Duration    : {timeline['total_duration_sec']:.2f}s ({timeline['total_frames']} frames @ {fps}fps)\n"
        f"  Output            : {master_silent_mp4}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
