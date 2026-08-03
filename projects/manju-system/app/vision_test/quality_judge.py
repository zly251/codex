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


class QualityJudge:
    """Vision judge extended with human-acceptance fields for vision_quality_v2."""

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
        self.logger = logger or logging.getLogger("quality_judge")

    def judge(self, image_path, prompt):
        image_path = Path(image_path)
        if not image_path.exists():
            raise FileNotFoundError(f"image not found: {image_path}")
        image_b64 = _image_to_base64(image_path)
        system = (
            "你是抖音/红果短剧AI漫剧美术审核员。输入：一张分镜图片 + 当前生成prompt。\n"
            "严格输出JSON，不要输出其他文字。字段：\n"
            "character_quality(人物质量0-100,高分好；检查人脸、手脚、人物比例、服装一致),\n"
            "scene_quality(场景质量0-100,高分好；检查背景具体度、前后景、光影),\n"
            "composition_quality(构图质量0-100,高分好；检查是否像短剧镜头),\n"
            "ai_artifact_score(AI痕迹0-100,高分差；100=明显AI图,0=自然),\n"
            "character_identity(角色身份一致性0-100,高分一致),\n"
            "scene_realism(场景真实感0-100,高分真实),\n"
            "ai_artifact(AI痕迹0-100,与ai_artifact_score同义),\n"
            "human_acceptance_probability(人工验收通过概率0-100,高分更可能通过),\n"
            "problems(字符串数组,具体中文问题),\n"
            "prompt_fix(字符串数组,具体修改建议),\n"
            "rerender(布尔,是否重新生成)。\n"
            "problems和prompt_fix必须是数组。评分要严格。"
        )
        user = (
            f"图片路径: {image_path}\n"
            f"当前prompt:\n{json.dumps(prompt, ensure_ascii=False, indent=2)}"
        )
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user, "images": [image_b64]},
            ],
            "format": "json",
            "stream": False,
            "options": {"temperature": 0.2, "num_ctx": 8192},
        }
        last_error = None
        for attempt in range(1, 4):
            try:
                resp = httpx.post(
                    f"{self.base_url}/api/chat", json=payload, timeout=self.timeout
                )
                resp.raise_for_status()
                data = resp.json()
                content = (
                    (data.get("message") or {}).get("content")
                    or (data.get("response") or "")
                )
                raw = _extract_json(content)
                return self._normalize(raw)
            except Exception as e:
                last_error = str(e)
                self.logger.warning(
                    "quality judge attempt %s failed: %s", attempt, last_error
                )
                if attempt < 3:
                    time.sleep(3)
        raise RuntimeError(f"quality judge failed after 3 attempts: {last_error}")

    def _normalize(self, raw):
        if not isinstance(raw, dict):
            raise ValueError("model output is not an object")
        character = _clamp(raw.get("character_quality"))
        scene = _clamp(raw.get("scene_quality"))
        composition = _clamp(raw.get("composition_quality"))
        ai_artifact = _clamp(raw.get("ai_artifact_score"))
        if None in (character, scene, composition, ai_artifact):
            raise ValueError(
                "missing scores in model output: "
                + json.dumps(raw, ensure_ascii=False)
            )
        identity = _clamp(raw.get("character_identity"))
        if identity is None:
            identity = character
        realism = _clamp(raw.get("scene_realism"))
        if realism is None:
            realism = scene
        artifact = _clamp(raw.get("ai_artifact"))
        if artifact is None:
            artifact = ai_artifact
        acceptance = _clamp(raw.get("human_acceptance_probability"))
        if acceptance is None:
            acceptance = round(
                character * 0.3
                + scene * 0.3
                + composition * 0.2
                + (100 - ai_artifact) * 0.2,
                1,
            )
        problems = [
            str(p).strip()
            for p in _as_list(raw.get("problems"))
            if str(p).strip()
        ]
        prompt_fix = [
            str(p).strip()
            for p in _as_list(raw.get("prompt_fix"))
            if str(p).strip()
        ]
        rerender = bool(raw.get("rerender", False))
        if (
            character < 70
            or scene < 70
            or composition < 70
            or ai_artifact > 60
            or identity < 70
            or acceptance < 70
        ):
            rerender = True
        return {
            "character_quality": character,
            "scene_quality": scene,
            "composition_quality": composition,
            "ai_artifact_score": ai_artifact,
            "character_identity": identity,
            "scene_realism": realism,
            "ai_artifact": artifact,
            "human_acceptance_probability": acceptance,
            "problems": problems,
            "prompt_fix": prompt_fix,
            "rerender": rerender,
        }
