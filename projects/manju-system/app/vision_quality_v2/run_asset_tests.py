import argparse
import json
import shutil
import sys
from datetime import datetime
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_DIR))

from app.comfy.client import ComfyClient
from app.vision_quality_v2.character_asset import (
    build_character_asset,
    get_character_card,
)
from app.vision_quality_v2.character_asset_validator import CharacterAssetValidator
from app.vision_quality_v2.character_prompt_builder import (
    DEFAULT_NEGATIVE,
    IDENTITY_LOCK,
)
from app.vision_quality_v2.consistency_test import CharacterConsistencyTester

CHARACTER_IDS = ["char_001", "char_002", "char_003", "char_004"]


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


def _load_config():
    return _load_json(PROJECT_DIR / "config" / "config.json")


def _build_shot(config, positive, negative, seed, width=None, height=None):
    comfy = config["comfy"]
    return {
        "shot_id": "m11",
        "positive": positive,
        "negative": negative,
        "checkpoint": comfy["checkpoint"],
        "width": width or comfy.get("width", 768),
        "height": height or comfy.get("height", 1344),
        "steps": comfy.get("steps", 20),
        "cfg": comfy.get("cfg", 7.0),
        "sampler": comfy.get("sampler", "euler"),
        "scheduler": comfy.get("scheduler", "normal"),
        "seed": seed,
    }


def _render(comfy, shot, prefix, final_path):
    final_path = Path(final_path)
    final_path.parent.mkdir(parents=True, exist_ok=True)
    if final_path.exists():
        return {"status": "exists", "image_path": str(final_path)}
    attempts = [shot]
    if shot.get("width", 768) > 640:
        small = dict(shot)
        small["width"] = 576
        small["height"] = 1024
        attempts.append(small)
    last_error = None
    for index, attempt_shot in enumerate(attempts, 1):
        try:
            result = comfy.generate(attempt_shot, filename_prefix=prefix)
            source = Path(result["image_path"])
            if not source.exists():
                raise FileNotFoundError(source)
            shutil.copyfile(source, final_path)
            return {
                "status": "done",
                "image_path": str(final_path),
                "seed": attempt_shot.get("seed"),
                "attempt": index,
            }
        except Exception as e:
            last_error = str(e)
    return {"status": "failed", "error": last_error}


def _hair_prompt(card, variant):
    anchor = card.get("appearance_anchor") or {}
    base = (
        "same person, identical facial features, identical eye color, "
        "young woman, "
        + anchor.get("face_shape", "oval delicate face")
        + ", "
        + anchor.get("skin_tone", "fair skin")
        + ", "
        + anchor.get("body_shape", "slender average-height body")
        + ", small mole below left eye"
    )
    if variant == "ponytail":
        hair = "black hair in high ponytail, red hair tie"
    else:
        hair = "long loose black hair, no hair tie"
    return (
        f"{base}, {hair}, plain white t-shirt, blue jeans, "
        "standing in a bright living room, soft daylight from window, "
        "manga style, anime illustration, detailed background"
    )


def _male_prompt(card, variant):
    anchor = card.get("appearance_anchor") or {}
    base = (
        "young man, slim build, black suit, black shirt, silver tie, "
        "handsome but sinister, sharp eyes, cold smile, "
        "scar above right eyebrow, silver earring on left ear, "
        + anchor.get("face_shape", "angular sharp face")
        + ", "
        + anchor.get("skin_tone", "fair skin")
        + ", "
        + anchor.get("body_shape", "slim tall body")
        + ", same person, identical facial features, identical hairstyle, identical eye color"
    )
    if variant == "front":
        shot = (
            "front-facing close-up portrait, head and shoulders, "
            "neutral sinister expression, standing on a night city street, "
            "blurred streetlights in background"
        )
    elif variant == "half":
        shot = (
            "half-body shot from waist up, standing under a streetlight, "
            "hands in pockets, night city street background"
        )
    else:
        shot = (
            "full-body shot, standing on a sidewalk, night city street, "
            "distant bokeh lights, full outfit visible"
        )
    return (
        f"{base}, {shot}, realistic background, natural lighting, "
        "photographic detail"
    )


