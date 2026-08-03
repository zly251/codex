import json
import re
import subprocess
from datetime import datetime
from pathlib import Path

from app.data import db

FONT_NAME = "Microsoft YaHei"

ASS_HEADER = """[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,{font},62,&H00FFFFFF,&H000000FF,&H00101010,&H80000000,-1,0,0,0,100,100,0,0,1,3,1.5,2,80,80,300,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def ass_time(seconds):
    seconds = max(0.0, seconds)
    hours = int(seconds // 3600)
    minutes = int(seconds % 3600 // 60)
    secs = int(seconds % 60)
    centis = int(round((seconds - int(seconds)) * 100))
    if centis == 100:
        secs += 1
        centis = 0
    return f"{hours}:{minutes:02d}:{secs:02d}.{centis:02d}"


def escape_ass_text(text):
    return text.replace("\\", "\\\\").replace("\n", "\\N").replace(",", "\\,")


def probe_duration(path):
    try:
        import imageio_ffmpeg

        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        ffmpeg = "ffmpeg"
    result = subprocess.run(
        [ffmpeg, "-i", str(path)],
        capture_output=True,
        text=True,
        timeout=20,
    )
    match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", result.stderr or "")
    if not match:
        raise RuntimeError("cannot read duration")
    hours, minutes, seconds = match.groups()
    return round(int(hours) * 3600 + int(minutes) * 60 + float(seconds), 3)


class SubtitleAgent:
    def __init__(self, run_id, output_dir, db_path, logger):
        self.run_id = run_id
        self.output_dir = Path(output_dir)
        self.db_path = db_path
        self.logger = logger

    def run(self, storyboard, audio_manifest):
        shots = storyboard.get("shots") or storyboard.get("scenes") or []
        audio_by_id = {item["shot_id"]: item for item in (audio_manifest.get("items") or [])}
        self.output_dir.mkdir(parents=True, exist_ok=True)
        events = []
        records = []
        cursor = 0.0
        for index, shot in enumerate(shots, 1):
            shot_id = shot.get("shot_id")
            if not shot_id:
                continue
            try:
                item = audio_by_id.get(shot_id)
                duration = 0.0
                if item and item.get("status") == "done":
                    duration = item.get("duration") or 0.0
                if not duration and item and item.get("audio_path"):
                    duration = probe_duration(item["audio_path"])
                if not duration:
                    raise RuntimeError("audio duration unavailable")
                start = cursor
                end = cursor + duration
                text = escape_ass_text(shot.get("dialogue_text") or "")
                events.append(
                    f"Dialogue: 0,{ass_time(start)},{ass_time(end)},Default,,0,0,0,,{text}"
                )
                db.upsert_subtitle(
                    self.db_path,
                    self.run_id,
                    shot_id,
                    "done",
                    start_sec=start,
                    end_sec=end,
                    duration=duration,
                    event_index=index,
                )
                records.append(
                    {
                        "shot_id": shot_id,
                        "start": start,
                        "end": end,
                        "duration": duration,
                        "status": "done",
                        "text": shot.get("dialogue_text") or "",
                    }
                )
                cursor = end
            except Exception as e:
                self.logger.error("subtitle shot %s failed: %s", shot_id, e)
                db.upsert_subtitle(
                    self.db_path,
                    self.run_id,
                    shot_id,
                    "failed",
                    error=str(e),
                )
                records.append({"shot_id": shot_id, "status": "failed", "error": str(e)})

        ass_path = self.output_dir / "episode.ass"
        ass_path.write_text(
            ASS_HEADER.format(font=FONT_NAME) + "\n".join(events) + "\n",
            encoding="utf-8",
        )
        manifest = {
            "run_id": self.run_id,
            "generated_at": datetime.now().isoformat(timespec="seconds"),
            "total_duration": round(cursor, 3),
            "summary": {
                "total": len(records),
                "done": sum(1 for r in records if r["status"] == "done"),
                "failed": sum(1 for r in records if r["status"] == "failed"),
            },
            "items": records,
        }
        manifest_path = self.output_dir / "subtitle_manifest.json"
        manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        self.logger.info(
            "subtitle done: total=%s done=%s failed=%s ass=%s",
            manifest["summary"]["total"],
            manifest["summary"]["done"],
            manifest["summary"]["failed"],
            ass_path,
        )
        return records
