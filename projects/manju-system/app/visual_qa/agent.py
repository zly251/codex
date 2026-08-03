import json
import math
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image


def _clamp(value, low=0.0, high=100.0):
    return max(low, min(high, value))


def _pixel_metrics(image_path, expected_size=None):
    img = Image.open(image_path).convert("RGB")
    width, height = img.size
    size_ok = True
    if expected_size:
        exp_w, exp_h = expected_size
        size_ok = (width == exp_w and height == exp_h)

    arr = np.asarray(img, dtype=np.float32)
    gray = arr.mean(axis=2)
    h, w = gray.shape
    lap = (
        4.0 * gray[1:-1, 1:-1]
        - gray[:-2, 1:-1]
        - gray[2:, 1:-1]
        - gray[1:-1, :-2]
        - gray[1:-1, 2:]
    )
    sharpness_var = float(lap.var())

    hsv = np.asarray(img.convert("HSV"), dtype=np.float32)
    saturation = float(hsv[:, :, 1].mean())
    brightness = float(arr.mean())
    contrast = float(arr.std())

    sharp_score = _clamp(100.0 * (1.0 - math.exp(-sharpness_var / 500.0)))
    brightness_score = _clamp(100.0 * math.exp(-(((brightness - 128.0) / 72.0) ** 2)))
    contrast_score = _clamp(100.0 - abs(contrast - 58.0) * 1.1)
    saturation_score = _clamp(saturation * 2.2 * 100.0)
    size_score = 100.0 if size_ok else 55.0
    quality = (
        0.35 * sharp_score
        + 0.25 * brightness_score
        + 0.20 * contrast_score
        + 0.12 * saturation_score
        + 0.08 * size_score
    )
    return {
        "size_ok": size_ok,
        "sharpness_var": round(sharpness_var, 2),
        "brightness": round(brightness, 2),
        "contrast": round(contrast, 2),
        "saturation": round(saturation, 3),
        "sharp_score": round(sharp_score, 2),
        "brightness_score": round(brightness_score, 2),
        "contrast_score": round(contrast_score, 2),
        "saturation_score": round(saturation_score, 2),
        "size_score": round(size_score, 2),
        "quality": round(quality, 2),
    }


def _image_text_score(sim):
    return _clamp((sim - 0.16) / 0.14 * 100.0)


def _image_image_score(sim):
    return _clamp((sim - 0.55) / 0.35 * 100.0)


class VisualQAAgent:
    def __init__(self, project_dir, config, logger):
        self.project_dir = Path(project_dir)
        cfg = config.get("visual_qa", {})
        self.enabled = bool(cfg.get("enabled", True))
        self.threshold = float(cfg.get("pass_threshold", 70))
        self.max_retries = int(cfg.get("max_retries", 2))
        clip_cfg = cfg.get("clip", {})
        self.worker_python = clip_cfg.get("worker_python", "")
        self.hf_mirror = clip_cfg.get("hf_mirror", "")
        self.device = clip_cfg.get("device", "cpu")
        self.model_path = self.project_dir / clip_cfg.get(
            "model_path", "models/clip/openai-clip-vit-base-patch32"
        )
        self.logger = logger
        self.worker_script = str(Path(__file__).resolve().parent / "clip_worker.py")

    def run(self, image_path, shot, storyboard_shot, reference_image_path=None):
        if not self.enabled:
            return {
                "enabled": False,
                "needs_regenerate": False,
                "scores": {"total": 100.0},
                "reason": "visual qa disabled",
            }

        metrics = _pixel_metrics(image_path, (shot.get("width"), shot.get("height")))
        story = storyboard_shot or {}
        characters = story.get("characters") or []
        character_name = characters[0].get("name", "主角") if characters else "主角"
        scene_text = shot.get("positive", "") or "，".join(
            str(part)
            for part in [
                story.get("location"),
                story.get("time"),
                story.get("mood"),
                " ".join(story.get("action", [])),
            ]
            if part
        )
        character_text = shot.get("positive", "") or "，".join(
            str(part)
            for part in [
                character_name,
                characters[0].get("emotion") if characters else "",
                characters[0].get("pose") if characters else "",
            ]
            if part
        ) or character_name

        clip = self._run_clip_worker(
            image_path, scene_text, character_text, reference_image_path
        )
        if reference_image_path and clip.get("reference_sim") is not None:
            character_score = _image_image_score(clip["reference_sim"])
            character_detail = "image-image vs reference shot"
        else:
            character_score = _image_text_score(clip["character_text_sim"])
            character_detail = "image-text vs character description"
        scene_score = _image_text_score(clip["scene_sim"])
        quality_score = metrics["quality"]

        total = 0.35 * character_score + 0.35 * scene_score + 0.30 * quality_score
        scores = {
            "character_consistency": round(character_score, 2),
            "scene_compliance": round(scene_score, 2),
            "image_quality": round(quality_score, 2),
            "total": round(total, 2),
        }
        low_parts = [
            name
            for name, value in [
                ("character_consistency", character_score),
                ("scene_compliance", scene_score),
                ("image_quality", quality_score),
            ]
            if value < self.threshold
        ]
        needs_regenerate = total < self.threshold
        reason = (
            f"total={scores['total']} below threshold {self.threshold}; weak: "
            + (", ".join(low_parts) if low_parts else "none")
            + f"; character={character_detail}; backend=clip"
            if needs_regenerate
            else f"total={scores['total']} passed threshold {self.threshold}; backend=clip"
        )
        return {
            "enabled": True,
            "shot_id": shot.get("shot_id"),
            "character_name": character_name,
            "character_detail": character_detail,
            "raw_clip": clip,
            "pixel_metrics": metrics,
            "scores": scores,
            "needs_regenerate": needs_regenerate,
            "reason": reason,
        }

    def _run_clip_worker(self, image_path, scene_text, character_text, reference_image_path):
        cmd = [self.worker_python, self.worker_script, "--image", str(image_path)]
        cmd += ["--scene-text", scene_text]
        cmd += ["--character-text", character_text]
        cmd += ["--model-path", str(self.model_path)]
        if self.hf_mirror:
            cmd += ["--hf-mirror", self.hf_mirror]
        cmd += ["--device", self.device]
        if reference_image_path:
            cmd += ["--reference-image", str(reference_image_path)]
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=300,
        )
        if result.returncode != 0:
            err = (result.stderr or "")[-800:]
            self.logger.error("clip worker failed: %s", err)
            raise RuntimeError("CLIP worker failed: " + err[-300:])
        return json.loads(result.stdout.strip().splitlines()[-1])