def _hand_prompt(card, item):
    identity = card.get("identity_tags_en", "")
    actions = {
        "file": (
            "holding a paper document in her right hand, fingers clearly wrapped "
            "around the paper, reading it, natural hand pose, document not merged with hand"
        ),
        "phone": (
            "holding a smartphone in her left hand, thumb and fingers visible "
            "around the phone, natural hand pose, phone separate from hand"
        ),
        "cup": (
            "holding a white ceramic cup in both hands, fingers wrapped around "
            "the cup, natural hand pose, cup separate from hand"
        ),
    }
    return (
        f"{identity}, {IDENTITY_LOCK}, {actions[item]}, standing in a bright room, "
        "realistic background"
    )


def _hand_negative():
    return (
        DEFAULT_NEGATIVE
        + ", extra fingers, missing fingers, fused fingers, deformed hand, "
        "hand merged with object, extra hands"
    )


def _male_negative():
    return (
        "black background, plain solid background, collage, text, watermark, "
        "poster design, logo, border, frame, "
        + DEFAULT_NEGATIVE
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-id", default="20260731_171708")
    parser.add_argument("--package-dir", default="")
    parser.add_argument("--skip-render", action="store_true")
    args = parser.parse_args()

    disk_before = {"C": _disk_info("C"), "E": _disk_info("E")}
    package_dir = (
        Path(args.package_dir)
        if args.package_dir
        else PROJECT_DIR / "output" / "character_review_package"
    )
    package_dir.mkdir(parents=True, exist_ok=True)
    tests_dir = package_dir / "tests"
    reports_dir = package_dir / "reports"
    reports_dir.mkdir(parents=True, exist_ok=True)

    cards = {}
    for character_id in CHARACTER_IDS:
        cards[character_id] = build_character_asset(character_id, args.run_id)

    config = _load_config()
    comfy_cfg = config["comfy"]
    comfy = ComfyClient(
        base_url=comfy_cfg["base_url"],
        checkpoint=comfy_cfg["checkpoint"],
        output_dir=PROJECT_DIR / "output" / "m11_test_raw",
        timeout_seconds=comfy_cfg.get("timeout_seconds", 900),
    )
    if not args.skip_render:
        comfy.check_ready()
        comfy.ensure_checkpoint()

    test_status = {}

    # Task 1: female lead ponytail vs loose hair
    hair_dir = tests_dir / "hair_consistency"
    hair_dir.mkdir(parents=True, exist_ok=True)
    card_001 = cards["char_001"]
    hair_variants = {
        "ponytail": hair_dir / "char_001_ponytail.png",
        "loose_hair": hair_dir / "char_001_loose_hair.png",
    }
    hair_prompts = {}
    for variant, final_path in hair_variants.items():
        positive = _hair_prompt(card_001, variant)
        hair_prompts[variant] = positive
        if args.skip_render:
            continue
        shot = _build_shot(
            config,
            positive,
            _hand_negative(),
            seed=202608011 + list(hair_variants).index(variant),
        )
        test_status[f"hair_{variant}"] = _render(
            comfy, shot, f"m11_hair_{variant}", final_path
        )
    _save_json(
        hair_dir / "hair_prompts.json",
        {"prompts": hair_prompts},
    )

    hair_consistency = None
    hair_images = [str(p) for p in hair_variants.values() if p.exists()]
    if len(hair_images) == 2:
        scenes = [
            {
                "shot_id": "ponytail",
                "image_path": hair_images[0],
                "scene_summary": "女主高马尾版本",
            },
            {
                "shot_id": "loose_hair",
                "image_path": hair_images[1],
                "scene_summary": "女主披发版本",
            },
        ]
        try:
            hair_consistency = CharacterConsistencyTester().test(
                "char_001", card_001, scenes
            )
            hair_consistency["status"] = "done"
        except Exception as e:
            hair_consistency = {"status": "failed", "error": str(e)}
        _save_json(hair_dir / "hair_consistency_report.json", hair_consistency)

    # Task 2: male supporting character asset redo
    male_dir = tests_dir / "male_assets"
    male_dir.mkdir(parents=True, exist_ok=True)
    card_004 = cards["char_004"]
    male_variants = {
        "front": male_dir / "char_004_front.png",
        "half": male_dir / "char_004_half.png",
        "full": male_dir / "char_004_full.png",
    }
    male_prompts = {}
    for variant, final_path in male_variants.items():
        positive = _male_prompt(card_004, variant)
        male_prompts[variant] = positive
        if args.skip_render:
            continue
        shot = _build_shot(
            config,
            positive,
            _male_negative(),
            seed=202608021 + list(male_variants).index(variant),
        )
        test_status[f"male_{variant}"] = _render(
            comfy, shot, f"m11_male_{variant}", final_path
        )
    _save_json(
        male_dir / "male_prompts.json",
        {"prompts": male_prompts},
    )

    # Task 3: hand interaction test
    hand_dir = tests_dir / "hand_interaction"
    hand_dir.mkdir(parents=True, exist_ok=True)
    hand_items = {
        "file": hand_dir / "char_001_hand_file.png",
        "phone": hand_dir / "char_001_hand_phone.png",
        "cup": hand_dir / "char_001_hand_cup.png",
    }
    hand_prompts = {}
    for item, final_path in hand_items.items():
        positive = _hand_prompt(card_001, item)
        hand_prompts[item] = positive
        if args.skip_render:
            continue
        shot = _build_shot(
            config,
            positive,
            _hand_negative(),
            seed=202608031 + list(hand_items).index(item),
        )
        test_status[f"hand_{item}"] = _render(
            comfy, shot, f"m11_hand_{item}", final_path
        )
    _save_json(
        hand_dir / "hand_prompts.json",
        {"prompts": hand_prompts},
    )

    # Task 1: asset validator on existing assets + new test images
    run_dir = PROJECT_DIR / "data" / "runs" / args.run_id
    v2_images = PROJECT_DIR / "output" / "v2_images" / args.run_id
    v2_prompts = _load_json(run_dir / "v2" / "v2_prompts.json") or {}
    prompt_map = {
        s.get("shot_id"): s for s in v2_prompts.get("shots", [])
    }

    consistency_checks = [
        "face_shape",
        "eye_color",
        "hair_style",
        "hair_accessory",
        "age_feel",
        "body_proportion",
    ]
    cases = []
    for character_id in CHARACTER_IDS:
        card = cards[character_id]
        front = PROJECT_DIR / "data" / "characters" / character_id / "front_face.png"
        if front.exists():
            cases.append(
                {
                    "id": f"{character_id}_front",
                    "image_path": str(front),
                    "prompt": card.get("identity_tags_en", ""),
                    "checks": consistency_checks,
                }
            )

    existing_cases = [
        ("char_001", "shot_005", ["finger_count", "hand_object_fusion", "prop_paper"]),
        ("char_001", "shot_013", ["two_person_frame", "confrontation"]),
        ("char_002", "shot_002", ["two_person_frame", "holding_hands"]),
        ("char_003", "shot_004", ["two_person_frame", "prop_bag"]),
        ("char_003", "shot_010", ["prop_pen", "finger_count"]),
        ("char_004", "shot_013", ["two_person_frame", "confrontation"]),
    ]
    for character_id, shot_id, checks in existing_cases:
        image = v2_images / f"{shot_id}.png"
        if not image.exists():
            continue
        cases.append(
            {
                "id": f"{character_id}_{shot_id}",
                "image_path": str(image),
                "prompt": prompt_map.get(shot_id, {}),
                "checks": checks,
            }
        )

    for variant, final_path in hair_variants.items():
        if final_path.exists():
            cases.append(
                {
                    "id": f"hair_{variant}",
                    "image_path": str(final_path),
                    "prompt": hair_prompts.get(variant, ""),
                    "checks": [
                        "face_shape",
                        "eye_color",
                        "hair_style",
                        "age_feel",
                    ],
                }
            )
    for variant, final_path in male_variants.items():
        if final_path.exists():
            cases.append(
                {
                    "id": f"male_{variant}",
                    "image_path": str(final_path),
                    "prompt": male_prompts.get(variant, ""),
                    "checks": [
                        "face_shape",
                        "eye_color",
                        "hair_style",
                        "age_feel",
                        "body_proportion",
                    ],
                }
            )
    hand_checks = {
        "file": ["finger_count", "hand_object_fusion", "hand_occlusion", "prop_paper"],
        "phone": ["finger_count", "hand_object_fusion", "hand_occlusion"],
        "cup": ["finger_count", "hand_object_fusion", "hand_occlusion", "prop_cup"],
    }
    for item, final_path in hand_items.items():
        if final_path.exists():
            cases.append(
                {
                    "id": f"hand_{item}",
                    "image_path": str(final_path),
                    "prompt": hand_prompts.get(item, ""),
                    "checks": hand_checks[item],
                }
            )

    validator = CharacterAssetValidator()
    validation = validator.validate(cases)
    validation["generated_at"] = datetime.now().isoformat(timespec="seconds")
    validation["run_id"] = args.run_id
    _save_json(reports_dir / "character_asset_validation.json", validation)

    # Task 4: review package
    character_ref_dir = package_dir / "characters"
    character_ref_dir.mkdir(parents=True, exist_ok=True)
    package_files = []
    for character_id in CHARACTER_IDS:
        asset_dir = PROJECT_DIR / "data" / "characters" / character_id
        for asset_name in ("front_face", "full_body", "outfit"):
            source = asset_dir / f"{asset_name}.png"
            if not source.exists():
                continue
            target = character_ref_dir / f"{character_id}_{asset_name}.png"
            if not target.exists():
                shutil.copyfile(source, target)
            package_files.append(
                {
                    "path": str(target.relative_to(package_dir)),
                    "category": "character_reference",
                    "character_id": character_id,
                    "asset": asset_name,
                }
            )
        card_source = asset_dir / "character_card.json"
        card_target = reports_dir / f"{character_id}_character_card.json"
        if card_source.exists() and not card_target.exists():
            shutil.copyfile(card_source, card_target)
        package_files.append(
            {
                "path": str(card_target.relative_to(package_dir)),
                "category": "character_card",
                "character_id": character_id,
            }
        )

    category_report_files = {
        "hair_consistency": ["hair_consistency_report.json", "hair_prompts.json"],
        "male_assets": ["male_prompts.json"],
        "hand_interaction": ["hand_prompts.json"],
    }
    for category, files in (
        ("hair_consistency", hair_variants),
        ("male_assets", male_variants),
        ("hand_interaction", hand_items),
    ):
        for name, path in files.items():
            if path.exists():
                package_files.append(
                    {
                        "path": str(path.relative_to(package_dir)),
                        "category": category,
                        "test": name,
                    }
                )
        for report_name in category_report_files.get(category, []):
            report_path = tests_dir / category / report_name
            if report_path.exists():
                package_files.append(
                    {
                        "path": str(report_path.relative_to(package_dir)),
                        "category": category,
                        "report": True,
                    }
                )

    problems = []
    for case in validation.get("cases", []):
        for problem in case.get("problems", []):
            if problem.get("problem"):
                problems.append(
                    {
                        "case_id": case.get("id"),
                        "image_path": case.get("image_path"),
                        "item": problem.get("item"),
                        "problem": problem.get("problem"),
                        "suggestion": problem.get("suggestion"),
                    }
                )
    for key, status in test_status.items():
        if status.get("status") == "failed":
            problems.append(
                {
                    "case_id": key,
                    "image_path": "",
                    "item": "render",
                    "problem": status.get("error"),
                    "suggestion": "降低分辨率后重试或检查 ComfyUI 状态",
                }
            )
    if hair_consistency and hair_consistency.get("status") == "done":
        for problem in hair_consistency.get("problems", []):
            problems.append(
                {
                    "case_id": "hair_consistency",
                    "image_path": "",
                    "item": "hair_consistency",
                    "problem": str(problem),
                    "suggestion": "",
                }
            )
    _save_json(package_dir / "problems.json", problems)
    package_files.append(
        {
            "path": "reports/character_asset_validation.json",
            "category": "report",
            "report": True,
        }
    )
    package_files.append(
        {
            "path": "problems.json",
            "category": "problems",
        }
    )
    package_files.append(
        {
            "path": "run_summary.json",
            "category": "summary",
        }
    )

    disk_after = {"C": _disk_info("C"), "E": _disk_info("E")}
    manifest = {
        "run_id": args.run_id,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "package_root": str(package_dir),
        "files": package_files,
        "tests": test_status,
        "validation_conclusion": validation.get("conclusion"),
    }
    _save_json(reports_dir / "m11_manifest.json", manifest)
    _save_json(
        package_dir / "run_summary.json",
        {
            "generated_at": datetime.now().isoformat(timespec="seconds"),
            "run_id": args.run_id,
            "package_root": str(package_dir),
            "validation": {
                "conclusion": validation.get("conclusion"),
                "summary": validation.get("summary"),
            },
            "hair_consistency": hair_consistency,
            "test_status": test_status,
            "problem_count": len(problems),
            "disk_before": disk_before,
            "disk_after": disk_after,
        },
    )

    summary = {
        "package_dir": str(package_dir),
        "validation": {
            "conclusion": validation.get("conclusion"),
            "summary": validation.get("summary"),
        },
        "hair_consistency": hair_consistency,
        "test_status": test_status,
        "problem_count": len(problems),
        "disk_before": disk_before,
        "disk_after": disk_after,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
