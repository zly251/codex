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


_FIX_RULES = [
    (
        ("hand", "limb", "proportion", "face", "character", "人物", "手", "脸", "比例"),
        (
            "correct hand anatomy, natural facial features, natural body proportions",
            "extra hands, extra limbs, deformed hands, bad proportions, unnatural face",
            "人物描述",
        ),
    ),
    (
        ("background", "scene", "blur", "环境", "背景", "场景"),
        (
            "detailed concrete background, clear foreground and background layers, coherent lighting",
            "blurry background, empty background",
            "场景描述",
        ),
    ),
    (
        ("composition", "camera", "shot", "构图", "镜头"),
        (
            "short-drama cinematic composition, clear subject focus, balanced framing",
            "cluttered composition, off-center subject",
            "镜头语言",
        ),
    ),
    (
        ("ai artifact", "ai-generated", "artificial", "ai style", "痕迹", "贴图"),
        (
            "natural texture, film-like short drama still",
            "AI artifacts, plastic skin, oversaturated, jpeg artifacts",
            "负面词",
        ),
    ),
]


def _append_fix(text, fix):
    if not fix or fix in text:
        return text, False
    return text + ", " + fix, True


def _apply_fixes(prompt, report):
    positive = str(prompt.get("positive", "")).strip()
    negative = str(prompt.get("negative", "")).strip()
    changed = set()

    for fix in _as_list(report.get("prompt_fix")) + _as_list(report.get("problems")):
        text = str(fix).lower()
        for keywords, (pos_fix, neg_fix, label) in _FIX_RULES:
            if any(keyword in text for keyword in keywords):
                positive, pos_changed = _append_fix(positive, pos_fix)
                negative, neg_changed = _append_fix(negative, neg_fix)
                if pos_changed or neg_changed:
                    changed.add(label)
                break

    character = report.get("character_quality")
    scene = report.get("scene_quality")
    composition = report.get("composition_quality")
    ai_artifact = report.get("ai_artifact_score")
    if character is not None and character < 70:
        positive, p1 = _append_fix(
            positive,
            "natural facial features, correct hand anatomy, natural body proportions",
        )
        negative, n1 = _append_fix(
            negative, "bad anatomy, deformed face, extra hands, unnatural proportions"
        )
        if p1 or n1:
            changed.add("人物描述")
    if scene is not None and scene < 70:
        positive, p2 = _append_fix(
            positive,
            "specific background details, clear spatial depth, realistic lighting",
        )
        negative, n2 = _append_fix(negative, "blurry background, empty background, AI texture")
        if p2 or n2:
            changed.add("场景描述")
    if composition is not None and composition < 70:
        positive, p3 = _append_fix(
            positive,
            "short-drama cinematic composition, clear subject focus, balanced framing",
        )
        if p3:
            changed.add("镜头语言")
    if ai_artifact is not None and ai_artifact > 60:
        negative, n4 = _append_fix(
            negative, "AI artifacts, plastic skin, oversaturated, jpeg artifacts"
        )
        if n4:
            changed.add("负面词")

    return {
        "shot_id": prompt.get("shot_id"),
        "positive": positive,
        "negative": negative,
        "changed_parts": sorted(changed),
        "reason": "基于视觉审核报告进行定向修改，保留原剧情与镜头内容。",
        "original_prompt": prompt,
    }


class PromptFeedback:
    def __init__(
        self,
        base_url="http://127.0.0.1:11434",
        model="qwen2.5vl:3b",
        timeout=300,
    ):
        self.base_url = str(base_url).rstrip("/")
        self.model = model
        self.timeout = timeout

    def generate(self, prompt, report):
        return _apply_fixes(prompt, report)
