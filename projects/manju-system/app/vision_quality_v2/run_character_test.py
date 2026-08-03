import argparse
import json
import shutil
import sys
from datetime import datetime
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_DIR))

from app.vision_quality_v2.character_asset import build_character_asset
from app.vision_quality_v2.character_prompt_builder import CharacterPromptBuilder
from app.vision_quality_v2.consistency_test import CharacterConsistencyTester
from app.vision_quality_v2.ipadapter_survey import survey as ipadapter_survey
from app.vision_test.quality_judge import QualityJudge

DEFAULT_SCENE_MAP = {
    "char_001": ["shot_001", "shot_004", "shot_007", "shot_010", "shot_013"],
    "char_002": ["shot_001", "shot_002", "shot_007", "shot_008", "shot_009"],
    "char_003": ["shot_004", "shot_005", "shot_010", "shot_011"],
    "char_004": ["shot_012", "shot_013", "shot_014", "shot_015", "shot_016"],
}


def _load_json(path):
    path = Path(path)
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def _save_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def _disk_info(drive):
    usage = shutil.disk_usage(drive + ":/")
    return {
        "drive": drive,
        "used_gb": round(usage.used / 1024**3, 2),
        "free_gb": round(usage.free / 1024**3, 2),
        "total_gb": round(usage.total / 1024**3, 2),
    }


def _scene_summary(shot):
    parts = []
    if shot.get("camera"):
        parts.append("镜头:" + shot["camera"])
    chars = shot.get("characters") or []
    if chars:
        char_desc = "；".join(
            f"{c.get('name', '')}({c.get('emotion', '')},{c.get('pose', '')})"
            for c in chars
        )
        parts.append("人物:" + char_desc)
    if shot.get("dialogue_text"):
        parts.append("台词:" + shot["dialogue_text"])
    return "；".join(parts)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-id", default="20260731_171708")
    parser.add_argument("--character-id", default="char_001")
    parser.add_argument("--shots", default="")
    parser.add_argument("--output-dir", default="")
    args = parser.parse_args()

    output_dir = (
        Path(args.output_dir)
        if args.output_dir
        else PROJECT_DIR / "data" / "vision_quality_v2" / args.run_id
    )
    output_dir.mkdir(parents=True, exist_ok=True)
    disk_before = {"C": _disk_info("C"), "E": _disk_info("E")}

    card = build_character_asset(args.character_id, args.run_id)

    survey = ipadapter_survey()
    _save_json(output_dir / "ipadapter_models.json", survey)

    shot_ids = [
        s.strip()
        for s in (args.shots or ",".join(DEFAULT_SCENE_MAP.get(args.character_id, []))).split(",")
        if s.strip()
    ]
    if not shot_ids:
        raise ValueError(f"no scenes configured for character: {args.character_id}")

    storyboard = _load_json(
        PROJECT_DIR / "data" / "runs" / args.run_id / "storyboard.json"
    )
    storyboard_shots = {
        s.get("shot_id"): s for s in (storyboard or {}).get("shots", [])
    }
    prompts = _load_json(
        PROJECT_DIR / "data" / "runs" / args.run_id / "v2" / "v2_prompts.json"
    )
    prompt_shots = {
        s.get("shot_id"): s for s in (prompts or {}).get("shots", [])
    }

    scenes = []
    for shot_id in shot_ids:
        image_path = (
            PROJECT_DIR
            / "output"
            / "v2_images"
            / args.run_id
            / f"{shot_id}.png"
        )
        if not image_path.exists():
            raise FileNotFoundError(f"existing image required, not found: {image_path}")
        scenes.append(
            {
                "shot_id": shot_id,
                "image_path": str(image_path),
                "scene_summary": _scene_summary(storyboard_shots.get(shot_id, {})),
            }
        )

    builder = CharacterPromptBuilder(args.run_id)
    test_prompts = []
    for shot_id in shot_ids:
        source = prompt_shots.get(shot_id, {})
        test_prompts.append(builder.build(card, source))
    _save_json(output_dir / "test_scenes.json", scenes)
    _save_json(output_dir / "test_prompts.json", test_prompts)

    tester = CharacterConsistencyTester()
    try:
        consistency = tester.test(args.character_id, card, scenes)
        consistency = {"status": "done", **consistency}
    except Exception as e:
        consistency = {"status": "failed", "error": str(e)}
    consistency["character_id"] = args.character_id
    consistency["model"] = tester.model
    consistency["scenes"] = scenes
    consistency["generated_at"] = datetime.now().isoformat(timespec="seconds")
    _save_json(output_dir / "character_consistency_report.json", consistency)

    judge = QualityJudge()
    quality_entries = []
    for scene, prompt in zip(scenes, test_prompts):
        entry = {
            "shot_id": scene["shot_id"],
            "image_path": scene["image_path"],
            "prompt": prompt,
        }
        try:
            report = judge.judge(scene["image_path"], prompt)
            entry.update({"status": "done", **report})
        except Exception as e:
            entry.update({"status": "failed", "error": str(e)})
        quality_entries.append(entry)
    _save_json(output_dir / "quality_judge_report.json", quality_entries)

    disk_after = {"C": _disk_info("C"), "E": _disk_info("E")}
    done = [e for e in quality_entries if e.get("status") == "done"]
    summary = {
        "character_id": args.character_id,
        "run_id": args.run_id,
        "output_dir": str(output_dir),
        "character_card": card.get("asset_paths", {}),
        "ipadapter": {
            "available": survey["ipadapter_available"],
            "missing": survey["missing"],
        },
        "consistency": {
            "status": consistency["status"],
            "character_identity": consistency.get("character_identity"),
            "scene_realism": consistency.get("scene_realism"),
            "ai_artifact": consistency.get("ai_artifact"),
            "human_acceptance_probability": consistency.get(
                "human_acceptance_probability"
            ),
            "conclusion": consistency.get("conclusion"),
        },
        "quality_judge": {
            "done_count": len(done),
            "failed_count": len(quality_entries) - len(done),
            "avg_character_identity": round(
                sum(e.get("character_identity", 0) for e in done) / len(done), 1
            )
            if done
            else None,
            "avg_human_acceptance_probability": round(
                sum(
                    e.get("human_acceptance_probability", 0) for e in done
                )
                / len(done),
                1,
            )
            if done
            else None,
        },
        "disk_before": disk_before,
        "disk_after": disk_after,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
    }
    _save_json(output_dir / "run_summary.json", summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
