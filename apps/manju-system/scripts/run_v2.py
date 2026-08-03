import argparse
import json
import os
import random
import shutil
import subprocess
import sys
import time
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_DIR))

import contextlib

from app.agents.character_card import CharacterCardAgent
from app.agents.prompt import AgentPrompt
from app.comfy.client import ComfyClient
from app.data.store import load_json, save_json
from app.utils.deepseek_client import DeepSeekClient
from app.utils.logging import setup_logger
from app.visual_qa.agent import VisualQAAgent


def load_config():
    config_path = PROJECT_DIR / "config" / "config.json"
    with open(config_path, encoding="utf-8") as f:
        return json.load(f)


def resolve_api_key(config):
    key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if key:
        return key
    key_file = Path.home() / ".douyin_agent_key"
    if key_file.exists():
        return key_file.read_text(encoding="utf-8").strip()
    raise RuntimeError("缺少 DeepSeek API Key")


def download_first_image(comfy, workflow, filename_prefix, shot_id):
    prompt_id = comfy.submit_workflow(workflow)
    images = comfy.wait_workflow(prompt_id)
    image_meta = images[0]
    return comfy._download_image(
        image_meta,
        target_name=f"{filename_prefix}_{shot_id}_{image_meta['filename']}",
    )


def render_references(comfy, v2_cfg, characters, ref_dir, logger):
    ref_paths = {}
    ref_dir.mkdir(parents=True, exist_ok=True)
    for char in characters or []:
        char_id = char["character_id"]
        out = ref_dir / f"{char_id}.png"
        if out.exists():
            ref_paths[char["name"]] = out
            continue
        positive = (
            char["appearance_en"]
            + ", "
            + char.get("style_tags", "manga style, anime illustration")
            + ", character reference sheet, full body, front view, plain background"
        )
        shot = {
            "shot_id": char_id,
            "positive": positive,
            "negative": v2_cfg.get(
                "negative",
                "deformed, extra hands, blurry, text, watermark, low quality",
            ),
            "seed": random.randint(1, 2147483646),
        }
        logger.info("render reference: %s", char_id)
        raw = download_first_image(comfy, comfy.build_workflow_v2(shot, v2_cfg), "v2ref", char_id)
        shutil.copyfile(raw, out)
        ref_paths[char["name"]] = out
    return ref_paths


