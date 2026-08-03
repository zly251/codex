import argparse
import json
import re
import sys
from datetime import datetime
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_DIR))

from app.data import db

CATEGORY_KEYWORDS = {
    "人物": (
        "人物",
        "角色",
        "脸",
        "手",
        "肢体",
        "畸形",
        "五官",
        "character",
        "face",
        "hand",
        "anatomy",
        "clothing",
        "outfit",
    ),
    "场景": (
        "场景",
        "背景",
        "空间",
        "环境",
        "scene",
        "background",
        "environment",
    ),
    "构图": (
        "构图",
        "镜头",
        "主体",
        "姿态",
        "画面",
        "composition",
        "camera",
        "framing",
        "subject",
    ),
    "AI痕迹": (
        "AI",
        "痕迹",
        "贴图",
        "模糊",
        "风格",
        "artifact",
        "plastic",
        "oversaturated",
        "jpeg",
        "blurry",
    ),
}


def _num(value, default=None):
    try:
        if value is None:
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def _as_list(value):
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item) for item in value if item is not None]
    return [str(value)]


def _load_json(path):
    path = Path(path)
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def _save_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _parse_score(texts, pattern):
    for text in _as_list(texts):
        match = re.search(pattern, text)
        if match:
            value = _num(match.group(1))
            if value is not None:
                return round(value, 2)
    return None


def _types(texts):
    joined = " ".join(_as_list(texts)).lower()
    result = set()
    for category, keywords in CATEGORY_KEYWORDS.items():
        if any(keyword.lower() in joined for keyword in keywords):
            result.add(category)
    return result


def _mean(values):
    values = [value for value in values if value is not None]
    return round(sum(values) / len(values), 2) if values else None


def _correlation(xs, ys):
    pairs = [(x, y) for x, y in zip(xs, ys, strict=False) if x is not None and y is not None]
    if len(pairs) < 2:
        return None
    n = len(pairs)
    mean_x = sum(x for x, _ in pairs) / n
    mean_y = sum(y for _, y in pairs) / n
    num = sum((x - mean_x) * (y - mean_y) for x, y in pairs)
    den_x = sum((x - mean_x) ** 2 for x, _ in pairs) ** 0.5
    den_y = sum((y - mean_y) ** 2 for _, y in pairs) ** 0.5
    if den_x == 0 or den_y == 0:
        return None
    return round(num / (den_x * den_y), 4)


def _paths(run_id):
    config = json.loads((PROJECT_DIR / "config" / "config.json").read_text(encoding="utf-8"))
    data_dir = PROJECT_DIR / config["paths"]["data_dir"]
    output_dir = PROJECT_DIR / config["paths"]["output_dir"]
    return data_dir, output_dir


