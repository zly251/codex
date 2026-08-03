import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.data import db
from app.subtitle.subtitle_agent import SubtitleAgent
from app.utils.logging import setup_logger


def main():
    parser = argparse.ArgumentParser(description="Subtitle Agent")
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--storyboard", help="storyboard.json path")
    parser.add_argument("--audio-manifest", help="audio_manifest.json path")
    parser.add_argument("--output", help="subtitle output dir")
    args = parser.parse_args()

    project_dir = Path(__file__).resolve().parent
    config = json.loads((project_dir / "config" / "config.json").read_text(encoding="utf-8"))
    data_dir = project_dir / config["paths"]["data_dir"]
    output_dir = project_dir / config["paths"]["output_dir"]
    db_path = data_dir / "manju.sqlite3"
    db.init_db(db_path)

    storyboard_path = (
        Path(args.storyboard)
        if args.storyboard
        else data_dir / "runs" / args.run_id / "storyboard.json"
    )
    audio_manifest_path = (
        Path(args.audio_manifest)
        if args.audio_manifest
        else output_dir / "audio" / "audio_manifest.json"
    )
    storyboard = json.loads(storyboard_path.read_text(encoding="utf-8"))
    audio_manifest = json.loads(audio_manifest_path.read_text(encoding="utf-8"))
    logger = setup_logger("manju-subtitle", data_dir / "logs")
    agent = SubtitleAgent(
        run_id=args.run_id,
        output_dir=Path(args.output) if args.output else output_dir / "subtitle",
        db_path=db_path,
        logger=logger,
    )
    records = agent.run(storyboard, audio_manifest)
    print(json.dumps(records, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
