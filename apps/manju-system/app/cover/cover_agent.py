import json
import subprocess
from pathlib import Path

from app.data import db

COVER_WIDTH = 1080
COVER_HEIGHT = 1440
BASE_TAGS = ["漫剧", "短剧", "AI生成"]
TAG_KEYWORDS = {
    "豪门": "豪门",
    "继承": "逆袭",
    "逆袭": "逆袭",
    "穷": "逆袭",
    "爱情": "爱情",
    "总裁": "霸总",
    "复仇": "复仇",
    "穿越": "穿越",
    "重生": "重生",
    "悬疑": "悬疑",
}


def build_tags(topic):
    tags = list(BASE_TAGS)
    for keyword, tag in TAG_KEYWORDS.items():
        if keyword in (topic or "") and tag not in tags:
            tags.append(tag)
    return tags


class CoverAgent:
    def __init__(self, run_id, output_dir, db_path, logger, ffmpeg=None):
        self.run_id = run_id
        self.output_dir = Path(output_dir)
        self.db_path = db_path
        self.logger = logger
        if ffmpeg is None:
            try:
                import imageio_ffmpeg

                ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
            except Exception:
                ffmpeg = "ffmpeg"
        self.ffmpeg = ffmpeg

    def run(self, first_image_path, topic):
        existing = db.get_cover(self.db_path, self.run_id)
        cover_path = self.output_dir / "cover.jpg"
        title_path = self.output_dir / "title.txt"
        tags_path = self.output_dir / "tags.json"
        if (
            existing
            and existing["status"] == "done"
            and cover_path.exists()
            and title_path.exists()
            and tags_path.exists()
        ):
            self.logger.info("cover already done, skip")
            return {
                "cover_path": str(cover_path),
                "title_path": str(title_path),
                "tags_path": str(tags_path),
                "status": "done",
                "resumed": True,
            }

        self.output_dir.mkdir(parents=True, exist_ok=True)
        tags = build_tags(topic)
        try:
            vf = (
                f"scale={COVER_WIDTH}:{COVER_HEIGHT}:force_original_aspect_ratio=decrease,"
                f"pad={COVER_WIDTH}:{COVER_HEIGHT}:(ow-iw)/2:(oh-ih)/2,"
                "eq=contrast=1.03:saturation=1.08"
            )
            result = subprocess.run(
                [
                    self.ffmpeg,
                    "-y",
                    "-i",
                    str(first_image_path),
                    "-vf",
                    vf,
                    "-frames:v",
                    "1",
                    "-q:v",
                    "3",
                    str(cover_path),
                ],
                capture_output=True,
                text=True,
                timeout=120,
            )
            if result.returncode != 0:
                raise RuntimeError((result.stderr or result.stdout)[-1500:])
            title_path.write_text((topic or "AI漫剧").strip(), encoding="utf-8")
            tags_path.write_text(json.dumps(tags, ensure_ascii=False, indent=2), encoding="utf-8")
            db.upsert_cover(
                self.db_path,
                self.run_id,
                "done",
                cover_path=str(cover_path),
                title_path=str(title_path),
                tags_path=str(tags_path),
                title=topic or "AI漫剧",
                tags=json.dumps(tags, ensure_ascii=False),
            )
        except Exception as e:
            db.upsert_cover(
                self.db_path,
                self.run_id,
                "failed",
                error=str(e),
            )
            raise

        report = {
            "cover_path": str(cover_path),
            "title_path": str(title_path),
            "tags_path": str(tags_path),
            "title": topic or "AI漫剧",
            "tags": tags,
            "status": "done",
        }
        self.logger.info(
            "cover done: %s %s %s",
            cover_path,
            title_path,
            tags_path,
        )
        return report
