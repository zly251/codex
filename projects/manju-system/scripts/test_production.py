import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from app.agents.script_writer import AgentScriptWriter
from app.orchestration.production_runner import ProductionRunner

EXISTING_TOPIC = "一个穷女孩发现自己是豪门继承人"
FAILING_TOPIC = "故意失败选题"


def main():
    runner = ProductionRunner(project_dir=PROJECT_ROOT)
    original_run = AgentScriptWriter.run

    def fake_run(self, topic):
        if topic == EXISTING_TOPIC:
            return original_run(self, topic)
        raise RuntimeError("forced script failure for production test")

    AgentScriptWriter.run = fake_run
    try:
        report = runner.run(
            [EXISTING_TOPIC, FAILING_TOPIC],
            resume=True,
            limit=2,
        )
    finally:
        AgentScriptWriter.run = original_run

    summary = report["summary"]
    checks = {
        "report_exists": runner.report_path.exists(),
        "success_count": summary["success"] >= 1,
        "failed_count": summary["failed"] >= 1,
        "avg_duration_nonnegative": summary["avg_duration_seconds"] >= 0,
        "avg_score_positive": summary["avg_score"] > 0,
        "failure_stage_script_writer": report.get("failure_stages", {}).get(
            "script_writer", 0
        )
        >= 1,
        "independent_run_ids": len({r["run_id"] for r in report["topics"]}) >= 2,
    }
    result = {"checks": checks, "report": report}
    (PROJECT_ROOT / "data" / "logs").mkdir(parents=True, exist_ok=True)
    (PROJECT_ROOT / "data" / "logs" / "production_test.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    failed = [k for k, v in checks.items() if not v]
    if failed:
        raise SystemExit(f"failed checks: {failed}")


if __name__ == "__main__":
    main()
