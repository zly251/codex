import json
import logging
import time
from pathlib import Path

import httpx

from app.vision_test.vision_judge import (
    _as_list,
    _clamp,
    _extract_json,
    _image_to_base64,
)


def _problem_text(value):
    if isinstance(value, dict):
        return str(
            value.get("problem")
            or value.get("reason")
            or value.get("type")
            or json.dumps(value, ensure_ascii=False)
        )
    return str(value)


class CharacterConsistencyTester:
    """Compares one character across 5 scene images with a local vision model."""

    def __init__(
        self,
        base_url="http://127.0.0.1:11434",
        model="qwen2.5vl:3b",
        timeout=300,
        logger=None,
    ):
        self.base_url = str(base_url).rstrip("/")
        self.model = model
        self.timeout = timeout
        self.logger = logger or logging.getLogger("consistency_test")

    def test(self, character_id, card, scenes):
        if len(scenes) < 2:
            raise ValueError("consistency test needs at least 2 scenes")
        images = []
        for scene in scenes:
            path = Path(scene["image_path"])
            if not path.exists():
                raise FileNotFoundError(f"image not found: {path}")
            images.append(_image_to_base64(path))
        scene_lines = [
            f"{i + 1}. {s.get('shot_id', '')}: {s.get('scene_summary', '')}"
            for i, s in enumerate(scenes)
        ]
        system = (
            "你是短剧角色一致性审核员。输入：同一角色的多张不同场景图片（按1-N顺序）+ 角色卡。\n"
            "严格输出JSON，不要输出其他文字。字段：\n"
            '{"face_shape_change":{"score":0-100,"changed":false,"problems":[]},'
            '"hair_style_change":{"score":0-100,"changed":false,"problems":[]},'
            '"age_change":{"score":0-100,"changed":false,"problems":[]},'
            '"clothing_change":{"score":0-100,"changed":false,"problems":[]},'
            '"overall_identity_score":0-100,'
            '"character_identity":0-100,'
            '"scene_realism":0-100,'
            '"ai_artifact":0-100,'
            '"human_acceptance_probability":0-100,'
            '"problems":[],"suggestions":[]}\n'
            "score语义：一致性得分高分=跨镜头稳定；ai_artifact高分=AI痕迹明显。"
        )
        user = (
            "角色卡:\n"
            + json.dumps(card, ensure_ascii=False, indent=2)
            + "\n\n场景:\n"
            + "\n".join(scene_lines)
        )
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user, "images": images},
            ],
            "stream": False,
            "options": {"temperature": 0.2, "num_ctx": 8192},
        }
        last_error = None
        for attempt in range(1, 4):
            try:
                resp = httpx.post(f"{self.base_url}/api/chat", json=payload, timeout=self.timeout)
                resp.raise_for_status()
                data = resp.json()
                content = (data.get("message") or {}).get("content") or (data.get("response") or "")
                raw = _extract_json(content)
                return self._normalize(raw)
            except Exception as e:
                last_error = str(e)
                self.logger.warning("consistency test attempt %s failed: %s", attempt, last_error)
                if attempt < 3:
                    time.sleep(3)
        raise RuntimeError(f"consistency test failed after 3 attempts: {last_error}")

    def _normalize(self, raw):
        if not isinstance(raw, dict):
            raise ValueError("model output is not an object")
        metric_keys = (
            "face_shape_change",
            "hair_style_change",
            "age_change",
            "clothing_change",
        )
        metrics = {}
        for key in metric_keys:
            item = raw.get(key)
            if not isinstance(item, dict):
                item = {}
            score = _clamp(item.get("score"))
            if score is None:
                score = 50.0
            problems = [
                _problem_text(p).strip()
                for p in _as_list(item.get("problems"))
                if _problem_text(p).strip()
            ]
            metrics[key] = {
                "score": score,
                "changed": bool(item.get("changed", False)),
                "problems": problems,
            }

        identity = _clamp(raw.get("character_identity"))
        if identity is None:
            identity = _clamp(raw.get("overall_identity_score"))
        if identity is None:
            identity = round(sum(m["score"] for m in metrics.values()) / len(metrics), 1)
        realism = _clamp(raw.get("scene_realism"))
        if realism is None:
            realism = 50.0
        artifact = _clamp(raw.get("ai_artifact"))
        if artifact is None:
            artifact = 50.0
        acceptance = _clamp(raw.get("human_acceptance_probability"))
        if acceptance is None:
            acceptance = round(identity * 0.6 + realism * 0.2 + (100 - artifact) * 0.2, 1)
        problems = [
            _problem_text(p).strip()
            for p in _as_list(raw.get("problems"))
            if _problem_text(p).strip()
        ]
        suggestions = [
            _problem_text(p).strip()
            for p in _as_list(raw.get("suggestions"))
            if _problem_text(p).strip()
        ]
        if identity >= 80 and artifact <= 50 and acceptance >= 70:
            conclusion = "pass"
        elif identity >= 60:
            conclusion = "review"
        else:
            conclusion = "fail"
        return {
            "metrics": metrics,
            "overall_identity_score": identity,
            "character_identity": identity,
            "scene_realism": realism,
            "ai_artifact": artifact,
            "human_acceptance_probability": acceptance,
            "problems": problems,
            "suggestions": suggestions,
            "conclusion": conclusion,
        }
