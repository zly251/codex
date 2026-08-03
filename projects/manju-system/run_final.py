import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.cover.cover_agent import CoverAgent
from app.data import db
from app.utils.logging import setup_logger
from app.video.enhanced_editor import EnhancedVideoEditor, probe_duration


def main():
    parser = argparse.ArgumentParser(description="M4 final video")
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

    logger = setup_logger("manju-final", data_dir / "logs")
    topic = None
    conn_row = db._connect(db_path)
    try:
        row = conn_row.execute(
            "SELECT topic FROM runs WHERE id = ?", (args.run_id,)
        ).fetchone()
        topic = dict(row)["topic"] if row else None
    finally:
        conn_row.close()

    cover_dir = output_dir / "cover"
    cover_agent = CoverAgent(
        run_id=args.run_id,
        output_dir=cover_dir,
        db_path=db_path,
        logger=logger,
    )
    cover_report = cover_agent.run(shot_images[0]["image_path"], topic)

    video_dir = output_dir / "video"
    work_dir = video_dir / "final_work" / args.run_id
    editor = EnhancedVideoEditor(
        run_id=args.run_id,
        video_dir=video_dir,
        work_dir=work_dir,
        db_path=db_path,
        logger=logger,
        subtitle_path=subtitle_path,
    )
    final_report = editor.run(shot_images, audio_manifest)

    draft_path = video_dir / "episode_draft.mp4"
    draft_report = None
    if draft_path.exists():
        draft_report = {
            "path": str(draft_path),
            "size_bytes": draft_path.stat().st_size,
            "duration": probe_duration(draft_path),
        }
    report = {
        "cover": cover_report,
        "final": final_report,
        "draft": draft_report,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
