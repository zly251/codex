import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from app.content_qa.content_qa_agent import ContentScoreAgent
from app.data import db
from app.utils.logging import setup_logger

RUN_ID = "20260731_171708"
REQUIRED_KEYS = [
    "hook_score",
    "story_score",
    "visual_score",
    "title_score",
    "overall_score",
    "problems",
    "suggestions",
]


def main():
    config = json.loads((PROJECT_ROOT / "config" / "config.json").read_text(encoding="utf-8"))
    data_dir = PROJECT_ROOT / config["paths"]["data_dir"]
    output_dir = PROJECT_ROOT / config["paths"]["output_dir"]
    db_path = data_dir / "manju.sqlite3"
    db.init_db(db_path)
    run_dir = data_dir / "runs" / RUN_ID

    logger = setup_logger("manju-content-score-test", data_dir / "logs")
    agent = ContentScoreAgent(
        run_id=RUN_ID,
        output_dir=output_dir / "score",
        db_path=db_path,
        logger=logger,
        tmp_dir=data_dir / "logs",
    )
    result = agent.run(
        run_dir / "script.json",
        run_dir / "storyboard.json",
        output_dir / "video" / "episode_final.mp4",
        output_dir / "cover" / "cover.jpg",
        output_dir / "subtitle" / "subtitle_manifest.json",
        output_dir / "audio" / "audio_manifest.json",
    )

    checks = {
        "output_exists": (output_dir / "score" / "content_score.json").exists(),
        "required_keys": all(k in result for k in REQUIRED_KEYS),
        "scores_in_range": all(
            0 <= result[k] <= 100
            for k in ["hook_score", "story_score", "visual_score", "title_score", "overall_score"]
        ),
        "db_row_done": False,
    }
    row = db.get_content_score(db_path, RUN_ID)
    checks["db_row_done"] = bool(row and row["status"] == "done")

    report = {"checks": checks, "result": result}
    (data_dir / "logs").mkdir(parents=True, exist_ok=True)
    (data_dir / "logs" / "content_score_test.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    failed = [k for k, v in checks.items() if not v]
    if failed:
        raise SystemExit(f"failed checks: {failed}")


if __name__ == "__main__":
    main()
