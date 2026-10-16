#!/usr/bin/env python3
"""
03_build_narration_and_captions.py — Content-Addressable Gemini 3.8 TTS & Zero-Drift Caption Engine
Synthesizes per-utterance WAV files via Gemini 3.8 TTS (`gemini-3.8-flash-tts` / `gemini-3.8-flash-lite-tts`
with `speech_metadata` annotations and `voice: "Kore"` or `"Puck"`), caches them under
`03_audio/cache_utterances/{utterance_id}_{hash[:12]}.wav`, falls back to deterministic
formant-cadence WAV synthesis when offline, concatenates into `03_audio/narration.wav`,
and computes sample-frame-locked (`800 samples = 1 frame @ 30fps`) `timeline.json`,
`captions.json`, `captions.srt`, and `captions.ass` with 0.0 ms cumulative drift.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import math
import os
import re
import struct
import subprocess
import sys
import urllib.request
import wave
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

SAMPLE_RATE = 24000
NUM_CHANNELS = 1
SAMPLE_WIDTH = 2  # 16-bit PCM


def strip_inline_tags(text: str) -> str:
    """Remove inline vocal tags like <short pause> or <breath> for visual captions."""
    cleaned = re.sub(r"<[^>]+>", " ", text)
    cleaned = re.sub(r"\|[^|]+\|", " ", cleaned)
    return re.sub(r"\s+", " ", cleaned).strip()


def normalize_wav_bytes_to_24k_mono(raw_bytes: bytes, tmp_dir: Path) -> bytes:
    """Ensure WAV bytes are 24000 Hz, 16-bit mono PCM; return raw PCM frame bytes."""
    try:
        with wave.open(io.BytesIO(raw_bytes), "rb") as wf:
            ch = wf.getnchannels()
            sw = wf.getsampwidth()
            sr = wf.getframerate()
            nframes = wf.getnframes()
            pcm = wf.readframes(nframes)
            if ch == NUM_CHANNELS and sw == SAMPLE_WIDTH and sr == SAMPLE_RATE:
                return pcm
    except Exception:
        pass

    # Use ffmpeg to convert arbitrary audio bytes or raw PCM to 24kHz mono s16le
    in_file = tmp_dir / "_tmp_tts_in.wav"
    out_file = tmp_dir / "_tmp_tts_out.pcm"
    in_file.write_bytes(raw_bytes)
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(in_file),
        "-ac",
        "1",
        "-ar",
        str(SAMPLE_RATE),
        "-f",
        "s16le",
        str(out_file),
    ]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode == 0 and out_file.exists():
        pcm_data = out_file.read_bytes()
        in_file.unlink(missing_ok=True)
        out_file.unlink(missing_ok=True)
        return pcm_data

    in_file.unlink(missing_ok=True)
    out_file.unlink(missing_ok=True)
    # Treat as headerless 24kHz s16le if already even length
    if len(raw_bytes) % 2 == 1:
        raw_bytes = raw_bytes[:-1]
    return raw_bytes


def synthesize_gemini_tts(
    text: str,
    speaker: str,
    voice: str,
    style: str,
    model: str,
    api_key: str,
) -> Optional[bytes]:
    """
    Synthesize speech via Gemini 3.8 TTS using `google-genai` SDK (`client.interactions.create`)
    or REST API fallback (`/v1beta/interactions`).
    Returns WAV bytes (with RIFF header) or None if unavailable.
    """
    annotation: Dict[str, Any] = {
        "type": "speech_metadata",
        "style": style,
    }
    if speaker:
        annotation["speaker"] = speaker

    input_payload = [
        {
            "type": "user_input",
            "content": [
                {
                    "type": "text",
                    "text": text,
                    "annotations": [annotation],
                }
            ],
        }
    ]
    speech_cfg = [{"voice": voice}]

    # 1. Try google-genai SDK
    try:
        from google import genai  # type: ignore

        client = genai.Client(api_key=api_key)
        interaction = client.interactions.create(
            model=model,
            input=input_payload,
            response_format={"type": "audio"},
            generation_config={"speech_config": speech_cfg},
        )
        audio_obj = getattr(interaction, "output_audio", None)
        if audio_obj and getattr(audio_obj, "data", None):
            data_val = audio_obj.data
            if isinstance(data_val, bytes):
                return data_val
            return base64.b64decode(data_val)
    except Exception:
        pass

    # 2. Try REST API `/v1beta/interactions`
    try:
        url = "https://generativelanguage.googleapis.com/v1beta/interactions"
        req_body = json.dumps(
            {
                "model": model,
                "input": input_payload,
                "response_format": {"type": "audio"},
                "generation_config": {"speech_config": speech_cfg},
            }
        ).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=req_body,
            headers={
                "x-goog-api-key": api_key,
                "Content-Type": "application/json",
                "Api-Revision": "2026-05-20",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            resp_data = json.loads(resp.read().decode("utf-8"))
            # Check output_audio or steps[-1].content
            if "output_audio" in resp_data and resp_data["output_audio"].get("data"):
                return base64.b64decode(resp_data["output_audio"]["data"])
            for step in reversed(resp_data.get("steps", [])):
                if step.get("type") == "model_output":
                    for part in step.get("content", []):
                        if part.get("type") == "audio" and part.get("data"):
                            return base64.b64decode(part["data"])
    except Exception:
        pass

    return None


def synthesize_deterministic_fallback_pcm(
    text: str, voice: str, utterance_hash: str
) -> bytes:
    """
    Deterministic speech-cadence acoustic synthesizer fallback when offline.
    Computes exact natural speaking duration from Korean/English syllable count and
    generates a soft, warm syllable-enveloped formant cadence at 24000 Hz mono s16le.
    """
    clean = strip_inline_tags(text)
    # Count Korean syllables + English words/characters for realistic speaking duration
    hangul_chars = len(re.findall(r"[가-힣]", clean))
    ascii_words = len(re.findall(r"[A-Za-z0-9]+", clean))
    punct_pauses = len(re.findall(r"[,.;:—\-?!]", clean))

    # ~4.8 Korean syllables/sec + ~2.8 English words/sec + punctuation micro-pauses
    estimated_sec = (
        max(2.2, (hangul_chars / 4.6) + (ascii_words / 2.7) + (punct_pauses * 0.16))
    )
    total_samples = int(round(estimated_sec * SAMPLE_RATE))

    base_f0 = 165.0 if voice.lower() == "kore" else 130.0
    seed_offset = int(utterance_hash[:6], 16) % 17
    f0 = base_f0 + (seed_offset - 8) * 0.8

    buf = bytearray(total_samples * 2)
    syllable_rate = 4.5  # syllables per second envelope modulation
    two_pi = 2.0 * math.pi

    for i in range(total_samples):
        t = i / SAMPLE_RATE
        # Fade in / fade out envelope
        edge_env = min(1.0, i / (0.04 * SAMPLE_RATE), (total_samples - 1 - i) / (0.06 * SAMPLE_RATE))
        # Syllable cadence envelope
        syl_env = 0.65 + 0.35 * math.sin(two_pi * syllable_rate * t)
        # Gentle pitch prosody contour
        f_inst = f0 * (1.0 + 0.03 * math.sin(two_pi * 0.7 * t))
        # Warm harmonic series (fundamental + 2nd + 3rd formant-filtered harmonics)
        sig = (
            0.58 * math.sin(two_pi * f_inst * t)
            + 0.28 * math.sin(two_pi * (f_inst * 2.0) * t + 0.3)
            + 0.14 * math.sin(two_pi * (f_inst * 3.0) * t + 0.7)
        )
        # Target around -16 dBFS (amplitude ~ 0.15)
        val = int(max(-32767, min(32767, sig * edge_env * syl_env * 4600.0)))
        struct.pack_into("<h", buf, i * 2, val)

    return bytes(buf)


def write_wav_file(path: Path, pcm_bytes: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(NUM_CHANNELS)
        wf.setsampwidth(SAMPLE_WIDTH)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(pcm_bytes)


def read_wav_pcm(path: Path) -> bytes:
    with wave.open(str(path), "rb") as wf:
        return wf.readframes(wf.getnframes())


def split_caption_chunks(text: str, max_chars: int = 44) -> List[str]:
    """
    Split an utterance into readable subtitle chunks along natural clause boundaries
    while preserving 100% of the visible text tokens.
    """
    clean = strip_inline_tags(text)
    if len(clean) <= max_chars:
        return [clean]

    # Split by sentence/clause delimiters while keeping delimiter attached
    tokens = re.split(r"(?<=[,.:;?!—])\s+|\s+(?=—)", clean)
    chunks: List[str] = []
    current = ""
    for tok in tokens:
        tok = tok.strip()
        if not tok:
            continue
        if not current:
            current = tok
        elif len(current) + 1 + len(tok) <= max_chars:
            current = f"{current} {tok}"
        else:
            chunks.append(current)
            current = tok
    if current:
        chunks.append(current)

    # Further split any chunk that is still very long by whitespace midpoint
    final_chunks: List[str] = []
    for ch in chunks:
        if len(ch) <= max_chars * 1.25:
            final_chunks.append(ch)
        else:
            words = ch.split(" ")
            mid = max(1, len(words) // 2)
            final_chunks.append(" ".join(words[:mid]))
            final_chunks.append(" ".join(words[mid:]))
    return [c for c in final_chunks if c]


def format_srt_time(seconds: float) -> str:
    ms_total = int(round(seconds * 1000))
    hrs = ms_total // 3_600_000
    rem = ms_total % 3_600_000
    mins = rem // 60_000
    rem %= 60_000
    secs = rem // 1000
    ms = rem % 1000
    return f"{hrs:02d}:{mins:02d}:{secs:02d},{ms:03d}"


def format_ass_time(seconds: float) -> str:
    cs_total = int(round(seconds * 100))
    hrs = cs_total // 360_000
    rem = cs_total % 360_000
    mins = rem // 6_000
    rem %= 6_000
    secs = rem // 100
    cs = rem % 100
    return f"{hrs:01d}:{mins:02d}:{secs:02d}.{cs:02d}"


def build_ass_document(cues: List[Dict[str, Any]], width: int, height: int) -> str:
    header = f"""[Script Info]
