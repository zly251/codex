import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

import edge_tts
from app.data import db
from app.utils.logging import setup_logger
from app.voice.tts_agent import TTSAgent


def main():
    config = json.loads((PROJECT_ROOT / "config" / "config.json").read_text(encoding="utf-8"))
    data_dir = PROJECT_ROOT / config["paths"]["data_dir"]
    output_dir = PROJECT_ROOT / config["paths"]["output_dir"]
    db_path = data_dir / "manju.sqlite3"
    db.init_db(db_path)
    run_id = "20260731_171708"
    storyboard = json.loads(
        (data_dir / "runs" / run_id / "storyboard.json").read_text(encoding="utf-8")
    )
    logger = setup_logger("manju-tts-test", data_dir / "logs")

    shots = storyboard.get("shots") or storyboard.get("scenes") or []
    target = next(
        (s["shot_id"] for s in shots if (s.get("dialogue_text") or "").strip()),
        None,
    )

    with db._connect(db_path) as conn:
        conn.execute("DELETE FROM audio WHERE run_id = ?", (run_id,))

    def make_agent():
        return TTSAgent(
            run_id=run_id,
            run_dir=data_dir / "runs" / run_id,
            output_dir=output_dir / "audio",
            db_path=db_path,
            logger=logger,
            max_retries=1,
            backoff_seconds=0,
        )

    orig_save = edge_tts.Communicate.save

    def fail_save(self, path):
        if target and target in str(path):
            raise RuntimeError("simulated TTS failure")
        return orig_save(self, path)

    edge_tts.Communicate.save = fail_save
    try:
        records1 = make_agent().run(storyboard)
    finally:
        edge_tts.Communicate.save = orig_save
    shot1 = next(r for r in records1 if r["shot_id"] == target)
    others_done = all(r["status"] == "done" for r in records1 if r["shot_id"] != target)

    records2 = make_agent().run(storyboard)
    shot2 = next(r for r in records2 if r["shot_id"] == target)
    all_done = all(r["status"] == "done" for r in records2)
    rows = db.list_audio(db_path, run_id)

    report = {
        "target_shot": target,
        "stage1": {"target_status": shot1["status"], "others_done": others_done},
        "stage2": {"target_status": shot2["status"], "all_done": all_done},
        "db_rows": len(rows),
    }
    (PROJECT_ROOT / "data" / "logs").mkdir(parents=True, exist_ok=True)
    (PROJECT_ROOT / "data" / "logs" / "tts_failure_test.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
