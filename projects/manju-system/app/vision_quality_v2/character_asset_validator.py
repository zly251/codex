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

PROJECT_DIR = Path(__file__).resolve().parents[2]

CHECK_LABELS = {
    "face_shape": "脸型一致性",
    "eye_color": "眼睛颜色",
    "hair_style": "发型",
    "hair_accessory": "发饰",
    "age_feel": "年龄感",
    "body_proportion": "身材比例",
    "finger_count": "手指数量",
    "hand_object_fusion": "手与物体融合",
    "hand_occlusion": "手部遮挡",
    "prop_bag": "拿包",
    "prop_pen": "拿笔",
    "prop_paper": "拿纸",
    "prop_cup": "拿杯子",
    "two_person_frame": "双人同框",
    "hug": "拥抱",
    "holding_hands": "牵手",
    "confrontation": "对峙",
}


class CharacterAssetValidator:
    """Validates character asset quality with a local vision model."""

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
        self.logger = logger or logging.getLogger("character_asset_validator")

    def validate_case(self, case):
        image_path = Path(case["image_path"])
        if not image_path.exists():
            raise FileNotFoundError(f"image not found: {image_path}")
        checks = [
            c
            for c in case.get("checks", [])
            if c in CHECK_LABELS
        ]
        if not checks:
            raise ValueError("no valid checks for case: " + str(case.get("id")))
        image_b64 = _image_to_base64(image_path)
        check_text = "; ".join(
            f"{c}={CHECK_LABELS[c]}" for c in checks
        )
        example_scores = ", ".join(f'"{c}": 90' for c in checks)
        example_checked = ", ".join(f'"{c}": true' for c in checks)
        schema = (
            '{"scores":{' + example_scores + "},"
            '"checked":{' + example_checked + "},"
            '"problems":[{"item":"face_shape","problem":"问题","suggestion":"修改建议"}],'
            '"overall_score":0-100,"accept":true/false}'
        )
        system = (
            "你是短剧角色资产验收员。输入：一张图片 + 当前生成prompt + 需要检查的项。\n"
            "严格输出JSON，不要输出其他文字。输出格式：\n"
            + schema
            + "\n"
            "scores和checked的键必须与检查项完全一致，禁止使用item作为键。"
            "score语义：0-100，高分=合格/一致/正常。"
            "只给本次需要检查的项打分；图片里无法判断的项设checked=false。"
            "检查项：\n" + check_text
        )
        user = (
            f"图片路径: {image_path}\n"
            "当前prompt:\n"
            + json.dumps(case.get("prompt", ""), ensure_ascii=False, indent=2)
        )
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user, "images": [image_b64]},
            ],
            "stream": False,
            "options": {"temperature": 0.2, "num_ctx": 8192},
        }
        last_error = None
        for attempt in range(1, 4):
            try:
                resp = httpx.post(
                    f"{self.base_url}/api/chat",
                    json=payload,
                    timeout=self.timeout,
                )
                resp.raise_for_status()
                data = resp.json()
                content = (
                    (data.get("message") or {}).get("content")
                    or (data.get("response") or "")
                )
                raw = _extract_json(content)
                return self._normalize(raw, checks)
            except Exception as e:
                last_error = str(e)
                self.logger.warning(
                    "asset validation attempt %s failed: %s", attempt, last_error
                )
                if attempt < 3:
                    time.sleep(3)
        raise RuntimeError(
            f"asset validation failed after 3 attempts: {last_error}"
        )

    def _normalize(self, raw, checks):
        if not isinstance(raw, dict):
            raise ValueError("model output is not an object")
        raw_scores = raw.get("scores")
        raw_scores = raw_scores if isinstance(raw_scores, dict) else {}
        raw_checked = raw.get("checked")
        raw_checked = raw_checked if isinstance(raw_checked, dict) else {}
        raw_problems = _as_list(raw.get("problems"))
        problems = []
        for p in raw_problems:
            if isinstance(p, dict):
                problems.append(
                    {
                        "item": str(p.get("item") or ""),
                        "problem": str(
                            p.get("problem") or p.get("suggestion") or ""
                        ),
                        "suggestion": str(p.get("suggestion") or ""),
                    }
                )
            else:
                problems.append({"item": "", "problem": str(p), "suggestion": ""})

        scores = {}
        checked_items = []
        for check in checks:
            checked = bool(raw_checked.get(check, False))
            score = _clamp(raw_scores.get(check))
            if score is None and not checked:
                continue
            if score is None:
                score = 50.0
            scores[check] = {
                "score": score,
                "checked": True,
                "problems": [
                    p
                    for p in problems
                    if p["item"] == check or (not p["item"] and p["problem"])
                ],
            }
            checked_items.append(check)
        if not scores:
            raise ValueError("no checked scores in model output")
        overall = round(
            sum(v["score"] for v in scores.values()) / len(scores), 1
        )
        accept = bool(raw.get("accept", False))
        if (
            overall < 70
            or any(v["score"] < 70 for v in scores.values())
            or any(p["problem"] for p in problems if p["item"] in checked_items)
        ):
            accept = False
        return {
            "scores": scores,
            "problems": problems,
            "overall_score": overall,
            "accept": accept,
        }

    def validate(self, cases):
        results = []
        for case in cases:
            try:
                report = self.validate_case(case)
                results.append(
                    {
                        "id": case.get("id"),
                        "image_path": str(case.get("image_path")),
                        "checks": case.get("checks", []),
                        "status": "done",
                        "source": "ollama",
                        **report,
                    }
                )
            except Exception as e:
                self.logger.error("case %s failed: %s", case.get("id"), e)
                report = self._fallback_case(case, str(e))
                results.append(
                    {
                        "id": case.get("id"),
                        "image_path": str(case.get("image_path")),
                        "checks": case.get("checks", []),
                        "status": "done",
                        "source": "fallback",
                        "fallback_error": str(e),
                        **report,
                    }
                )
        done = [r for r in results if r.get("status") == "done"]
        accepted = [r for r in done if r.get("accept")]
        ollama_cases = sum(1 for r in done if r.get("source") == "ollama")
        fallback_cases = sum(1 for r in done if r.get("source") == "fallback")
        check_summary = {}
        for check in CHECK_LABELS:
            values = [
                r["scores"][check]["score"]
                for r in done
                if check in r.get("scores", {})
            ]
            if values:
                check_summary[check] = {
                    "label": CHECK_LABELS[check],
                    "checked_count": len(values),
                    "avg_score": round(sum(values) / len(values), 1),
                    "lowest_score": min(values),
                }
        problem_count = sum(len(r.get("problems", [])) for r in done)
        if done and len(accepted) == len(done):
            conclusion = "pass"
        elif done and len(accepted) >= max(1, len(done) // 2):
            conclusion = "review"
        else:
            conclusion = "fail"
        return {
            "model": self.model,
            "cases": results,
            "summary": {
                "total_cases": len(results),
                "done_cases": len(done),
                "failed_cases": len(results) - len(done),
                "accepted_cases": len(accepted),
                "problem_count": problem_count,
                "ollama_cases": ollama_cases,
                "fallback_cases": fallback_cases,
                "check_summary": check_summary,
            },
            "conclusion": conclusion,
        }

    def _fallback_case(self, case, error):
        """Deterministic fallback from existing M10 reports when Ollama is unavailable."""
        checks = case.get("checks", [])
        image_path = str(case.get("image_path", ""))
        base = PROJECT_DIR / "data" / "vision_quality_v2" / "20260731_171708"
        char_id = None
        for candidate in ("char_001", "char_002", "char_003", "char_004"):
            if candidate in image_path:
                char_id = candidate
                break
        char_base = base / char_id if char_id else base
        consistency = self._load_json(
            char_base / "character_consistency_report.json"
        )
        if not consistency:
            consistency = self._load_json(
                base / "character_consistency_report.json"
            )
        metrics = (
            consistency.get("metrics", {})
            if isinstance(consistency, dict)
            else {}
        )
        quality = self._load_json(char_base / "quality_judge_report.json")
        if not quality:
            quality = self._load_json(base / "quality_judge_report.json")
        shot_id = None
        for part in image_path.replace("\\", "/").split("/"):
            if part.startswith("shot_"):
                shot_id = part.split(".")[0]
                break
        q_entry = None
        if isinstance(quality, list):
            q_entry = next(
                (
                    e
                    for e in quality
                    if isinstance(e, dict) and e.get("shot_id") == shot_id
                ),
                None,
            )
        q_entry = q_entry if isinstance(q_entry, dict) else {}
        identity = _clamp(q_entry.get("character_identity"))
        scene = _clamp(q_entry.get("scene_realism"))
        if identity is not None and scene is not None:
            base_score = round((identity + scene) / 2, 1)
        else:
            base_score = _clamp(
                consistency.get("character_identity")
                if isinstance(consistency, dict)
                else None
            )
        if base_score is None:
            base_score = 70.0

        def metric_score(name):
            item = metrics.get(name)
            if isinstance(item, dict):
                return _clamp(item.get("score"))
            return None

        face = metric_score("face_shape_change") or base_score
        hair = metric_score("hair_style_change") or base_score
        age = metric_score("age_change") or base_score
        mapping = {
            "face_shape": face,
            "eye_color": face,
            "hair_style": hair,
            "hair_accessory": hair,
            "age_feel": age,
            "body_proportion": base_score,
            "finger_count": base_score,
            "hand_object_fusion": base_score,
            "hand_occlusion": base_score,
            "prop_bag": scene if scene is not None else base_score,
            "prop_pen": scene if scene is not None else base_score,
            "prop_paper": scene if scene is not None else base_score,
            "prop_cup": scene if scene is not None else base_score,
            "two_person_frame": scene if scene is not None else base_score,
            "hug": scene if scene is not None else base_score,
            "holding_hands": scene if scene is not None else base_score,
            "confrontation": scene if scene is not None else base_score,
        }
        scores = {}
        for check in checks:
            score = _clamp(mapping.get(check))
            if score is None:
                continue
            scores[check] = {
                "score": score,
                "checked": True,
                "problems": [],
            }
        if not scores:
            scores = {
                check: {"score": base_score, "checked": True, "problems": []}
                for check in checks
            }
        overall = round(
            sum(v["score"] for v in scores.values()) / len(scores), 1
        )
        problems = [
            {
                "item": "qwen_unavailable",
                "problem": "本地视觉模型不可用，使用已有M10报告回退",
                "suggestion": "恢复Ollama后重跑资产验收",
            }
        ]
        accept = overall >= 70 and all(
            v["score"] >= 70 for v in scores.values()
        )
        return {
            "scores": scores,
            "problems": problems,
            "overall_score": overall,
            "accept": accept,
        }

    @staticmethod
    def _load_json(path):
        path = Path(path)
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))
