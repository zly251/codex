import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.content_qa.content_qa_agent import ContentScoreAgent
from app.data import db
from app.utils.logging import setup_logger


def main():
    parser = argparse.ArgumentParser(description="Content Score Agent")
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--script", help="script.json path")
    parser.add_argument("--storyboard", help="storyboard.json path")
    parser.add_argument("--video", help="episode_final.mp4 path")
    parser.add_argument("--cover", help="cover.jpg path")
    parser.add_argument("--subtitle-manifest", help="subtitle_manifest.json path")
    parser.add_argument("--audio-manifest", help="audio_manifest.json path")
    parser.add_argument("--output", help="score output dir")
    args = parser.parse_args()

    project_dir = Path(__file__).resolve().parent
    config = json.loads((project_dir / "config" / "config.json").read_text(encoding="utf-8"))
    data_dir = project_dir / config["paths"]["data_dir"]
    output_dir = project_dir / config["paths"]["output_dir"]
    db_path = data_dir / "manju.sqlite3"
    db.init_db(db_path)
    run_dir = data_dir / "runs" / args.run_id

    script_path = Path(args.script) if args.script else run_dir / "script.json"
    storyboard_path = Path(args.storyboard) if args.storyboard else run_dir / "storyboard.json"
    video_path = Path(args.video) if args.video else output_dir / "video" / "episode_final.mp4"
    cover_path = Path(args.cover) if args.cover else output_dir / "cover" / "cover.jpg"
    subtitle_manifest_path = (
        Path(args.subtitle_manifest)
        if args.subtitle_manifest
        else output_dir / "subtitle" / "subtitle_manifest.json"
    )
    audio_manifest_path = (
        Path(args.audio_manifest)
        if args.audio_manifest
        else output_dir / "audio" / "audio_manifest.json"
    )
    for path in [
        script_path,
        storyboard_path,
        video_path,
        cover_path,
        subtitle_manifest_path,
        audio_manifest_path,
    ]:
        if not path.exists():
            raise SystemExit(f"input missing: {path}")

    logger = setup_logger("manju-content-score", data_dir / "logs")
    agent = ContentScoreAgent(
        run_id=args.run_id,
        output_dir=Path(args.output) if args.output else output_dir / "score",
        db_path=db_path,
        logger=logger,
        tmp_dir=data_dir / "logs",
    )
    result = agent.run(
        script_path,
        storyboard_path,
        video_path,
        cover_path,
        subtitle_manifest_path,
        audio_manifest_path,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
