import json
import re
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from app.data import db

RUN_ID = "20260731_171708"


def probe(path):
    import imageio_ffmpeg

    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    result = subprocess.run(
        [ffmpeg, "-i", str(path)],
        capture_output=True,
        text=True,
        timeout=30,
    )
    text = result.stderr or result.stdout
    duration = None
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", text)
    if m:
        h, mi, s = m.groups()
        duration = round(int(h) * 3600 + int(mi) * 60 + float(s), 3)
    streams = []
    for line in text.splitlines():
        if "Video:" in line and "Stream #" in line:
            streams.append({"type": "video", "detail": line.strip()})
        elif "Audio:" in line and "Stream #" in line:
            streams.append({"type": "audio", "detail": line.strip()})
    return {"duration": duration, "streams": streams}


def main():
    config = json.loads((PROJECT_ROOT / "config" / "config.json").read_text(encoding="utf-8"))
    data_dir = PROJECT_ROOT / config["paths"]["data_dir"]
    output_dir = PROJECT_ROOT / config["paths"]["output_dir"]
    db_path = data_dir / "manju.sqlite3"
    db.init_db(db_path)

    draft = output_dir / "video" / "episode_draft.mp4"
    final = output_dir / "video" / "episode_final.mp4"
    cover = output_dir / "cover"
    checks = {
        "final_exists": final.exists(),
        "draft_exists": draft.exists(),
        "cover_jpg": (cover / "cover.jpg").exists(),
        "title_txt": (cover / "title.txt").exists(),
        "tags_json": (cover / "tags.json").exists(),
        "db_final_video": False,
        "db_cover": False,
    }
    final_info = probe(final) if final.exists() else {}
    draft_info = probe(draft) if draft.exists() else {}

    final_row = db.get_final_video(db_path, RUN_ID)
    cover_row = db.get_cover(db_path, RUN_ID)
    checks["db_final_video"] = bool(final_row and final_row["status"] == "done")
    checks["db_cover"] = bool(cover_row and cover_row["status"] == "done")

    tags = json.loads((cover / "tags.json").read_text(encoding="utf-8"))
    title = (cover / "title.txt").read_text(encoding="utf-8").strip()
    compare = {
        "draft": {
            "size_bytes": draft.stat().st_size if draft.exists() else None,
            "duration": draft_info.get("duration"),
            "video": next(
                (s["detail"] for s in draft_info.get("streams", []) if s["type"] == "video"),
                None,
            ),
            "audio": next(
                (s["detail"] for s in draft_info.get("streams", []) if s["type"] == "audio"),
                None,
            ),
        },
        "final": {
            "size_bytes": final.stat().st_size if final.exists() else None,
            "duration": final_info.get("duration"),
            "video": next(
                (s["detail"] for s in final_info.get("streams", []) if s["type"] == "video"),
                None,
            ),
            "audio": next(
                (s["detail"] for s in final_info.get("streams", []) if s["type"] == "audio"),
                None,
            ),
        },
        "cover": {
            "title": title,
            "tags": tags,
        },
        "effects": json.loads(final_row["effects"])
        if final_row and final_row.get("effects")
        else {},
    }
    report = {"checks": checks, "compare": compare}
    (PROJECT_ROOT / "data" / "logs").mkdir(parents=True, exist_ok=True)
    (PROJECT_ROOT / "data" / "logs" / "m4_final_test.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))

    failed = [k for k, v in checks.items() if not v]
    if failed:
        raise SystemExit(f"failed checks: {failed}")


if __name__ == "__main__":
    main()
