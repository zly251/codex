import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from app.visual_judge import VisualJudgeAgent

RUN_ID = "20260731_171708"


def main():
    config = json.loads(
        (PROJECT_ROOT / "config" / "config.json").read_text(encoding="utf-8")
    )
    agent = VisualJudgeAgent(PROJECT_ROOT, config)
    report = agent.run(RUN_ID)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    report_path = (
        PROJECT_ROOT / "output" / "review" / RUN_ID / "visual_judge.json"
    )
    if not report_path.exists():
        raise SystemExit("visual_judge.json not written")
    saved = json.loads(report_path.read_text(encoding="utf-8"))
    if saved.get("status") != "done":
        raise SystemExit(f"visual judge status={saved.get('status')}")
    required = [
        "character_consistency",
        "scene_specificity",
        "composition",
        "commercial_quality",
    ]
    missing = [k for k in required if saved.get("scores", {}).get(k) is None]
    if missing:
        raise SystemExit(f"missing scores: {missing}")
    print("visual judge test passed")


if __name__ == "__main__":
    main()
