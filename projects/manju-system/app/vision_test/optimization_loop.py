import argparse
import json
import shutil
import sys
from datetime import datetime
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_DIR))

from app.comfy.client import ComfyClient
from app.vision_test.prompt_feedback import PromptFeedback
from app.vision_test.visual_issue_classifier import VisualIssueClassifier
from app.vision_test.vision_judge import VisionJudge


def load_config():
    return json.loads(
        (PROJECT_DIR / "config" / "config.json").read_text(encoding="utf-8")
    )


def load_json(path):
    path = Path(path)
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def composite_score(report):
    return round(
        (
            report["character_quality"]
            + report["scene_quality"]
            + report["composition_quality"]
            + (100 - report["ai_artifact_score"])
        )
        / 4,
        2,
    )


def build_shot(optimized, config, visual_action=None):
    comfy_cfg = config["comfy"]
    seed = int(optimized.get("seed") or 12345)
    render_strategy = (visual_action or {}).get("render_strategy", {})
    if render_strategy.get("change_seed"):
        seed = (seed + 777) % (2 ** 32)
    return {
        "shot_id": optimized.get("shot_id"),
        "positive": optimized["positive"],
        "negative": optimized["negative"],
        "checkpoint": comfy_cfg.get("checkpoint"),
        "width": comfy_cfg.get("width", 768),
        "height": comfy_cfg.get("height", 1344),
        "steps": comfy_cfg.get("steps", 20),
        "cfg": comfy_cfg.get("cfg", 7.0),
        "sampler": comfy_cfg.get("sampler", "euler"),
        "scheduler": comfy_cfg.get("scheduler", "normal"),
        "seed": seed,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-id", default="20260731_171708")
    parser.add_argument("--shot-id", default="shot_013")
    parser.add_argument("--image-path", default="")
    parser.add_argument("--prompt-path", default="")
    parser.add_argument("--output-dir", default="")
    parser.add_argument("--v3-image-path", default="")
    args = parser.parse_args()

    run_dir = PROJECT_DIR / "data" / "runs" / args.run_id
    v2_dir = run_dir / "v2"
    image_path = (
        Path(args.image_path)
        if args.image_path
        else PROJECT_DIR / "output" / "v2_images" / args.run_id / f"{args.shot_id}.png"
    )
    prompt_path = (
        Path(args.prompt_path)
        if args.prompt_path
        else v2_dir / "v2_prompts.json"
    )
    output_dir = (
        Path(args.output_dir)
        if args.output_dir
        else PROJECT_DIR / "data" / "vision_test" / "v3"
    )
    v3_image_path = (
        Path(args.v3_image_path)
        if args.v3_image_path
        else PROJECT_DIR / "output" / "vision_test" / args.run_id / f"{args.shot_id}_v3.png"
    )

    prompts = load_json(prompt_path)
    if not prompts:
        raise FileNotFoundError(f"prompt file not found: {prompt_path}")
    shot = next(
        (
            s
            for s in prompts.get("shots", [])
            if s.get("shot_id") == args.shot_id
        ),
        None,
    )
    if not shot:
        raise ValueError(f"shot {args.shot_id} not found in {prompt_path}")

    judge = VisionJudge()
    feedback = PromptFeedback()
    now = datetime.now().isoformat(timespec="seconds")

    before = judge.judge(image_path, shot)
    output_dir.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(image_path, output_dir / "before.png")
    before_report = {
        "shot_id": args.shot_id,
        "image_path": str(image_path),
        "model": judge.model,
        "status": "done",
        "generated_at": now,
        "current_prompt": shot,
        **before,
    }
    save_json(output_dir / "before_report.json", before_report)

    visual_action = VisualIssueClassifier().classify(before)
    save_json(output_dir / "visual_action.json", visual_action)

    optimized = feedback.generate(shot, before)
    optimized_prompt = {
        "shot_id": args.shot_id,
        "model": feedback.model,
        "status": "done",
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        **optimized,
    }
    save_json(output_dir / "optimized_prompt.json", optimized_prompt)

    config = load_config()
    comfy_cfg = config["comfy"]
    comfy = ComfyClient(
        base_url=comfy_cfg["base_url"],
        checkpoint=comfy_cfg["checkpoint"],
        output_dir=v3_image_path.parent,
        timeout_seconds=comfy_cfg["timeout_seconds"],
    )
    comfy.check_ready()
    comfy.ensure_checkpoint()
    render_result = comfy.generate(
        build_shot(optimized, config, visual_action), filename_prefix="v3"
    )
    v3_image_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(render_result["image_path"], v3_image_path)
    shutil.copyfile(v3_image_path, output_dir / "after.png")
    raw_image_path = Path(render_result["image_path"])
    if raw_image_path.resolve() != v3_image_path.resolve() and raw_image_path.exists():
        raw_image_path.unlink(missing_ok=True)

    after = judge.judge(v3_image_path, optimized)
    after_report = {
        "shot_id": args.shot_id,
        "image_path": str(v3_image_path),
        "model": judge.model,
        "status": "done",
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "current_prompt": optimized,
        **after,
    }
    save_json(output_dir / "after_report.json", after_report)

    before_scores = {key: before[key] for key in (
        "character_quality",
        "scene_quality",
        "composition_quality",
        "ai_artifact_score",
    )}
    after_scores = {key: after[key] for key in before_scores}
    reason = []
    before_reason = "；".join(before["problems"])
    after_reason = "；".join(after["problems"])
    if before_reason:
        reason.append("before: " + before_reason)
    if after_reason:
        reason.append("after: " + after_reason)

    score_before = composite_score(before)
    score_after = composite_score(after)
    improvement = round(score_after - score_before, 2)
    winner = "after" if score_after >= score_before else "before"

    result = {
        "before": before_scores,
        "after": after_scores,
        "improvement": improvement,
        "winner": winner,
        "reason": reason,
    }
    save_json(output_dir / "optimization_result.json", result)
    save_json(
        output_dir / "winner.json",
        {
            "winner": winner,
            "reason": reason,
            "score_before": score_before,
            "score_after": score_after,
        },
    )

    print(
        json.dumps(
            {
                "before_report": str(output_dir / "before_report.json"),
                "optimized_prompt": str(output_dir / "optimized_prompt.json"),
                "v3_image": str(v3_image_path),
                "after_report": str(output_dir / "after_report.json"),
                "optimization_result": str(output_dir / "optimization_result.json"),
                **result,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