def build_calibration_dataset(run_id="20260731_171708"):
    data_dir, output_dir = _paths(run_id)
    db_path = db.init_db(data_dir / "manju.sqlite3")
    decision_data = _load_json(data_dir / "runs" / run_id / "v2" / "decision.json")
    if not decision_data:
        from app.vision_test.visual_decision import VisualDecisionAgent

        VisualDecisionAgent(PROJECT_DIR).run(run_id)
        decision_data = _load_json(data_dir / "runs" / run_id / "v2" / "decision.json")

    feedback = _load_json(output_dir / "review" / run_id / "vision_feedback.json")
    review = db.get_review(db_path, run_id) or _load_json(
        output_dir / "review" / run_id / "review.json"
    )
    quality_report = _load_json(data_dir / "runs" / run_id / "v2" / "quality_report.json")
    feedback_map = {item.get("shot_id"): item for item in (feedback or {}).get("items", [])}

    review_results = {}
    v2_dir = data_dir / "runs" / run_id / "v2"
    for path in sorted(v2_dir.glob("review_result_*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        shot_id = data.get("shot_id") or path.stem.replace("review_result_", "")
        if shot_id:
            review_results[shot_id] = data

    shots = []
    for item in decision_data.get("decisions") or []:
        shot_id = item.get("shot_id")
        fb = feedback_map.get(shot_id, {})
        human_status = fb.get("human_status") or (review or {}).get("status") or ""
        human_problems = fb.get("real_problem_type")
        if human_problems is None:
            human_problems = (review or {}).get("problems") or []
        if isinstance(human_problems, str):
            try:
                human_problems = json.loads(human_problems)
            except Exception:
                human_problems = []

        ai_correct = fb.get("ai_correct")
        if ai_correct is None and human_status:
            ai_decision = item.get("decision")
            if human_status == "通过":
                ai_correct = ai_decision == "accept"
            elif human_status == "修改":
                ai_correct = ai_decision in ("repair", "manual_review")
            elif human_status == "废弃":
                ai_correct = ai_decision != "accept"
            else:
                ai_correct = None

        rr = review_results.get(shot_id, {})
        qwen_score = _num(rr.get("total_score"))
        clip_score = _num(rr.get("clip_qa_total"))
        if qwen_score is None:
            qwen_score = _parse_score(item.get("reason", []), r"综合评分\s*([\d.]+)")
        if clip_score is None:
            clip_score = _parse_score(item.get("reason", []), r"CLIP QA\s*([\d.]+)")

        shots.append(
            {
                "shot_id": shot_id,
                "ai_decision": item.get("decision"),
                "ai_reason": item.get("reason") or [],
                "ai_confidence": item.get("confidence"),
                "human_result": human_status,
                "human_problem": "；".join(human_problems),
                "human_score": (review or {}).get("score"),
                "ai_correct": ai_correct,
                "qwen_score": qwen_score,
                "clip_score": clip_score,
            }
        )

    payload = {
        "run_id": run_id,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "shot_count": len(shots),
        "shots": shots,
        "quality_report": {
            "average_total": (quality_report or {}).get("average_total"),
            "pass_rate": (quality_report or {}).get("pass_rate"),
            "clip_qa_average": (quality_report or {}).get("clip_qa_average"),
            "conclusion": (quality_report or {}).get("conclusion"),
        },
    }
    _save_json(data_dir / "vision_test" / "calibration_dataset.json", payload)
    return payload


def analyze(run_id="20260731_171708"):
    data_dir, _ = _paths(run_id)
    dataset_path = data_dir / "vision_test" / "calibration_dataset.json"
    dataset = _load_json(dataset_path)
    if not dataset:
        dataset = build_calibration_dataset(run_id)
    shots = dataset.get("shots") or []

    total = len([s for s in shots if s.get("ai_correct") is not None])
    correct = sum(1 for s in shots if s.get("ai_correct") is True)
    accuracy = round(correct / total, 4) if total else 0.0

    error_types = []
    for category in CATEGORY_KEYWORDS:
        matched = [s for s in shots if category in _types(s.get("ai_reason") or [])]
        if not matched:
            continue
        type_correct = sum(1 for s in matched if s.get("ai_correct") is True)
        false_positive = sum(
            1 for s in matched if s.get("ai_correct") is False and s.get("human_result") == "通过"
        )
        error_types.append(
            {
                "type": category,
                "count": len(matched),
                "correct_count": type_correct,
                "correct_rate": round(type_correct / len(matched), 4),
                "false_positive_on_pass": false_positive,
                "note": ("AI标记但人工通过" if false_positive > 0 else ""),
            }
        )

    confusion = {
        "accept_human_pass": sum(
            1 for s in shots if s.get("ai_decision") == "accept" and s.get("human_result") == "通过"
        ),
        "reject_human_pass": sum(
            1 for s in shots if s.get("ai_decision") != "accept" and s.get("human_result") == "通过"
        ),
        "accept_human_reject": sum(
            1
            for s in shots
            if s.get("ai_decision") == "accept" and s.get("human_result") in ("修改", "废弃")
        ),
        "reject_human_reject": sum(
            1
            for s in shots
            if s.get("ai_decision") != "accept" and s.get("human_result") in ("修改", "废弃")
        ),
    }

    metric_reliability = []
    for metric in ("qwen_score", "clip_score", "human_score"):
        pairs = [
            (s.get(metric), 1 if s.get("ai_correct") else 0)
            for s in shots
            if s.get(metric) is not None and s.get("ai_correct") is not None
        ]
        if not pairs:
            continue
        correct_values = [x for x, y in pairs if y == 1]
        incorrect_values = [x for x, y in pairs if y == 0]
        mean_correct = _mean(correct_values)
        mean_incorrect = _mean(incorrect_values)
        correlation = _correlation([x for x, _ in pairs], [y for _, y in pairs])
        separation = (
            round(mean_correct - mean_incorrect, 2)
            if mean_correct is not None and mean_incorrect is not None
            else None
        )
        reliability = "low"
        if correlation is not None:
            if abs(correlation) >= 0.5:
                reliability = "high"
            elif abs(correlation) >= 0.3:
                reliability = "medium"
        metric_reliability.append(
            {
                "metric": metric,
                "mean_correct": mean_correct,
                "mean_incorrect": mean_incorrect,
                "separation": separation,
                "correlation": correlation,
                "reliability": reliability,
            }
        )

    payload = {
        "run_id": run_id,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "history_accuracy": accuracy,
        "summary": {
            "total": total,
            "correct": correct,
            "accuracy": accuracy,
        },
        "error_types": error_types,
        "confusion": confusion,
        "metric_reliability": metric_reliability,
    }
    _save_json(data_dir / "vision_test" / "evaluation_analysis.json", payload)
    return payload


def build_report(run_id="20260731_171708"):
    data_dir, _ = _paths(run_id)
    analysis = analyze(run_id)

    from app.vision_test.visual_decision import VisualDecisionAgent

    agent = VisualDecisionAgent(PROJECT_DIR)
    decision_v2 = agent.run_v2(run_id)
    decision_v1 = _load_json(data_dir / "runs" / run_id / "v2" / "decision.json") or {}
    v1_map = {
        item.get("shot_id"): item.get("decision") for item in decision_v1.get("decisions") or []
    }
    v2_map = {
        item.get("shot_id"): item.get("decision") for item in decision_v2.get("decisions") or []
    }
    changed = sum(1 for shot_id in v1_map if v1_map.get(shot_id) != v2_map.get(shot_id))
    human_review = db.get_review(db.init_db(data_dir / "manju.sqlite3"), run_id) or _load_json(
        _paths(run_id)[1] / "review" / run_id / "review.json"
    )
    human_status = (human_review or {}).get("status") or ""
    calibrated_total = 0
    calibrated_correct = 0
    for item in decision_v2.get("decisions") or []:
        calibrated_total += 1
        ai_decision = item.get("decision")
        if human_status == "通过":
            is_correct = ai_decision == "accept"
        elif human_status == "修改":
            is_correct = ai_decision in ("repair", "manual_review")
        elif human_status == "废弃":
            is_correct = ai_decision != "accept"
        else:
            is_correct = None
        if is_correct is True:
            calibrated_correct += 1
    calibrated_accuracy = (
        round(calibrated_correct / calibrated_total, 4) if calibrated_total else 0.0
    )

    recommendations = []
    for item in analysis.get("error_types") or []:
        if item.get("correct_rate") is not None and item["correct_rate"] < 0.6:
            recommendations.append(
                f"{item['type']}误判率较高({item['correct_rate']:.0%})，"
                "建议降低该问题信号权重或提高人工确认阈值"
            )
    clip_reliability = next(
        (
            item
            for item in analysis.get("metric_reliability") or []
            if item.get("metric") == "clip_score"
        ),
        None,
    )
    qwen_reliability = next(
        (
            item
            for item in analysis.get("metric_reliability") or []
            if item.get("metric") == "qwen_score"
        ),
        None,
    )
    if (
        clip_reliability
        and qwen_reliability
        and clip_reliability.get("correlation") is not None
        and qwen_reliability.get("correlation") is not None
        and clip_reliability["correlation"] > qwen_reliability["correlation"]
    ):
        recommendations.append("CLIP QA比qwen综合分更可靠，应提高clip_weight")

    report = {
        "run_id": run_id,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "summary": analysis.get("summary"),
        "error_types": analysis.get("error_types"),
        "metric_reliability": analysis.get("metric_reliability"),
        "confidence_calibration": decision_v2.get("confidence_calibration"),
        "decision_v2_summary": {
            "shot_count": decision_v2.get("shot_count"),
            "changed_from_v1": changed,
            "calibrated_accuracy": calibrated_accuracy,
            "calibrated_correct": calibrated_correct,
            "calibrated_total": calibrated_total,
            "decisions": {
                "accept": sum(
                    1
                    for item in decision_v2.get("decisions") or []
                    if item.get("decision") == "accept"
                ),
                "repair": sum(
                    1
                    for item in decision_v2.get("decisions") or []
                    if item.get("decision") == "repair"
                ),
                "manual_review": sum(
                    1
                    for item in decision_v2.get("decisions") or []
                    if item.get("decision") == "manual_review"
                ),
            },
        },
        "recommendations": recommendations,
    }
    _save_json(data_dir / "vision_test" / "calibration_report.json", report)
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-id", default="20260731_171708")
    parser.add_argument("--dataset", action="store_true")
    parser.add_argument("--analyze", action="store_true")
    parser.add_argument("--report", action="store_true")
    args = parser.parse_args()

    if args.dataset or (not args.analyze and not args.report):
        result = build_calibration_dataset(args.run_id)
        print(json.dumps({"dataset": result}, ensure_ascii=False, indent=2))
    if args.analyze or (not args.dataset and not args.report):
        result = analyze(args.run_id)
        print(json.dumps({"analysis": result}, ensure_ascii=False, indent=2))
    if args.report:
        result = build_report(args.run_id)
        print(json.dumps({"report": result}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
