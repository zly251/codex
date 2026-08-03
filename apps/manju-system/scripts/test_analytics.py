import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from app.analytics.analytics_agent import AnalyticsAgent
from app.data import db
from app.utils.logging import setup_logger

RUN_ID = "20260731_171708"
REQUIRED_KEYS = ["prediction_score", "real_score", "difference", "recommendations"]


def main():
    config = json.loads((PROJECT_ROOT / "config" / "config.json").read_text(encoding="utf-8"))
    data_dir = PROJECT_ROOT / config["paths"]["data_dir"]
    output_dir = PROJECT_ROOT / config["paths"]["output_dir"]
    db_path = data_dir / "manju.sqlite3"
    db.init_db(db_path)

    content_score = json.loads(
        (output_dir / "score" / "content_score.json").read_text(encoding="utf-8")
    )
    logger = setup_logger("manju-analytics-test", data_dir / "logs")
    agent = AnalyticsAgent(
        run_id=RUN_ID,
        output_dir=output_dir / "analytics",
        db_path=db_path,
        logger=logger,
    )
    report = agent.run(content_score, platform_data=None, force_simulate=True)

    checks = {
        "output_exists": (output_dir / "analytics" / "analytics_report.json").exists(),
        "required_keys": all(k in report for k in REQUIRED_KEYS),
        "scores_in_range": all(0 <= report[k] <= 100 for k in ["prediction_score", "real_score"]),
        "source_simulated": report.get("source") == "simulated",
        "db_video_metrics": False,
        "db_score_accuracy": False,
    }
    metrics_rows = db.get_video_metrics(db_path, RUN_ID)
    checks["db_video_metrics"] = any(r["source"] == "simulated" for r in metrics_rows)
    accuracy = db.get_score_accuracy(db_path, RUN_ID)
    checks["db_score_accuracy"] = bool(accuracy and accuracy["status"] == "done")

    result = {"checks": checks, "report": report, "db": {"video_metrics": metrics_rows}}
    (data_dir / "logs").mkdir(parents=True, exist_ok=True)
    (data_dir / "logs" / "analytics_test.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    failed = [k for k, v in checks.items() if not v]
    if failed:
        raise SystemExit(f"failed checks: {failed}")


if __name__ == "__main__":
    main()
