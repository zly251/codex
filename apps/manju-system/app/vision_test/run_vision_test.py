import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_DIR))

from app.vision_test.prompt_feedback import PromptFeedback
from app.vision_test.vision_judge import VisionJudge


def load_json(path):
    path = Path(path)
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-id", default="20260731_171708")
    parser.add_argument("--shot-id", default="shot_013")
    parser.add_argument("--image-path", default="")
    parser.add_argument("--prompt-path", default="")
    parser.add_argument("--output-dir", default="")
    args = parser.parse_args()

    run_dir = PROJECT_DIR / "data" / "runs" / args.run_id
    v2_dir = run_dir / "v2"
    image_path = (
        Path(args.image_path)
        if args.image_path
        else PROJECT_DIR / "output" / "v2_images" / args.run_id / f"{args.shot_id}.png"
    )
    prompt_path = Path(args.prompt_path) if args.prompt_path else v2_dir / "v2_prompts.json"
    output_dir = Path(args.output_dir) if args.output_dir else PROJECT_DIR / "data" / "vision_test"
    output_dir.mkdir(parents=True, exist_ok=True)

    prompts = load_json(prompt_path)
    if not prompts:
        raise FileNotFoundError(f"prompt file not found: {prompt_path}")
    shot = next(
        (s for s in prompts.get("shots", []) if s.get("shot_id") == args.shot_id),
        None,
    )
    if not shot:
        raise ValueError(f"shot {args.shot_id} not found in {prompt_path}")

    judge = VisionJudge()
    report = judge.judge(image_path, shot)
    feedback = PromptFeedback()
    new_prompt = feedback.generate(shot, report)

    vision_report = {
        "shot_id": args.shot_id,
        "image_path": str(image_path),
        "model": judge.model,
        "status": "done",
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "current_prompt": shot,
        **report,
    }
    new_prompt_json = {
        "shot_id": args.shot_id,
        "model": feedback.model,
        "status": "done",
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        **new_prompt,
    }

    vision_report_path = output_dir / "vision_report.json"
    new_prompt_path = output_dir / "new_prompt.json"
    vision_report_path.write_text(
        json.dumps(vision_report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    new_prompt_path.write_text(
        json.dumps(new_prompt_json, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print(
        json.dumps(
            {
                "vision_report": str(vision_report_path),
                "new_prompt": str(new_prompt_path),
                "rerender": report["rerender"],
                "character_quality": report["character_quality"],
                "scene_quality": report["scene_quality"],
                "composition_quality": report["composition_quality"],
                "ai_artifact_score": report["ai_artifact_score"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
