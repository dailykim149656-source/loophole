---
name: video-pipeline
description: Declarative 10-step DAG video production pipeline for editing recorded screen captures and still assets with Gemini 3.8 Flash TTS narration, sample-accurate 0ms-drift caption alignment, incremental section rendering, 3-second lossless FFmpeg stream remuxing (-c:v copy), and automated FFmpeg + Gemini 3.8 Flash multimodal QA inspection.
---

# `video-pipeline` — Declarative AI-Native Video Production Skill

Use this skill whenever producing, editing, narrating, or inspecting product demo videos, documentary-style technical walkthroughs, or benchmark showcases from a Single Source of Truth (SSOT) script (`01_docs/대본_녹음용.md`) and recorded video clips (`.mp4`, `.webm`, `.mkv`) or high-resolution still images (`.png`, `.jpg`).

---

## 1. Core Engineering Guarantees (The 4 Pillars)

1. **Deterministic Asset Lockfile (`02_sync_assets.py` -> `assets_lock.json`)**
   - Every video recording and still image referenced in `script_manifest.json` is verified on disk before any synthesis or rendering begins.
   - Inspects dimensions (`width x height`), frame rate, duration (`[trimStart, trimEnd]` bounds for video clips), and SHA-256 checksums via `ffprobe` (with binary header fallback).
   - **Hard Gate**: If even 1 referenced asset is missing or out of trim bounds, the pipeline halts immediately (0 seconds wasted).

2. **Content-Addressable Utterance TTS & 0ms-Drift Captions (`03_build_narration_and_captions.py`)**
   - Synthesizes speech per utterance (`U001..Uxxx`) via `gemini-3.8-flash-tts` / `gemini-3.8-flash-lite-tts` using structured `speech_metadata` annotations (`speaker`, `style`) and `speech_config` (`voice: "Kore"` or `"Puck"`).
   - Caches each synthesized WAV under `03_audio/cache_utterances/{utterance_id}_{sha256[:12]}.wav`. Modifying 2 lines in the script only re-synthesizes those 2 utterances and reassembles the master track in `< 0.2s`.
   - Computes `02_manifests/timeline.json`, `02_manifests/captions.json`, `02_manifests/captions.srt`, and `02_manifests/captions.ass` directly from exact PCM WAV sample frame counts (`sample_frames / sample_rate`), guaranteeing **0.0 ms cumulative audio-caption drift** across arbitrary video durations.

3. **Sub-Pixel Jitter Prevention & Incremental Section Rendering (`06_render_sections.py` + `SmoothStillImage.tsx`)**
   - Prevents Ken Burns pan/zoom quantization jitter in both Remotion (`will-change: transform`, `translate3d`, `scale3d`, `rotate(0.01deg)`) and FFmpeg (`upscale -> zoompan/crop -> lanczos downscale + format=yuv420p`).
   - Renders video sections (`S01..S05+`) independently into `04_assets/chunks/{section_id}_{section_hash[:10]}.mp4` and concatenates (`ffmpeg -f concat -c copy`) into `video_master_silent.mp4`. Editing one section only re-renders that section.

4. **Decoupled Audio/Video Streams & 3-Second Lossless Remuxing (`04_build_mix.py` + `07_mux_final.py`)**
   - `video_master_silent.mp4` (pure visual stream) and `03_audio/master_mix.wav` (narration + sidechain-ducked ambient BGM normalized to EBU R128 `-14 LUFS` / `-1.0 dBTP`) are strictly separated.
   - `07_mux_final.py` runs `ffmpeg -y -i video_master_silent.mp4 -i 03_audio/master_mix.wav -c:v copy -c:a aac -b:a 320k -shortest final_v1.mp4` to remux in **< 3 seconds** without re-encoding video frames.

---

## 2. Directory Layout (Workspace SSOT)

```text
video_pipeline/
├── 01_docs/
│   └── 대본_녹음용.md                 # [SSOT] Declarative script (Sections S01..S05, Scenes, Utterances, @asset tags)
├── 02_manifests/
│   ├── script_manifest.json           # Compiled AST with section/scene/utterance SHA-256 hashes & trim ranges
│   ├── assets_lock.json               # Verified asset lockfile (SHA-256, resolution, duration, codec)
│   ├── timeline.json                  # Sample-frame-exact start/end timestamps per utterance, scene, and section
│   ├── captions.json                  # Structured 0ms-drift caption cues
│   ├── captions.srt                   # SubRip subtitle export
│   ├── captions.ass                   # Advanced SubStation Alpha HUD overlay subtitles
│   ├── qa_report.json                 # Automated FFmpeg + Gemini 3.8 Flash QA report
│   └── build_manifest.json            # Full cryptographic provenance of final_v1.mp4
├── 03_audio/
│   ├── cache_utterances/              # Content-addressable WAV cache ({utterance_id}_{hash}.wav)
│   ├── narration.wav                  # Concatenated pure narration master
│   ├── bgm_ambient.wav                # Procedural or custom ambient bed track
│   └── master_mix.wav                 # Sidechain-ducked + EBU R128 (-14 LUFS) normalized master audio
└── 04_assets/
    ├── scenes/                        # Source video recordings (.mp4/.webm/.mkv) & stills (.png/.jpg)
    ├── chunks/                        # Section-level cached silent video renders (S01.mp4 .. S05.mp4)
    └── keyframes/                     # Extracted QA keyframes per scene
```

