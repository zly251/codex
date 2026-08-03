import base64
import io
import json
import logging
import re
import time
from pathlib import Path

import httpx

try:
    from PIL import Image
except ImportError:
    Image = None


def _image_to_base64(path, max_side=768, quality=85):
    if Image is None:
        raise RuntimeError("Pillow is required")
    with Image.open(path) as img:
        img = img.convert("RGB")
        img.thumbnail((max_side, max_side), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=quality)
        return base64.b64encode(buf.getvalue()).decode("ascii")


def _extract_json(text):
    text = (text or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("no JSON object in model output")
    return json.loads(text[start : end + 1])


def _as_list(value):
    if value is None:
        return []
    if isinstance(value, list):
        flattened = []
        for item in value:
            if isinstance(item, list):
                flattened.extend(item)
            else:
                flattened.append(item)
        return flattened
    return [value]


def _clamp(value):
    if isinstance(value, list | tuple):
        values = [_clamp(v) for v in value]
        values = [v for v in values if v is not None]
        if not values:
            return None
        return round(sum(values) / len(values), 1)
    try:
        score = float(value)
    except (TypeError, ValueError):
        return None
    return round(max(0.0, min(100.0, score)), 1)


class VisionJudge:
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
        self.logger = logger or logging.getLogger("vision_judge")

    def judge(self, image_path, prompt):
        image_path = Path(image_path)
        if not image_path.exists():
            raise FileNotFoundError(f"image not found: {image_path}")
        image_b64 = _image_to_base64(image_path)
        system = (
            "你是抖音/红果短剧AI漫剧美术审核员。输入：一张分镜图片 + 当前生成prompt。"
            "严格输出JSON，不要输出其他文字。字段："
            "character_quality(人物质量0-100,高分好；检查人脸是否异常、手脚是否异常、人物比例、服装一致),"
            "scene_quality(场景质量0-100,高分好；检查背景是否具体、前后景、光影、是否像AI贴图),"
            "composition_quality(构图质量0-100,高分好；检查是否像短剧镜头、主体明确、景别合理),"
            "ai_artifact_score(AI痕迹0-100,高分差；100=明显AI图片,0=自然),"
            "problems(字符串数组,具体中文问题),"
            "prompt_fix(字符串数组,具体修改建议),"
            "rerender(布尔,是否需要重新生成)。"
            "problems和prompt_fix必须是数组，禁止输出字符串。评分要严格。"
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
                resp = httpx.post(f"{self.base_url}/api/chat", json=payload, timeout=self.timeout)
                resp.raise_for_status()
                data = resp.json()
                content = (data.get("message") or {}).get("content") or (data.get("response") or "")
                raw = _extract_json(content)
                return self._normalize(raw)
            except Exception as e:
                last_error = str(e)
                self.logger.warning("vision judge attempt %s failed: %s", attempt, last_error)
                if attempt < 3:
                    time.sleep(3)
        raise RuntimeError(f"vision judge failed after 3 attempts: {last_error}")

    def _normalize(self, raw):
        if not isinstance(raw, dict):
            raise ValueError("model output is not an object")
        character = _clamp(raw.get("character_quality"))
        scene = _clamp(raw.get("scene_quality"))
        composition = _clamp(raw.get("composition_quality"))
        ai_artifact = _clamp(raw.get("ai_artifact_score"))
        if None in (character, scene, composition, ai_artifact):
            raise ValueError(
                "missing scores in model output: " + json.dumps(raw, ensure_ascii=False)
            )
        problems = [str(p).strip() for p in _as_list(raw.get("problems")) if str(p).strip()]
        prompt_fix = [str(p).strip() for p in _as_list(raw.get("prompt_fix")) if str(p).strip()]
        rerender = bool(raw.get("rerender", False))
        if character < 70 or scene < 70 or composition < 70 or ai_artifact > 60:
            rerender = True
        return {
            "character_quality": character,
            "scene_quality": scene,
            "composition_quality": composition,
            "ai_artifact_score": ai_artifact,
            "problems": problems,
            "prompt_fix": prompt_fix,
            "rerender": rerender,
        }
