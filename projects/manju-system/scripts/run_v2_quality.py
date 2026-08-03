import argparse
import base64
import io
import json
import re
import sys
import time
from datetime import datetime
from pathlib import Path

import httpx

try:
    from PIL import Image
except ImportError:
    Image = None


PROJECT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_DIR))


def load_config():
    return json.loads(
        (PROJECT_DIR / "config" / "config.json").read_text(encoding="utf-8")
    )


def load_json(path):
    path = Path(path)
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def extract_json(text):
    text = (text or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("no JSON object in model output")
    return json.loads(text[start : end + 1])


def image_to_base64(path, max_side=768, quality=85):
    if Image is None:
        raise RuntimeError("Pillow is required")
    with Image.open(path) as img:
        img = img.convert("RGB")
        img.thumbnail((max_side, max_side), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=quality)
        return base64.b64encode(buf.getvalue()).decode("ascii")


def clamp_score(value):
    if isinstance(value, (list, tuple)):
        values = [clamp_score(v) for v in value]
        values = [v for v in values if v is not None]
        if not values:
            return None
        return round(sum(values) / len(values), 1)
    try:
        score = float(value)
    except (TypeError, ValueError):
        return None
    return round(max(0.0, min(100.0, score)), 1)


def as_list(value):
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def normalize_problem(text):
    text = str(text).strip()
    if not text:
        return ""
    prefixes = ["人物问题", "场景问题", "构图问题", "AI痕迹"]
    if any(text.startswith(p) for p in prefixes):
        return text
    if "人物" in text or "角色" in text or "脸" in text or "手" in text:
        return "人物问题：" + text
    if "场景" in text or "背景" in text or "空间" in text:
        return "场景问题：" + text
    if "构图" in text or "镜头" in text or "画面重心" in text:
        return "构图问题：" + text
    if "AI" in text or "贴图" in text or "模糊" in text:
        return "AI痕迹：" + text
    return "其他：" + text


def judge_shot(config, image_path, shot, context, timeout=900):
    cfg = config.get("visual_judge", {})
    base_url = str(cfg.get("base_url", "http://127.0.0.1:11434")).rstrip("/")
    model = str(cfg.get("model", "qwen2.5vl:3b"))
    image_b64 = image_to_base64(image_path)

    system = (
        "你是抖音/红果短剧AI漫剧质检员。输入为单张分镜图片、分镜prompt、角色卡和CLIP QA指标。"
        "严格输出JSON，不要输出其他文字。problems必须是字符串数组，禁止输出字符串；"
        "每条problems必须用中文短句，并以人物问题:/场景问题:/构图问题:/AI痕迹:开头。"
        "suggestions必须是字符串数组，用中文，必须明确说明是否重新生成，以及是否需要IPAdapter/ControlNet。"
        "字段："
        "character_score(人物一致性:五官自然、角色一致、手部正常、服装连续,0-100),"
        "scene_score(场景符合度:空间明确、前后景存在、光影合理、不像AI贴图,0-100),"
        "composition_score(构图:主体明确、景别合理、画面重心,0-100),"
        "commercial_score(商业短剧观感:是否像短剧截图、是否有观看欲望,0-100),"
        "problems(字符串数组),"
        "suggestions(字符串数组)。"
        "四个评分字段必须是单个数字0-100，禁止输出数组。"
        "评分要严格：图片模糊、人物不一致、场景混乱、AI贴图感严重时对应分数不能超过60；"
        "参考CLIP QA分数，不要只给描述。"
    )
    user = (
        f"请验收以下单镜头。\n"
        f"分镜ID: {shot.get('shot_id')}\n"
        f"分镜prompt: {shot.get('positive', '')}\n"
        f"角色卡: {json.dumps(context['characters'], ensure_ascii=False)}\n"
        f"CLIP QA: {json.dumps(context['clip_qa'], ensure_ascii=False)}\n"
        f"剧情: {context.get('story', '')}"
    )
    payload = {
        "model": model,
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
                f"{base_url}/api/chat", json=payload, timeout=timeout
            )
            resp.raise_for_status()
            data = resp.json()
            content = (
                (data.get("message") or {}).get("content")
                or (data.get("response") or "")
            )
            judge = extract_json(content)
            if not isinstance(judge, dict):
                raise ValueError("model output is not an object")
            return judge
        except Exception as e:
            last_error = str(e)
            print(
                f"[{shot.get('shot_id')}] judge attempt {attempt} failed: {last_error}",
                flush=True,
            )
            if attempt < 3:
                time.sleep(5)
    raise RuntimeError(f"judge failed after 3 attempts: {last_error}")


def build_quality_report(run_dir, results):
    valid = [r for r in results if r.get("total_score") is not None]
    avg = (
        round(sum(r["total_score"] for r in valid) / len(valid), 2)
        if valid
        else None
    )
    pass_count = sum(1 for r in valid if r["total_score"] >= 70)
    worst = sorted(valid, key=lambda r: r["total_score"])[:5]
    commercial_values = [
        r["commercial_score"]
        for r in results
        if r.get("commercial_score") is not None
    ]
    commercial_avg = (
        round(sum(commercial_values) / len(commercial_values), 2)
        if commercial_values
        else None
    )
    commercial_min = min(commercial_values) if commercial_values else None
    commercial_below_70 = [
        r["shot_id"]
        for r in results
        if (r.get("commercial_score") or 100) < 70
    ]
    summary_data = load_json(run_dir / "v2_render_summary.json") or []
    clip_totals = [
        item.get("qa_total")
        for item in summary_data
        if item.get("qa_total") is not None
    ]
    clip_qa_average = (
        round(sum(clip_totals) / len(clip_totals), 2) if clip_totals else None
    )

    failure_stats = {}
    for r in results:
        for problem in r.get("problems") or []:
            text = str(problem)
            if text.startswith("人物"):
                key = "人物问题"
            elif text.startswith("场景"):
                key = "场景问题"
            elif text.startswith("构图"):
                key = "构图问题"
            elif "AI" in text[:8] or "痕迹" in text:
                key = "AI痕迹"
            else:
                key = "其他"
            failure_stats[key] = failure_stats.get(key, 0) + 1

    suggestion_counts = {}
    for r in results:
        for suggestion in r.get("suggestions") or []:
            text = str(suggestion).strip()
            if not text:
                continue
            suggestion_counts[text] = suggestion_counts.get(text, 0) + 1
    next_stage_suggestions = sorted(
        suggestion_counts.items(), key=lambda x: x[1], reverse=True
    )[:12]
    next_stage_suggestions = [
        text if count == 1 else f"{text} ({count}次)"
        for text, count in next_stage_suggestions
    ]

    regenerate = [r["shot_id"] for r in valid if r["regenerate"]]
    threshold_pass = len(valid) > 0 and not regenerate
    publishable = bool(
        threshold_pass
        and commercial_avg is not None
        and commercial_min is not None
        and commercial_avg >= 70
        and commercial_min >= 60
    )
    conclusion = "可发布" if publishable else "暂不建议正式发布"
    report = {
        "run_id": run_dir.name,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "model": "qwen2.5vl:3b",
        "method": "Visual Judge + CLIP QA，总分=人物30%+场景30%+构图20%+商业20%",
        "shot_count": len(valid),
        "average_total": avg,
        "pass_rate": (
            round(pass_count / len(valid) * 100, 1) if valid else None
        ),
        "regenerate_count": len(regenerate),
        "threshold_pass": threshold_pass,
        "publishable": publishable,
        "conclusion": conclusion,
        "commercial_average": commercial_avg,
        "commercial_min": commercial_min,
        "commercial_below_70": commercial_below_70,
        "clip_qa_average": clip_qa_average,
        "release_risk": (
            "阈值验收通过但商业观感短板明显，建议先处理商业感不足镜头与AI痕迹后再正式发布。"
            if threshold_pass and not publishable
            else "整体指标达到发布阈值，仍建议人工复核最差镜头。"
        ),
        "calibration_note": (
            "qwen2.5vl:3b评分整体偏高，AI痕迹和商业感仍需人工逐镜确认；"
            "CLIP QA平均分作为底层参考。"
        ),
        "worst_shots": [
            {
                "shot_id": r["shot_id"],
                "total_score": r["total_score"],
                "character_score": r["character_score"],
                "scene_score": r["scene_score"],
                "composition_score": r["composition_score"],
                "commercial_score": r["commercial_score"],
                "problems": r["problems"],
                "regenerate": r["regenerate"],
            }
            for r in worst
        ],
        "failure_type_stats": [
            {"type": key, "count": value}
            for key, value in sorted(
                failure_stats.items(), key=lambda x: x[1], reverse=True
            )
        ],
        "regenerate_shots": regenerate,
        "next_stage_suggestions": next_stage_suggestions,
    }
    save_json(run_dir / "v2" / "quality_report.json", report)
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-id", default="20260731_171708")
    parser.add_argument("--shots", default="")
    parser.add_argument("--no-report", action="store_true")
    args = parser.parse_args()

    config = load_config()
    run_dir = PROJECT_DIR / "data" / "runs" / args.run_id
    if not run_dir.exists():
        raise RuntimeError(f"run dir not found: {run_dir}")

    prompts_data = load_json(run_dir / "v2" / "v2_prompts.json") or {}
    shots = prompts_data.get("shots", [])
    if args.shots:
        allowed = {s.strip() for s in args.shots.split(",")}
        shots = [s for s in shots if s.get("shot_id") in allowed]
    if not shots:
        raise RuntimeError("no shots to review")

    characters_data = load_json(run_dir / "v2" / "characters.json") or {}
    characters = characters_data.get("characters", [])
    storyboard = load_json(run_dir / "storyboard.json") or {}
    storyboard_map = {s["shot_id"]: s for s in storyboard.get("shots", [])}
    summary = load_json(run_dir / "v2_render_summary.json") or []
    summary_map = {item.get("shot_id"): item for item in summary}
    image_dir = PROJECT_DIR / "output" / "v2_images" / args.run_id

    results = []
    for shot in shots:
        shot_id = shot["shot_id"]
        image_path = image_dir / f"{shot_id}.png"
        if not image_path.exists():
            print(f"[{shot_id}] image not found, skip", flush=True)
            continue
        story_shot = storyboard_map.get(shot_id, {})
        char_names = [
            c.get("name") for c in story_shot.get("characters") or []
        ]
        char_cards = [
            c for c in characters if c.get("name") in char_names
        ]
        qa = load_json(run_dir / f"v2_qa_{shot_id}.json") or {}
        clip_qa = {
            "total": (qa.get("scores") or {}).get("total"),
            "character_consistency": (qa.get("scores") or {}).get(
                "character_consistency"
            ),
            "scene_compliance": (qa.get("scores") or {}).get(
                "scene_compliance"
            ),
            "image_quality": (qa.get("scores") or {}).get("image_quality"),
            "reason": qa.get("reason"),
        }
        context = {
            "characters": char_cards,
            "clip_qa": clip_qa,
            "story": json.dumps(story_shot, ensure_ascii=False),
        }
        try:
            judge = judge_shot(config, image_path, shot, context)
            character = clamp_score(
                judge.get("character_score", judge.get("character_consistency"))
            )
            scene = clamp_score(
                judge.get(
                    "scene_score",
                    judge.get("scene_specificity", judge.get("scene_compliance")),
                )
            )
            composition = clamp_score(
                judge.get("composition_score", judge.get("composition"))
            )
            commercial = clamp_score(
                judge.get("commercial_score", judge.get("commercial_quality"))
            )
            if None in (character, scene, composition, commercial):
                raise ValueError(
                    "missing scores in model output: "
                    + json.dumps(judge, ensure_ascii=False)
                )
            total = round(
                character * 0.3
                + scene * 0.3
                + composition * 0.2
                + commercial * 0.2,
                2,
            )
            problems = [
                normalize_problem(p)
                for p in as_list(judge.get("problems"))
                if normalize_problem(p)
            ]
            suggestions = [
                str(s).strip()
                for s in as_list(judge.get("suggestions"))
                if str(s).strip()
            ]
            result = {
                "shot_id": shot_id,
                "character_score": character,
                "scene_score": scene,
                "composition_score": composition,
                "commercial_score": commercial,
                "total_score": total,
                "problems": problems,
                "suggestions": suggestions,
                "regenerate": total < 70,
                "regenerate_reason": (
                    f"总分{total}低于70" if total < 70 else None
                ),
                "clip_qa_total": clip_qa["total"],
                "prompt": shot.get("positive", ""),
                "character_cards": char_cards,
                "model": "qwen2.5vl:3b",
                "status": "done",
                "reviewed_at": datetime.now().isoformat(timespec="seconds"),
            }
        except Exception as e:
            result = {
                "shot_id": shot_id,
                "character_score": None,
                "scene_score": None,
                "composition_score": None,
                "commercial_score": None,
                "total_score": None,
                "problems": [f"AI审核失败: {e}"],
                "suggestions": [],
                "regenerate": True,
                "regenerate_reason": "AI审核失败",
                "clip_qa_total": clip_qa["total"],
                "prompt": shot.get("positive", ""),
                "character_cards": char_cards,
                "model": "qwen2.5vl:3b",
                "status": "failed",
                "reviewed_at": datetime.now().isoformat(timespec="seconds"),
            }
            print(f"[{shot_id}] review failed: {e}", flush=True)

        save_json(run_dir / "v2" / f"review_result_{shot_id}.json", result)
        results.append(result)
        print(
            f"[{shot_id}] total={result.get('total_score')} "
            f"regenerate={result.get('regenerate')}",
            flush=True,
        )

    if results and not args.no_report:
        report = build_quality_report(run_dir, results)
        print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
