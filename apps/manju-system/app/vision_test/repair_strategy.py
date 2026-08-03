import argparse
import json
import sys
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_DIR))


STRATEGIES = {
    "character_error": {
        "repair": "character_reference",
        "method": "IPAdapter_future",
        "fallback": "FaceDetailer",
    },
    "bad_anatomy": {
        "repair": "local_inpaint",
        "method": "FaceDetailer",
        "keep_background": True,
    },
    "scene_empty": {
        "repair": "prompt_scene_expand",
        "method": "rerender",
    },
    "composition_error": {
        "repair": "camera_prompt",
        "method": "img2img",
    },
    "ai_artifact": {
        "repair": "sampling_change",
        "method": "new_seed",
    },
}

PRIORITY = [
    "character_error",
    "bad_anatomy",
    "scene_empty",
    "composition_error",
    "ai_artifact",
]


class RepairStrategy:
    def build(self, visual_action):
        issues = (visual_action or {}).get("issues") or []
        issue_types = {
            str(issue.get("type"))
            for issue in issues
            if isinstance(issue, dict) and issue.get("type")
        }
        for issue_type in PRIORITY:
            if issue_type in issue_types:
                return dict(STRATEGIES[issue_type])
        return {"repair": "none", "method": "keep_current"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--input",
        default=str(PROJECT_DIR / "data" / "vision_test" / "v3" / "visual_action.json"),
    )
    parser.add_argument(
        "--output",
        default=str(PROJECT_DIR / "data" / "vision_test" / "v3" / "repair_strategy.json"),
    )
    args = parser.parse_args()

    input_path = Path(args.input)
    output_path = Path(args.output)
    if not input_path.exists():
        raise FileNotFoundError(f"visual_action not found: {input_path}")

    visual_action = json.loads(input_path.read_text(encoding="utf-8"))
    strategy = RepairStrategy().build(visual_action)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(strategy, ensure_ascii=False, indent=2), encoding="utf-8")

    print(
        json.dumps(
            {
                "input": str(input_path),
                "output": str(output_path),
                **strategy,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