---

## 3. Declarative 10-Step DAG Runbook

Execute the pipeline in strict topological order from the repository root (`f:\loophole`):

### Step 1: Author or Update SSOT Script (`01_docs/대본_녹음용.md`)
Each section (`## [S01] Title`), scene (`### [S01_SC01] Scene Title`), metadata directives (`- @asset:`, `- @motion:`, `- @hud:`), and utterances (`- [U001] (speaker=Narrator, voice=Kore, style="...") Transcript text`) are declared in `video_pipeline/01_docs/대본_녹음용.md`.

- **Video Asset Syntax**: `@asset: scenes/recording.mp4 [00:00.000-00:14.500]` (slices `[trimStart, trimEnd]` and time-warps/pads smoothly to match exact spoken utterance duration).
- **Still Image Syntax**: `@asset: scenes/S01_SC01_hero.png` (applies smooth sub-pixel motion preset).
- **Single Recording Quick-Bind**: Pass `--bind-video <path_to_recording.mp4>` to `01_compile_script.py` to automatically bind a single continuous screen recording across all scenes using each scene's `[trimStart, trimEnd]` window.

### Step 2: Compile Script Manifest (`01_compile_script.py`)
```powershell
python .agents/skills/video-pipeline/scripts/01_compile_script.py --workspace video_pipeline
# Optional: bind a single screen recording file to all video scenes:
python .agents/skills/video-pipeline/scripts/01_compile_script.py --workspace video_pipeline --bind-video path/to/recording.mp4
```

### Step 3: Verify & Lock Assets (`02_sync_assets.py`)
```powershell
python .agents/skills/video-pipeline/scripts/02_sync_assets.py --workspace video_pipeline
```
- Fails with exit code `1` if any asset in `script_manifest.json` is missing from `04_assets/`.
- Pass `--generate-placeholders` during dry-run testing to synthesize high-resolution diagnostic test cards/clips for missing assets.

### Step 4: Build Narration & Zero-Drift Captions (`03_build_narration_and_captions.py`)
```powershell
python .agents/skills/video-pipeline/scripts/03_build_narration_and_captions.py --workspace video_pipeline --voice Kore
```
- Calls `gemini-3.8-flash-tts` (or `gemini-3.8-flash-lite-tts` with `--model gemini-3.8-flash-lite-tts`) when `GEMINI_API_KEY` is present; falls back to deterministic acoustic speech-cadence synthesis when offline or `--offline` is passed.
- Outputs `03_audio/narration.wav`, `02_manifests/timeline.json`, `02_manifests/captions.json`, `02_manifests/captions.srt`, and `02_manifests/captions.ass`.

### Step 5: Build Master Audio Mix (`04_build_mix.py`)
```powershell
python .agents/skills/video-pipeline/scripts/04_build_mix.py --workspace video_pipeline
```
- Mixes `narration.wav` with sidechain-ducked ambient BGM and normalizes loudness to `-14.0 LUFS` (`-1.0 dBTP` true peak) into `03_audio/master_mix.wav`.

### Step 6: Pre-Flight Integrity Gate (`05_preflight_check.py`)
```powershell
python .agents/skills/video-pipeline/scripts/05_preflight_check.py --workspace video_pipeline
```
- Verifies 100% alignment across `script_manifest.json`, `assets_lock.json`, `timeline.json`, and `captions.json`, checking for 0 timeline gaps, 0 overlaps, and 0 missing files.

### Step 7: Incremental Section Rendering (`06_render_sections.py`)
```powershell
python .agents/skills/video-pipeline/scripts/06_render_sections.py --workspace video_pipeline
```
- Renders each section `S01..S05` at 1920x1080 @ 30fps (`libx264`, `yuv420p`), burning in optional HUD telemetry headers and crisp subtitles, caching unchanged sections by `section_hash`, and concatenating into `video_pipeline/video_master_silent.mp4`.

### Step 8: 3-Second Lossless Stream Remuxing (`07_mux_final.py`)
```powershell
python .agents/skills/video-pipeline/scripts/07_mux_final.py --workspace video_pipeline --output video_pipeline/final_v1.mp4
```
- Combines `video_master_silent.mp4` + `03_audio/master_mix.wav` with `-c:v copy -c:a aac -b:a 320k -shortest`.

### Step 9: Hybrid Signal & Multimodal QA Inspection (`08_qa_inspector.py`)
```powershell
python .agents/skills/video-pipeline/scripts/08_qa_inspector.py --workspace video_pipeline --video video_pipeline/final_v1.mp4
```
- Runs FFmpeg `blackdetect`, `freezedetect`, and `ebur128` meters, extracts representative scene keyframes, optionally audits visual/caption fidelity via `gemini-3.8-flash`, and writes `02_manifests/qa_report.json`.

### Step 10: Provenance & Archive Bundle (`09_archive_bundle.py`)
```powershell
python .agents/skills/video-pipeline/scripts/09_archive_bundle.py --workspace video_pipeline --video video_pipeline/final_v1.mp4
```
- Computes SHA-256 digests of the final video, master audio, and all manifests into `02_manifests/build_manifest.json`.