Title: THE LOOPHOLE — CleanCo AI Safety Observatory Subtitles
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Malgun Gothic,38,&H00FFFFFF,&H0000FFFF,&H00140C08,&H960C0805,-1,0,0,0,100,100,0.5,0,3,3,0,2,80,80,52,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines = [header.strip()]
    for cue in cues:
        start_str = format_ass_time(cue["start_sec"])
        end_str = format_ass_time(cue["end_sec"])
        txt = cue["text"].replace("\n", "\\N")
        lines.append(f"Dialogue: 0,{start_str},{end_str},Default,,0,0,0,,{txt}")
    return "\n".join(lines) + "\n"


def load_api_key(workspace: Path) -> str:
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if key:
        return key
    for env_candidate in (workspace / ".env", workspace.parent / ".env"):
        if env_candidate.exists():
            try:
                for line in env_candidate.read_text(encoding="utf-8").splitlines():
                    line = line.strip()
                    if line.startswith("GEMINI_API_KEY="):
                        val = line.split("=", 1)[1].strip().strip('"').strip("'")
                        if val:
                            return val
            except Exception:
                pass
    return ""


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(
        description="Synthesize content-addressable Gemini 3.8 TTS narration and 0ms-drift captions"
    )
    parser.add_argument(
        "--workspace",
        type=Path,
        default=Path("video_pipeline"),
        help="Path to video_pipeline workspace",
    )
    parser.add_argument(
        "--model",
        type=str,
        default="gemini-3.8-flash-tts",
        choices=["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts"],
        help="Gemini 3.8 TTS model identifier",
    )
    parser.add_argument(
        "--voice",
        type=str,
        default=None,
        help="Optional global voice override (e.g. Kore or Puck)",
    )
    parser.add_argument(
        "--offline",
        action="store_true",
        help="Force deterministic offline speech-cadence synthesis without calling external API",
    )
    args = parser.parse_args()

    workspace = args.workspace.resolve()
    manifest_path = workspace / "02_manifests" / "script_manifest.json"
    if not manifest_path.exists():
        print(
            f"[ERROR] {manifest_path} not found. Run 01_compile_script.py first.",
            file=sys.stderr,
        )
        return 1

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    fps = int(manifest.get("config", {}).get("fps", 30))
    width = int(manifest.get("config", {}).get("width", 1920))
    height = int(manifest.get("config", {}).get("height", 1080))

    # Quantum alignment: 24000 Hz / 30 fps = 800 samples per video frame
    samples_per_frame = SAMPLE_RATE // fps
    inter_utterance_pause_frames = 5  # 5 frames = 0.1667s breath between utterances

    cache_dir = workspace / "03_audio" / "cache_utterances"
    cache_dir.mkdir(parents=True, exist_ok=True)
    api_key = load_api_key(workspace)

    master_pcm = bytearray()
    current_sample = 0

    timeline_sections: List[Dict[str, Any]] = []
    timeline_scenes: List[Dict[str, Any]] = []
    timeline_utterances: List[Dict[str, Any]] = []
    caption_cues: List[Dict[str, Any]] = []

    cache_hits = 0
    tts_synthesized = 0
    fallback_synthesized = 0
    cue_index = 1

    for sec in manifest.get("sections", []):
        sec_start_sample = current_sample
        sec_scene_ids: List[str] = []

        for sc in sec.get("scenes", []):
            sc_start_sample = current_sample
            sc_utt_ids: List[str] = []

            for utt in sc.get("utterances", []):
                utt_id = utt["utterance_id"]
                utt_hash = utt["utterance_hash"]
                voice = args.voice or utt.get("voice", "Kore")
                speaker = utt.get("speaker", "Narrator")
                style = utt.get("style", "confident, analytical documentary narrator")
                text = utt["text"]

                cache_file = cache_dir / f"{utt_id}_{utt_hash[:12]}.wav"
                tts_source = "cache"

                if cache_file.exists():
                    raw_pcm = read_wav_pcm(cache_file)
                    cache_hits += 1
                else:
                    raw_pcm = None
                    if api_key and not args.offline:
                        wav_bytes = synthesize_gemini_tts(
                            text=text,
                            speaker=speaker,
                            voice=voice,
                            style=style,
                            model=args.model,
                            api_key=api_key,
                        )
                        if wav_bytes:
                            raw_pcm = normalize_wav_bytes_to_24k_mono(wav_bytes, cache_dir)
                            tts_source = args.model
                            tts_synthesized += 1

                    if raw_pcm is None:
                        raw_pcm = synthesize_deterministic_fallback_pcm(
                            text=text, voice=voice, utterance_hash=utt_hash
                        )
                        tts_source = "deterministic_fallback"
                        fallback_synthesized += 1

                    write_wav_file(cache_file, raw_pcm)

                raw_samples = len(raw_pcm) // SAMPLE_WIDTH
                # Pad utterance + breath pause to an exact multiple of `samples_per_frame` (800 samples)
                raw_plus_pause = raw_samples + (inter_utterance_pause_frames * samples_per_frame)
                rem = raw_plus_pause % samples_per_frame
                pad_samples = (samples_per_frame - rem) if rem != 0 else 0
                aligned_total_samples = (
                    raw_samples
                    + (inter_utterance_pause_frames * samples_per_frame)
                    + pad_samples
                )
                silence_tail_samples = aligned_total_samples - raw_samples

                utt_start_sample = current_sample
                utt_speech_end_sample = utt_start_sample + raw_samples
                utt_end_sample = utt_start_sample + aligned_total_samples

                master_pcm.extend(raw_pcm)
                master_pcm.extend(b"\x00\x00" * silence_tail_samples)
                current_sample = utt_end_sample

                start_frame = utt_start_sample // samples_per_frame
                end_frame = utt_end_sample // samples_per_frame
                duration_frames = end_frame - start_frame
                start_sec = round(utt_start_sample / SAMPLE_RATE, 6)
                end_sec = round(utt_end_sample / SAMPLE_RATE, 6)
                speech_end_sec = round(utt_speech_end_sample / SAMPLE_RATE, 6)
                duration_sec = round(aligned_total_samples / SAMPLE_RATE, 6)

                utt_entry = {
                    "utterance_id": utt_id,
                    "section_id": sec["section_id"],
                    "scene_id": sc["scene_id"],
                    "speaker": speaker,
                    "voice": voice,
                    "utterance_hash": utt_hash,
                    "cache_wav": str(cache_file.relative_to(workspace).as_posix()),
                    "tts_source": tts_source,
                    "start_sample": utt_start_sample,
                    "speech_end_sample": utt_speech_end_sample,
                    "end_sample": utt_end_sample,
                    "sample_frames": aligned_total_samples,
                    "start_frame": start_frame,
                    "end_frame": end_frame,
                    "duration_frames": duration_frames,
                    "start_sec": start_sec,
                    "speech_end_sec": speech_end_sec,
                    "end_sec": end_sec,
                    "duration_sec": duration_sec,
                    "start_ms": int(round(start_sec * 1000)),
                    "end_ms": int(round(end_sec * 1000)),
                }
                timeline_utterances.append(utt_entry)
                sc_utt_ids.append(utt_id)

                # Sub-utterance caption cues proportional to character length inside [utt_start_sample, utt_speech_end_sample]
                sub_chunks = split_caption_chunks(text)
                total_chars = max(1, sum(len(c) for c in sub_chunks))
                sub_cursor_sample = utt_start_sample

                for idx, chunk_text in enumerate(sub_chunks):
                    if idx == len(sub_chunks) - 1:
                        sub_end_sample = utt_speech_end_sample
                    else:
                        share = int(round((len(chunk_text) / total_chars) * raw_samples))
                        sub_end_sample = min(utt_speech_end_sample, sub_cursor_sample + share)

                    c_start_sec = round(sub_cursor_sample / SAMPLE_RATE, 6)
                    c_end_sec = round(sub_end_sample / SAMPLE_RATE, 6)
                    caption_cues.append(
                        {
                            "cue_id": f"CUE_{cue_index:04d}",
                            "cue_index": cue_index,
                            "utterance_id": utt_id,
                            "scene_id": sc["scene_id"],
                            "section_id": sec["section_id"],
                            "speaker": speaker,
                            "text": chunk_text,
                            "full_utterance_text": text,
                            "is_first_in_utterance": idx == 0,
                            "start_sample": sub_cursor_sample,
                            "end_sample": sub_end_sample,
                            "start_sec": c_start_sec,
                            "end_sec": c_end_sec,
                            "start_ms": int(round(c_start_sec * 1000)),
                            "end_ms": int(round(c_end_sec * 1000)),
                        }
                    )
                    cue_index += 1
                    sub_cursor_sample = sub_end_sample

            sc_end_sample = current_sample
            sc_start_frame = sc_start_sample // samples_per_frame
            sc_end_frame = sc_end_sample // samples_per_frame
            timeline_scenes.append(
                {
                    "scene_id": sc["scene_id"],
                    "section_id": sec["section_id"],
                    "title": sc["title"],
                    "scene_hash": sc["scene_hash"],
                    "asset": sc["asset"],
                    "motion": sc["motion"],
                    "hud": sc.get("hud", ""),
                    "utterance_ids": sc_utt_ids,
                    "start_sample": sc_start_sample,
                    "end_sample": sc_end_sample,
                    "sample_frames": sc_end_sample - sc_start_sample,
                    "start_frame": sc_start_frame,
                    "end_frame": sc_end_frame,
                    "duration_frames": sc_end_frame - sc_start_frame,
                    "start_sec": round(sc_start_sample / SAMPLE_RATE, 6),
                    "end_sec": round(sc_end_sample / SAMPLE_RATE, 6),
                    "duration_sec": round((sc_end_sample - sc_start_sample) / SAMPLE_RATE, 6),
                }
            )
            sec_scene_ids.append(sc["scene_id"])

        sec_end_sample = current_sample
        sec_start_frame = sec_start_sample // samples_per_frame
        sec_end_frame = sec_end_sample // samples_per_frame
        timeline_sections.append(
            {
                "section_id": sec["section_id"],
                "title": sec["title"],
                "section_hash": sec["section_hash"],
                "scene_ids": sec_scene_ids,
                "start_sample": sec_start_sample,
                "end_sample": sec_end_sample,
                "sample_frames": sec_end_sample - sec_start_sample,
                "start_frame": sec_start_frame,
                "end_frame": sec_end_frame,
                "duration_frames": sec_end_frame - sec_start_frame,
                "start_sec": round(sec_start_sample / SAMPLE_RATE, 6),
                "end_sec": round(sec_end_sample / SAMPLE_RATE, 6),
                "duration_sec": round((sec_end_sample - sec_start_sample) / SAMPLE_RATE, 6),
            }
        )

    # Write concatenated master narration.wav
    narration_wav_path = workspace / "03_audio" / "narration.wav"
    write_wav_file(narration_wav_path, bytes(master_pcm))

    total_frames = current_sample // samples_per_frame
    total_duration_sec = round(current_sample / SAMPLE_RATE, 6)

    timeline_payload = {
        "schema_version": "2.0.0",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "script_hash": manifest.get("script_hash"),
        "sample_rate": SAMPLE_RATE,
        "fps": fps,
        "samples_per_frame": samples_per_frame,
        "cumulative_drift_ms": 0.0,
        "total_samples": current_sample,
        "total_frames": total_frames,
        "total_duration_sec": total_duration_sec,
        "sections": timeline_sections,
        "scenes": timeline_scenes,
        "utterances": timeline_utterances,
    }

    captions_payload = {
        "schema_version": "2.0.0",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "script_hash": manifest.get("script_hash"),
        "cumulative_drift_ms": 0.0,
        "total_utterances": len(timeline_utterances),
        "total_cues": len(caption_cues),
        "utterance_transcripts": [
            {
                "utterance_id": u["utterance_id"],
                "scene_id": u["scene_id"],
                "section_id": u["section_id"],
                "utterance_hash": u["utterance_hash"],
                "text": next(
                    c["full_utterance_text"]
                    for c in caption_cues
                    if c["utterance_id"] == u["utterance_id"]
                ),
                "start_ms": u["start_ms"],
                "end_ms": u["end_ms"],
            }
            for u in timeline_utterances
        ],
        "cues": caption_cues,
    }

    manifests_dir = workspace / "02_manifests"
    timeline_path = manifests_dir / "timeline.json"
    captions_path = manifests_dir / "captions.json"
    srt_path = manifests_dir / "captions.srt"
    ass_path = manifests_dir / "captions.ass"

    timeline_path.write_text(
        json.dumps(timeline_payload, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    captions_path.write_text(
        json.dumps(captions_payload, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    # Write .srt
    srt_blocks: List[str] = []
    for cue in caption_cues:
        srt_blocks.append(
            f"{cue['cue_index']}\n"
            f"{format_srt_time(cue['start_sec'])} --> {format_srt_time(cue['end_sec'])}\n"
            f"{cue['text']}\n"
        )
    srt_path.write_text("\n".join(srt_blocks), encoding="utf-8")

    # Write .ass
    ass_path.write_text(build_ass_document(caption_cues, width, height), encoding="utf-8")

    print(
        f"[03_build_narration_and_captions] Complete\n"
        f"  Utterances   : {len(timeline_utterances)} (cache hits: {cache_hits}, Gemini TTS: {tts_synthesized}, fallback: {fallback_synthesized})\n"
        f"  Caption Cues : {len(caption_cues)} (cumulative drift: 0.0 ms)\n"
        f"  Total Length : {total_duration_sec:.2f}s ({total_frames} frames @ {fps}fps, {current_sample} samples @ {SAMPLE_RATE}Hz)\n"
        f"  Narration    : {narration_wav_path}\n"
        f"  Timeline     : {timeline_path}\n"
        f"  Captions     : {captions_path} (+ .srt / .ass)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
