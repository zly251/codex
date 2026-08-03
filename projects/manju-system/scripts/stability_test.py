import json
import re
import sqlite3
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

TEST_ROOT = PROJECT_ROOT / "data" / "stability-test"
FAULTS = {
    "llm_timeout_transient": {3, 9, 11},
    "llm_timeout_persistent": {15, 16, 17},
    "llm_json_transient": {5, 20},
    "llm_json_persistent": {22, 23, 24},
    "render_offline": {8, 9, 10, 11},
    "render_single_fail": {3, 17, 26},
}


def prepare_project():
    (TEST_ROOT / "config").mkdir(parents=True, exist_ok=True)
    (TEST_ROOT / "data").mkdir(parents=True, exist_ok=True)
    (TEST_ROOT / "output").mkdir(parents=True, exist_ok=True)
    prod_cfg = json.loads(
        (PROJECT_ROOT / "config" / "config.json").read_text(encoding="utf-8")
    )
    cfg = json.loads(json.dumps(prod_cfg))
    cfg["paths"] = {"data_dir": "data", "output_dir": "output"}
    (TEST_ROOT / "config" / "config.json").write_text(
        json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def install_faults(state):
    import httpx
    from PIL import Image

    from app.comfy.client import ComfyClient
    from app.utils.deepseek_client import DeepSeekClient

    orig_chat = DeepSeekClient.chat

    def chat_wrapper(self, messages, temperature=1.0):
        state["llm_calls"] += 1
        n = state["llm_calls"]
        if state.get("faults_disabled"):
            return orig_chat(self, messages, temperature)
        if n in FAULTS["llm_timeout_persistent"] or n in FAULTS["llm_timeout_transient"]:
            raise httpx.TimeoutException("simulated DeepSeek timeout")
        if n in FAULTS["llm_json_persistent"] or n in FAULTS["llm_json_transient"]:
            return "not-json{{{"
        return orig_chat(self, messages, temperature)

    orig_generate = ComfyClient.generate

    def generate_wrapper(self, shot, filename_prefix=""):
        state["render_calls"] += 1
        n = state["render_calls"]
        if not state.get("faults_disabled"):
            if n in FAULTS["render_offline"]:
                raise RuntimeError("simulated ComfyUI interruption")
            if n in FAULTS["render_single_fail"]:
                raise RuntimeError("simulated single image failure")
        run_id = filename_prefix
        shot_id = shot["shot_id"]
        seed = shot.get("seed") or 0
        out_dir = Path(self.output_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        image_path = out_dir / f"{run_id}_{shot_id}_seed{seed}.png"
        color = (seed % 256, (seed // 256) % 256, (seed // 65536) % 256)
        Image.new("RGB", (64, 64), color).save(image_path)
        return {
            "shot_id": shot_id,
            "prompt_id": f"sim-{n}",
            "seed": seed,
            "image_path": str(image_path),
            "filename": image_path.name,
        }

    DeepSeekClient.chat = chat_wrapper
    ComfyClient.generate = generate_wrapper


def run_episodes(state):
    from app.orchestration import pipeline as pipeline_mod

    episodes = []
    for i in range(1, 11):
        topic = f"稳定性测试第{i}集：一个外卖员发现自己是星际舰队继承人"
        p = pipeline_mod.Pipeline(project_dir=TEST_ROOT)
        try:
            summary = p.run(topic)
            episodes.append(
                {"episode": i, "run_id": summary["run_id"], "initial_status": summary["status"]}
            )
        except Exception as e:
            episodes.append(
                {
                    "episode": i,
                    "run_id": p.run_id,
                    "initial_status": "failed",
                    "initial_error": f"{type(e).__name__}: {e}",
                }
            )
    return episodes


def resume_unfinished(state, episodes):
    from app.orchestration import pipeline as pipeline_mod

    state["faults_disabled"] = True
    for ep in episodes:
        if ep["initial_status"] == "done":
            ep["final_status"] = "done"
            continue
        p = pipeline_mod.Pipeline(project_dir=TEST_ROOT)
        try:
            summary = p.run("", resume_run_id=ep["run_id"])
            ep["final_status"] = summary["status"]
        except Exception as e:
            ep["final_status"] = "failed"
            ep["final_error"] = f"{type(e).__name__}: {e}"


def classify(error_text):
    text = error_text or ""
    if not text:
        return None
    if "simulated ComfyUI interruption" in text:
        return "ComfyUI中断"
    if "simulated single image failure" in text:
        return "单张图片失败"
    if "simulated DeepSeek timeout" in text or "timeout" in text.lower():
        return "DeepSeek超时"
    if "not-json" in text or "JSON" in text:
        return "JSON格式错误"
    return "其他"


def analyze(state, episodes):
    db_path = TEST_ROOT / "data" / "manju.sqlite3"
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    runs = [dict(r) for r in conn.execute("SELECT id, topic, status, error FROM runs ORDER BY created_at")]
    steps = [dict(r) for r in conn.execute("SELECT run_id, step_name, status, error, retries FROM steps ORDER BY run_id, id")]
    shots = [dict(r) for r in conn.execute("SELECT run_id, shot_id, status, image_path, error FROM shots ORDER BY run_id, id")]
    conn.close()

    image_files = sorted((TEST_ROOT / "output" / "images").glob("*.png"))
    referenced = {Path(s["image_path"]).name for s in shots if s["image_path"]}
    disk_names = [f.name for f in image_files]
    duplicates_on_disk = {
        name: count for name, count in sorted({n: disk_names.count(n) for n in set(disk_names)}.items()) if count > 1
    }
    orphan_files = [f.name for f in image_files if f.name not in referenced]
    from collections import Counter

    path_counter = Counter(s["image_path"] for s in shots if s["image_path"])
    dup_image_paths = {p: c for p, c in path_counter.items() if c > 1}

    allowed_status = {"pending", "running", "done", "error", "partial", "failed"}
    invalid_rows = {
        "runs": [r["id"] for r in runs if r["status"] not in allowed_status],
        "steps": [f'{r["run_id"]}/{r["step_name"]}' for r in steps if r["status"] not in allowed_status],
        "shots": [f'{r["run_id"]}/{r["shot_id"]}' for r in shots if r["status"] not in allowed_status],
    }
    stuck_running = {
        "runs": [r["id"] for r in runs if r["status"] == "running"],
        "steps": [f'{r["run_id"]}/{r["step_name"]}' for r in steps if r["status"] == "running"],
        "shots": [f'{r["run_id"]}/{r["shot_id"]}' for r in shots if r["status"] == "running"],
    }

    failure_stats = {}
    log_text = (TEST_ROOT / "data" / "logs" / "pipeline.log").read_text(
        encoding="utf-8", errors="replace"
    )

    def add_stat(text):
        key = classify(text)
        if key:
            failure_stats[key] = failure_stats.get(key, 0) + 1

    for r in runs:
        if r["status"] == "error":
            add_stat(r["error"])
    for r in steps:
        if r["status"] == "error":
            add_stat(r["error"])
    for r in shots:
        if r["status"] == "error":
            add_stat(r["error"])
    for m in re.finditer(r"\[ERROR\] manju: shot \S+ failed: (.+)", log_text):
        add_stat(m.group(1))
    for m in re.finditer(r"\[ERROR\] manju: pipeline failed: (.+)", log_text):
        add_stat(m.group(1))

    attempt1_warnings = len(
        re.findall(r"\[WARNING\] manju: DeepSeek 调用失败 attempt=1/3", log_text)
    )
    persistent_fails = sum(
        1
        for m in re.finditer(r"\[ERROR\] manju: pipeline failed: (.+)", log_text)
        if "DeepSeek" in m.group(1)
    )
    auto_recovered = max(attempt1_warnings - persistent_fails, 0)

    report = {
        "episodes": episodes,
        "llm_calls": state["llm_calls"],
        "render_calls": state["render_calls"],
        "initial_success": sum(1 for e in episodes if e["initial_status"] == "done"),
        "final_success": sum(1 for e in episodes if e.get("final_status", e["initial_status"]) == "done"),
        "total": len(episodes),
        "failure_stats": failure_stats,
        "auto_recovered_transient_faults": auto_recovered,
        "db_pollution": {
            "invalid_status_rows": invalid_rows,
            "stuck_running": stuck_running,
            "duplicate_image_paths": dup_image_paths,
        },
        "file_duplicates": {
            "duplicate_filenames": duplicates_on_disk,
            "orphan_files": orphan_files,
        },
        "counts": {
            "runs": len(runs),
            "steps": len(steps),
            "shots": len(shots),
            "images": len(image_files),
        },
    }
    (TEST_ROOT / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return report


def main():
    if "--analyze-only" in sys.argv:
        report = json.loads((TEST_ROOT / "report.json").read_text(encoding="utf-8"))
        state = {"llm_calls": report["llm_calls"], "render_calls": report["render_calls"]}
        new_report = analyze(state, report["episodes"])
        print(json.dumps(new_report, ensure_ascii=False, indent=2))
        return
    prepare_project()
    state = {"llm_calls": 0, "render_calls": 0, "faults_disabled": False}
    install_faults(state)
    episodes = run_episodes(state)
    resume_unfinished(state, episodes)
    report = analyze(state, episodes)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
