import json
import re
import sys
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[2]


ACTION_MAP = {
    "character_error": "character_card_boost",
    "scene_empty": "use_scene_template",
    "composition_error": "modify_camera_language",
    "bad_anatomy": "add_negative_and_face_detailer",
    "ai_artifact": "change_seed_and_sampler",
    "style_inconsistent": "fix_style_prefix",
}

KEYWORD_RULES = {
    "character_error": (
        "face",
        "character",
        "clothing",
        "outfit",
        "clothes",
        "appearance",
        "人物",
        "角色",
        "脸",
        "服装",
        "衣服",
        "发型",
        "五官",
    ),
    "scene_empty": (
        "scene",
        "background",
        "environment",
        "empty",
        "space",
        "场景",
        "背景",
        "环境",
        "空间",
    ),
    "composition_error": (
        "composition",
        "camera",
        "shot",
        "framing",
        "subject",
        "构图",
        "镜头",
        "景别",
    ),
    "bad_anatomy": (
        "hand",
        "limb",
        "proportion",
        "anatomy",
        "deformed",
        "手",
        "脚",
        "肢体",
        "比例",
        "畸形",
        "手指",
    ),
    "ai_artifact": (
        "artifact",
        "plastic",
        "oversaturated",
        "jpeg",
        "blurry",
        "痕迹",
        "贴图",
        "模糊",
        "水印",
    ),
    "style_inconsistent": (
        "style",
        "inconsistent",
        "consistent",
        "uniform",
        "mismatch",
        "画风",
        "风格",
        "不统一",
        "一致",
        "统一",
    ),
}


def _flatten(values):
    result = []
    for value in values or []:
        if isinstance(value, (list, tuple)):
            result.extend(_flatten(value))
        else:
            result.append(str(value))
    return result


class VisualIssueClassifier:
    def classify(self, report):
        candidates = {}

        def add(issue_type, confidence):
            current = candidates.get(issue_type)
            if current is None or confidence > current["confidence"]:
                candidates[issue_type] = {
                    "confidence": round(max(0.0, min(1.0, confidence)), 2),
                    "action": ACTION_MAP[issue_type],
                }

        texts = _flatten(report.get("problems")) + _flatten(report.get("prompt_fix"))
        for text in texts:
            lower = text.lower()
            for issue_type, keywords in KEYWORD_RULES.items():
                matched = any(keyword in lower for keyword in keywords)
                if issue_type == "ai_artifact" and re.search(r"\bai\b", lower):
                    matched = True
                if matched:
                    add(issue_type, 0.85)

        character = report.get("character_quality")
        scene = report.get("scene_quality")
        composition = report.get("composition_quality")
        artifact = report.get("ai_artifact_score")
        if character is not None and character < 70:
            add("character_error", 0.7 + (70 - character) / 100)
        if scene is not None and scene < 70:
            add("scene_empty", 0.7 + (70 - scene) / 100)
        if composition is not None and composition < 70:
            add("composition_error", 0.7 + (70 - composition) / 100)
        if artifact is not None and artifact > 60:
            add("ai_artifact", 0.7 + (artifact - 60) / 100)

        issues = [
            {
                "type": issue_type,
                "confidence": candidates[issue_type]["confidence"],
                "action": candidates[issue_type]["action"],
            }
            for issue_type in sorted(candidates)
        ]
        issue_types = set(candidates)
        render_strategy = {
            "change_prompt": bool(
                issue_types
                & {
                    "character_error",
                    "scene_empty",
                    "composition_error",
                    "bad_anatomy",
                    "style_inconsistent",
                }
            ),
            "change_seed": "ai_artifact" in issue_types,
            "enable_detailer": "bad_anatomy" in issue_types,
        }
        return {"issues": issues, "render_strategy": render_strategy}


if __name__ == "__main__":
    input_path = PROJECT_DIR / "data" / "vision_test" / "vision_report.json"
    output_path = PROJECT_DIR / "data" / "vision_test" / "visual_action.json"
    if not input_path.exists():
        raise FileNotFoundError(f"vision_report not found: {input_path}")
    report = json.loads(input_path.read_text(encoding="utf-8"))
    result = VisualIssueClassifier().classify(report)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
