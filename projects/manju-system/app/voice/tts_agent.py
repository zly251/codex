import asyncio
import json
import re
import subprocess
import time
from datetime import datetime
from pathlib import Path

import edge_tts

from app.data import db
from app.voice.voice_config import DEFAULT_VOICE, pick_voice

BITRATES_MPEG1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
BITRATES_MPEG2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
SAMPLERATES = {
    3: {0: 44100, 1: 48000, 2: 32000},
    2: {0: 22050, 1: 24000, 2: 16000},
    0: {0: 11025, 1: 12000, 2: 8000},
}
SAMPLES_PER_FRAME = {3: 1152, 2: 576, 0: 576}


def mp3_duration(path):
    ffmpeg = _find_ffmpeg()
    try:
        result = subprocess.run(
            [ffmpeg, "-i", str(path)],
            capture_output=True,
            text=True,
            timeout=20,
        )
        match = re.search(
            r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", result.stderr or ""
        )
        if match:
            hours, minutes, seconds = match.groups()
            return round(int(hours) * 3600 + int(minutes) * 60 + float(seconds), 3)
    except Exception:
        pass
    data = Path(path).read_bytes()
    start = 0
    if data[:3] == b"ID3":
        id3_size = (
            ((data[6] & 0x7F) << 21)
            | ((data[7] & 0x7F) << 14)
            | ((data[8] & 0x7F) << 7)
            | (data[9] & 0x7F)
        )
        start = 10 + id3_size
    i = start
    n = len(data)
    while i + 4 <= n:
        if data[i] == 0xFF and (data[i + 1] & 0xE0) == 0xE0:
            version = (data[i + 1] >> 3) & 0x03
            layer = (data[i + 1] >> 1) & 0x03
            if version == 1 or layer != 1:
                i += 1
                continue
            bitrate_idx = (data[i + 2] >> 4) & 0x0F
            samplerate_idx = (data[i + 2] >> 2) & 0x03
            padding = (data[i + 2] >> 1) & 0x01
            if bitrate_idx == 0 or samplerate_idx == 3:
                i += 1
                continue
            bitrate_kbps = (
                BITRATES_MPEG1 if version == 3 else BITRATES_MPEG2
            )[bitrate_idx]
            samplerate = SAMPLERATES[version][samplerate_idx]
            frame_len = (
                144 if version == 3 else 72
            ) * bitrate_kbps * 1000 // samplerate + padding
            frames = (n - i) // frame_len
            return round(frames * SAMPLES_PER_FRAME[version] / samplerate, 3)
        i += 1
    return round(len(data) * 8 / 128000, 3)


def _find_ffmpeg():
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return "ffmpeg"


def generate_silence_mp3(path, duration=1.0, ffmpeg=None):
    ffmpeg = ffmpeg or _find_ffmpeg()
    cmd = [
        ffmpeg,
        "-y",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=24000:cl=mono",
        "-t",
        str(duration),
        "-c:a",
        "libmp3lame",
        "-q:a",
        "9",
        str(path),
    ]
    subprocess.run(cmd, capture_output=True, text=True, timeout=60, check=True)


class TTSAgent:
    def __init__(
        self,
        run_id,
        run_dir,
        output_dir,
        db_path,
        logger,
        max_retries=3,
        backoff_seconds=2,
        voice_map=None,
    ):
        self.run_id = run_id
        self.run_dir = Path(run_dir)
        self.output_dir = Path(output_dir)
        self.db_path = db_path
        self.logger = logger
        self.max_retries = max_retries
        self.backoff_seconds = backoff_seconds
        self.voice_map = voice_map or {}
        self.ffmpeg = _find_ffmpeg()

    def run(self, storyboard):
        shots = storyboard.get("shots") or storyboard.get("scenes") or []
        self.output_dir.mkdir(parents=True, exist_ok=True)
        records = []
        for shot in shots:
            shot_id = shot.get("shot_id")
            if not shot_id:
                continue
            characters = shot.get("characters") or []
            character_name = characters[0].get("name", "") if characters else ""
            dialogue = (
                shot.get("dialogue_text")
                or "".join(shot.get("dialogue") or [])
                or ""
            )
            voice = pick_voice(character_name, self.voice_map)
            existing = db.get_audio(self.db_path, self.run_id, shot_id)
            if (
                existing
                and existing["status"] == "done"
                and existing["audio_path"]
                and Path(existing["audio_path"]).exists()
            ):
                duration = mp3_duration(existing["audio_path"])
                if abs((duration or 0) - (existing.get("duration") or 0)) > 0.01:
                    db.upsert_audio(
                        self.db_path,
                        self.run_id,
                        shot_id,
                        existing["status"],
                        audio_path=existing["audio_path"],
                        duration=duration,
                        voice=existing.get("voice"),
                        error=existing.get("error"),
                        retries=existing.get("retries") or 0,
                    )
                    existing = {
                        **existing,
                        "duration": duration,
                    }
                records.append(
                    {
                        "shot_id": shot_id,
                        "audio_path": existing["audio_path"],
                        "duration": duration,
                        "voice": existing.get("voice"),
                        "status": existing["status"],
                    }
                )
                continue
            audio_path = self.output_dir / f"{shot_id}.mp3"
            if not dialogue.strip():
                try:
                    generate_silence_mp3(audio_path, 1.0, self.ffmpeg)
                    duration = mp3_duration(audio_path)
                    status = "done"
                    error = None
                    retries = 0
                except Exception as e:
                    status = "failed"
                    error = str(e)
                    duration = 0.0
                    retries = 1
                self.logger.info("shot %s silence placeholder done", shot_id)
            else:
                last_error = None
                duration = 0.0
                retries = 0
                success = False
                for attempt in range(1, self.max_retries + 1):
                    retries = attempt
                    try:
                        asyncio.run(
                            edge_tts.Communicate(dialogue, voice).save(str(audio_path))
                        )
                        if not audio_path.exists() or audio_path.stat().st_size < 100:
                            raise RuntimeError("TTS 输出为空")
                        duration = mp3_duration(audio_path)
                        success = True
                        break
                    except Exception as e:
                        last_error = e
                        self.logger.warning(
                            "TTS shot %s attempt %s/%s failed: %s",
                            shot_id,
                            attempt,
                            self.max_retries,
                            e,
                        )
                        if attempt < self.max_retries:
                            time.sleep(self.backoff_seconds * attempt)
                status = "done" if success else "failed"
                error = None if success else str(last_error)
            db.upsert_audio(
                self.db_path,
                self.run_id,
                shot_id,
                status,
                audio_path=str(audio_path) if status == "done" else None,
                duration=duration,
                voice=voice,
                error=error,
                retries=retries,
            )
            records.append(
                {
                    "shot_id": shot_id,
                    "audio_path": str(audio_path) if status == "done" else "",
                    "duration": duration,
                    "voice": voice,
                    "status": status,
                }
            )
        manifest = {
            "run_id": self.run_id,
            "generated_at": datetime.now().isoformat(timespec="seconds"),
            "summary": {
                "total": len(records),
                "done": sum(1 for r in records if r["status"] == "done"),
                "failed": sum(1 for r in records if r["status"] == "failed"),
            },
            "items": records,
        }
        manifest_path = self.output_dir / "audio_manifest.json"
        manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        self.logger.info(
            "TTS done: total=%s done=%s failed=%s manifest=%s",
            manifest["summary"]["total"],
            manifest["summary"]["done"],
            manifest["summary"]["failed"],
            manifest_path,
        )
        return records
