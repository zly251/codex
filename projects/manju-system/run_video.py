import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.data import db
from app.utils.logging import setup_logger
from app.video.video_editor import VideoEditor


def main():
    parser = argparse.ArgumentParser(description="Video Editor")
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--audio-manifest", help="audio_manifest.json path")
    parser.add_argument("--subtitle", help="episode.ass path")
    args = parser.parse_args()

    project_dir = Path(__file__).resolve().parent
    config = json.loads(
        (project_dir / "config" / "config.json").read_text(encoding="utf-8")
    )
    data_dir = project_dir / config["paths"]["data_dir"]
    output_dir = project_dir / config["paths"]["output_dir"]
    db_path = data_dir / "manju.sqlite3"
    db.init_db(db_path)

    shot_images = [
        {"shot_id": row["shot_id"], "image_path": row["image_path"]}
        for row in db.list_shots(db_path, args.run_id)
        if row.get("image_path") and Path(row["image_path"]).exists()
    ]
    if not shot_images:
        raise SystemExit(f"no rendered images found for run {args.run_id}")

    audio_manifest_path = (
        Path(args.audio_manifest)
        if args.audio_manifest
        else output_dir / "audio" / "audio_manifest.json"
    )
    audio_manifest = json.loads(
        audio_manifest_path.read_text(encoding="utf-8")
    )
    subtitle_path = (
        Path(args.subtitle)
        if args.subtitle
        else output_dir / "subtitle" / "episode.ass"
    )
    if not subtitle_path.exists():
        raise SystemExit(f"subtitle file missing: {subtitle_path}")

    logger = setup_logger("manju-video", data_dir / "logs")
    video_dir = output_dir / "video"
    work_dir = video_dir / "work" / args.run_id
    work_dir.mkdir(parents=True, exist_ok=True)
    editor = VideoEditor(
        run_id=args.run_id,
        video_dir=video_dir,
        work_dir=work_dir,
        db_path=db_path,
        logger=logger,
        subtitle_path=subtitle_path,
    )
    report = editor.run(shot_images, audio_manifest)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