def render_shot_v2(
    comfy,
    v2_cfg,
    shot,
    shot_id,
    run_id,
    v2_img_dir,
    input_dir,
    face_mask_python,
    face_model,
    logger,
):
    raw_hires = download_first_image(comfy, comfy.build_workflow_v2(shot, v2_cfg), "v2a", shot_id)
    hires_path = v2_img_dir / f"{shot_id}_hires.png"
    shutil.copyfile(raw_hires, hires_path)

    mask_path = v2_img_dir / f"{shot_id}_mask.png"
    mask_script = PROJECT_DIR / "scripts" / "face_mask.py"
    proc = subprocess.run(
        [
            face_mask_python,
            str(mask_script),
            "--image",
            str(hires_path),
            "--output",
            str(mask_path),
            "--model",
            str(face_model),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=120,
    )
    if proc.returncode != 0:
        raise RuntimeError("face_mask failed: " + (proc.stderr or proc.stdout)[-500:])
    face_count = 0
    for line in proc.stdout.splitlines():
        if line.startswith("faces="):
            with contextlib.suppress(ValueError):
                face_count = int(line.split("=", 1)[1])

    unique = f"{run_id}_{shot_id}"
    input_hires = input_dir / f"{unique}_hires.png"
    input_mask = input_dir / f"{unique}_mask.png"
    shutil.copyfile(hires_path, input_hires)
    shutil.copyfile(mask_path, input_mask)
    try:
        workflow = comfy.build_workflow_v2_detail(
            shot,
            v2_cfg,
            input_hires.name,
            input_mask.name,
            use_detail=face_count > 0,
        )
        raw_final = download_first_image(comfy, workflow, "v2b", shot_id)
        final_path = v2_img_dir / f"{shot_id}.png"
        shutil.copyfile(raw_final, final_path)
    finally:
        for p in (input_hires, input_mask):
            with contextlib.suppress(OSError):
                p.unlink()
    return final_path, hires_path, face_count


def build_comparison(run_dir, logger):
    v1 = {}
    for qa_file in sorted(run_dir.glob("qa_shot_*.json")):
        data = load_json(qa_file)
        shot_id = data.get("shot_id") or qa_file.stem.replace("qa_", "")
        v1[shot_id] = data.get("scores", {}).get("total")
    v2 = {}
    for qa_file in sorted(run_dir.glob("v2_qa_*.json")):
        data = load_json(qa_file)
        shot_id = data.get("shot_id") or qa_file.stem.replace("v2_qa_", "")
        v2[shot_id] = data.get("scores", {}).get("total")
    shot_ids = sorted(set(v1) | set(v2))
    shots = []
    for shot_id in shot_ids:
        shots.append(
            {
                "shot_id": shot_id,
                "v1_total": v1.get(shot_id),
                "v2_total": v2.get(shot_id),
                "delta": (
                    round(v2[shot_id] - v1[shot_id], 2)
                    if v1.get(shot_id) is not None and v2.get(shot_id) is not None
                    else None
                ),
            }
        )
    v1_values = [v for v in v1.values() if v is not None]
    v2_values = [v for v in v2.values() if v is not None]
    comparison = {
        "run_id": run_dir.name,
        "shots": shots,
        "summary": {
            "v1_count": len(v1_values),
            "v2_count": len(v2_values),
            "v1_avg": round(sum(v1_values) / len(v1_values), 2) if v1_values else None,
            "v2_avg": round(sum(v2_values) / len(v2_values), 2) if v2_values else None,
        },
    }
    save_json(run_dir / "v2_comparison.json", comparison, logger)
    return comparison


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-id", default="20260731_171708")
    parser.add_argument("--limit", type=int, default=16)
    parser.add_argument("--only-shots", default="")
    parser.add_argument("--skip-refs", action="store_true")
    parser.add_argument("--force", action="store_true", help="rerender existing final image")
    parser.add_argument(
        "--no-qa-retry",
        action="store_true",
        help="disable automatic prompt regeneration on QA failure",
    )
    parser.add_argument(
        "--cooldown", type=int, default=0, help="seconds to rest after each rendered shot"
    )
    args = parser.parse_args()

    config = load_config()
    comfy_cfg = config["comfy"]
    v2_cfg = config["comfy_v2"]
    data_dir = PROJECT_DIR / config["paths"]["data_dir"]
    output_dir = PROJECT_DIR / config["paths"]["output_dir"]
    run_dir = data_dir / "runs" / args.run_id
    if not run_dir.exists():
        raise RuntimeError(f"run dir not found: {run_dir}")

    logger = setup_logger("manju_v2", data_dir / "logs")
    client = DeepSeekClient(
        api_key=resolve_api_key(config),
        base_url=config["deepseek"]["base_url"],
        model=config["deepseek"]["model"],
    )
    prompt_agent = AgentPrompt(client, run_dir, logger, comfy_cfg)

    storyboard = load_json(run_dir / "storyboard.json")
    script = load_json(run_dir / "script.json")

    v2_dir = run_dir / "v2"
    v2_dir.mkdir(parents=True, exist_ok=True)
    characters_path = v2_dir / "characters.json"
    if characters_path.exists():
        characters = load_json(characters_path).get("characters", [])
    else:
        card_agent = CharacterCardAgent(client, run_dir, logger)
        characters = card_agent.run(script, storyboard).get("characters", [])
        save_json(characters_path, {"characters": characters}, logger)
    logger.info("characters: %s", [c.get("name") for c in characters])

    v2_prompts_path = v2_dir / "v2_prompts.json"
    if v2_prompts_path.exists():
        prompts = load_json(v2_prompts_path)
    else:
        prompts = prompt_agent.run_v2(storyboard, characters)
        save_json(v2_prompts_path, prompts, logger)
    shots = prompts.get("shots", [])[: args.limit]
    if args.only_shots:
        allowed = {s.strip() for s in args.only_shots.split(",")}
        shots = [s for s in shots if s.get("shot_id") in allowed]

    comfy = ComfyClient(
        base_url=comfy_cfg["base_url"],
        checkpoint=v2_cfg["checkpoint"],
        output_dir=output_dir / "v2_images" / args.run_id,
        timeout_seconds=comfy_cfg["timeout_seconds"],
        logger=logger,
    )
    comfy.check_ready()
    comfy.ensure_checkpoint()

    ref_dir = output_dir / "reference" / args.run_id
    ref_paths = {}
    if not args.skip_refs:
        ref_paths = render_references(comfy, v2_cfg, characters, ref_dir, logger)

    qa_agent = VisualQAAgent(PROJECT_DIR, config, logger)
    input_dir = Path(v2_cfg["input_dir"])
    input_dir.mkdir(parents=True, exist_ok=True)
    face_model = PROJECT_DIR / v2_cfg.get(
        "face_model", "models/face/face_detection_yunet_2023mar.onnx"
    )
    if not face_model.exists():
        raise RuntimeError(f"face model not found: {face_model}")
    v2_img_dir = output_dir / "v2_images" / args.run_id
    v2_img_dir.mkdir(parents=True, exist_ok=True)

    storyboard_map = {s["shot_id"]: s for s in storyboard.get("shots", [])}
    results = []
    for shot in shots:
        shot_id = shot["shot_id"]
        logger.info("=== v2 render %s ===", shot_id)
        final_path = v2_img_dir / f"{shot_id}.png"
        if final_path.exists() and not args.force:
            logger.info("%s already done, skip", shot_id)
            results.append({"shot_id": shot_id, "image_path": str(final_path), "skipped": True})
            continue
        try:
            attempt = 0
            qa_result = None
            while True:
                attempt += 1
                final_path, hires_path, face_count = render_shot_v2(
                    comfy,
                    v2_cfg,
                    shot,
                    shot_id,
                    args.run_id,
                    v2_img_dir,
                    input_dir,
                    v2_cfg["face_mask_python"],
                    face_model,
                    logger,
                )
                story_shot = storyboard_map.get(shot_id, {})
                characters_in_shot = story_shot.get("characters") or []
                character_name = characters_in_shot[0].get("name") if characters_in_shot else None
                reference_path = ref_paths.get(character_name)
                qa_result = qa_agent.run(str(final_path), shot, story_shot, reference_path)
                save_json(run_dir / f"v2_qa_{shot_id}.json", qa_result, logger)
                if not qa_result.get("needs_regenerate") or attempt > 1 or args.no_qa_retry:
                    break
                logger.warning(
                    "%s qa=%.1f regenerate attempt=%s",
                    shot_id,
                    qa_result.get("scores", {}).get("total"),
                    attempt,
                )
                shot = prompt_agent.regenerate_shot_v2(shot, qa_result["reason"], characters)
                save_json(v2_prompts_path, prompts, logger)
            results.append(
                {
                    "shot_id": shot_id,
                    "image_path": str(final_path),
                    "hires_path": str(hires_path),
                    "faces": face_count,
                    "qa_total": qa_result.get("scores", {}).get("total"),
                    "qa_retries": attempt - 1,
                }
            )
            logger.info("%s done: %s", shot_id, final_path)
            if args.cooldown > 0:
                logger.info("cooldown %ss before next shot", args.cooldown)
                time.sleep(args.cooldown)
        except Exception as e:
            logger.error("%s failed: %s", shot_id, e)
            results.append({"shot_id": shot_id, "error": str(e)})

    summary_path = run_dir / "v2_render_summary.json"
    merged = {}
    if summary_path.exists():
        for item in load_json(summary_path):
            merged[item.get("shot_id")] = item
    for item in results:
        merged[item.get("shot_id")] = item
    save_json(summary_path, [merged[k] for k in sorted(merged)], logger)
    comparison = build_comparison(run_dir, logger)
    print(json.dumps(comparison, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
