import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.analytics.analytics_agent import AnalyticsAgent
from app.data import db
from app.utils.logging import setup_logger


def main():
    parser = argparse.ArgumentParser(description="Analytics Agent")
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--content-score", help="content_score.json path")
    parser.add_argument("--platform-data", help="platform metrics JSON path")
    parser.add_argument("--simulate", action="store_true", help="force simulated data")
    parser.add_argument("--output", help="analytics output dir")
    args = parser.parse_args()

    project_dir = Path(__file__).resolve().parent
    config = json.loads((project_dir / "config" / "config.json").read_text(encoding="utf-8"))
    data_dir = project_dir / config["paths"]["data_dir"]
    output_dir = project_dir / config["paths"]["output_dir"]
    db_path = data_dir / "manju.sqlite3"
    db.init_db(db_path)

    content_score_path = (
        Path(args.content_score)
        if args.content_score
        else output_dir / "score" / "content_score.json"
    )
    if not content_score_path.exists():
        raise SystemExit(f"content score missing: {content_score_path}")
    content_score = json.loads(content_score_path.read_text(encoding="utf-8"))

    platform_data = None
    if args.platform_data and not args.simulate:
        platform_path = Path(args.platform_data)
        if not platform_path.exists():
            raise SystemExit(f"platform data missing: {platform_path}")
        platform_data = json.loads(platform_path.read_text(encoding="utf-8"))

    logger = setup_logger("manju-analytics", data_dir / "logs")
    agent = AnalyticsAgent(
        run_id=args.run_id,
        output_dir=Path(args.output) if args.output else output_dir / "analytics",
        db_path=db_path,
        logger=logger,
    )
    report = agent.run(
        content_score,
        platform_data=platform_data,
        force_simulate=args.simulate,
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
