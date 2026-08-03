import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_DIR))

from app.data import db

SEVERE_CHARACTER_KEYWORDS = (
    "deformed",
    "extra hands",
    "extra limbs",
    "bad anatomy",
    "手部异常",
    "手指异常",
    "肢体异常",
    "畸形",
    "人物不一致",
    "角色不一致",
    "五官异常",
    "手脚异常",
)

NEXT_ACTION_BY_METHOD = {
    "FaceDetailer": "FaceDetailer",
    "IPAdapter_future": "IPAdapter/ControlNet",
    "rerender": "重新生成",
    "new_seed": "重新生成",
    "img2img": "Prompt修改",
    "prompt_scene_expand": "Prompt修改",
    "keep_current": "保留",
}

DEFAULT_CALIBRATION = {
    "qwen_weight": 0.55,
    "clip_weight": 0.35,
    "history_weight": 0.10,
    "history_mode": "human_status",
    "accept_threshold": 85.0,
    "repair_threshold": 70.0,
    "character_severity_threshold": 60.0,
    "visual_issue_confidence_threshold": 0.85,
}


def _num(value, default=None):
    try:
        if value is None:
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def _first_num(result, *keys):
    for key in keys:
        value = _num((result or {}).get(key))
        if value is not None:
            return value
    return None


def _texts(*values):
    result = []
    for value in values:
        if isinstance(value, list):
            result.extend(str(item) for item in value if item is not None)
        elif value is not None:
            result.append(str(value))
    return result


def _total_score(result):
    total = _num((result or {}).get("total_score"))
    if total is not None:
        return round(total, 2)
    character = _first_num(result, "character_score", "character_quality")
    scene = _first_num(result, "scene_score", "scene_quality")
    composition = _first_num(result, "composition_score", "composition_quality")
    commercial = _first_num(result, "commercial_score")
    if None not in (character, scene, composition, commercial):
        return round(
            character * 0.3 + scene * 0.3 + composition * 0.2 + commercial * 0.2,
            2,
        )
    artifact = _first_num(result, "ai_artifact_score")
    if None not in (character, scene, composition, artifact):
        return round((character + scene + composition + (100 - artifact)) / 4, 2)
    return None


def _severe_character(result, visual_action):
    character = _first_num(result, "character_score", "character_quality")
    if character is not None and character < 70:
        return True
    for issue in (visual_action or {}).get("issues") or []:
        issue_type = str(issue.get("type") or "")
        confidence = _num(issue.get("confidence"), 0)
        if issue_type in ("bad_anatomy", "character_error") and confidence >= 0.75:
            return True
    texts = " ".join(
        _texts(
            result.get("problems"),
            result.get("prompt_fix"),
            result.get("suggestions"),
        )
    ).lower()
    return any(keyword in texts for keyword in SEVERE_CHARACTER_KEYWORDS)


def _conflicts(total, clip, result):
    reasons = []
    rerender = bool((result or {}).get("rerender"))
    regenerate = bool((result or {}).get("regenerate"))
    if (rerender or regenerate) and total is not None and total >= 85:
        reasons.append("AI标记重新生成但综合评分>=85")
    if clip is not None and clip < 70 and total is not None and total >= 85:
        reasons.append("CLIP QA<70但综合评分>=85")
    return reasons


def _max_issue_confidence(visual_action, issue_types):
    best = 0.0
    for issue in (visual_action or {}).get("issues") or []:
        if str(issue.get("type") or "") in issue_types:
            best = max(best, _num(issue.get("confidence"), 0))
    return best


def _calibrated_score(total, clip, history_accuracy, calibration, human_review=None):
    calibration = calibration or {}
    qwen_weight = float(calibration.get("qwen_weight", 0.55))
    clip_weight = float(calibration.get("clip_weight", 0.35))
    history_weight = float(calibration.get("history_weight", 0.10))
    history_mode = calibration.get("history_mode", "human_status")
    if history_mode == "human_status":
        human_status = (human_review or {}).get("status") or ""
        if human_status == "通过":
            history_score = 100.0
        elif human_status in ("修改", "废弃"):
            history_score = 0.0
        else:
            history_score = (_num(history_accuracy, 0.5) or 0.5) * 100
    else:
        history_score = (_num(history_accuracy, 0.5) or 0.5) * 100
    score = 0.0
    weight_sum = 0.0
    if total is not None:
        score += total * qwen_weight
        weight_sum += qwen_weight
    if clip is not None:
        score += clip * clip_weight
        weight_sum += clip_weight
    score += history_score * history_weight
    weight_sum += history_weight
    if weight_sum <= 0:
        return None
    return round(score / weight_sum, 2)


def _next_action(result, repair_strategy, decision):
    if decision == "accept":
        return "保留"
    if decision == "manual_review":
        return "人工检查"
    method = (repair_strategy or {}).get("method")
    if method in NEXT_ACTION_BY_METHOD:
        return NEXT_ACTION_BY_METHOD[method]
    texts = " ".join(_texts(result.get("problems"), result.get("suggestions"))).lower()
    if any(
        keyword in texts for keyword in ("face", "hand", "手指", "手部", "肢体", "畸形", "detailer")
    ):
        return "FaceDetailer"
    if any(keyword in texts for keyword in ("ai", "artifact", "痕迹", "贴图", "模糊", "风格")):
        return "重新生成"
    return "Prompt修改"


class VisualDecisionAgent:
    def __init__(self, project_dir=None):
        self.project_dir = Path(project_dir) if project_dir else PROJECT_DIR
        self.config = json.loads(
            (self.project_dir / "config" / "config.json").read_text(encoding="utf-8")
        )
        self.data_dir = self.project_dir / self.config["paths"]["data_dir"]
        self.output_dir = self.project_dir / self.config["paths"]["output_dir"]
        self.db_path = db.init_db(self.data_dir / "manju.sqlite3")

    def _load_json(self, path):
        path = Path(path)
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))

    def _save_json(self, path, data):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    def decide_shot(
        self,
        shot_id,
        ai_review=None,
        review_result=None,
        clip_qa=None,
        visual_action=None,
        repair_strategy=None,
        human_review=None,
        calibration=None,
    ):
        result = {}
        if isinstance(review_result, dict):
            result.update(review_result)
        if isinstance(ai_review, dict):
            for key, value in ai_review.items():
                if key not in result or result[key] is None:
                    result[key] = value

        total = _total_score(result)
        clip = _num(clip_qa, _num(result.get("clip_qa_total")))
        calibration = calibration or {}
        history_accuracy = _num(calibration.get("history_accuracy"))
        calibrated = _calibrated_score(total, clip, history_accuracy, calibration, human_review)
        score_for_decision = calibrated if calibrated is not None else total
        severe = _severe_character(result, visual_action)
        if severe and calibration:
            character = _first_num(result, "character_score", "character_quality")
            issue_conf = _max_issue_confidence(visual_action, ("bad_anatomy", "character_error"))
            severe = (
                character is not None
                and character < float(calibration.get("character_severity_threshold", 65))
            ) or issue_conf >= float(calibration.get("visual_issue_confidence_threshold", 0.85))
        conflicts = _conflicts(score_for_decision, clip, result)
        reasons = []
        if total is not None:
            reasons.append(f"综合评分 {total}")
        if calibrated is not None:
            reasons.append(f"校准评分 {calibrated}")
        if clip is not None:
            reasons.append(f"CLIP QA {clip}")
        reasons.extend(_texts(result.get("problems")))
        if severe:
            reasons.append("严重人物错误")
        reasons.extend(conflicts)

        accept_threshold = float(calibration.get("accept_threshold", 85))
        repair_threshold = float(calibration.get("repair_threshold", 70))
        if (
            score_for_decision is None
            or score_for_decision < repair_threshold
            or severe
            or conflicts
        ):
            decision = "manual_review"
        elif score_for_decision >= accept_threshold:
            decision = "accept"
        else:
            has_problem = (
                bool(_texts(result.get("problems"), result.get("suggestions")))
                or bool(repair_strategy)
                or bool(result.get("rerender"))
                or bool(result.get("regenerate"))
            )
            decision = "repair" if has_problem else "manual_review"

        human_status = (human_review or {}).get("status") or ""
        if human_status == "通过" and decision != "accept":
            reasons.append("人工选择通过，AI建议不一致")
        elif human_status in ("修改", "废弃") and decision == "accept":
            reasons.append(f"人工选择{human_status}，AI判断偏乐观")

        if decision == "accept":
            confidence = 0.9
            if clip is not None:
                confidence += max(0.0, (clip - 70) / 100)
            if history_accuracy is not None and history_accuracy < 0.6:
                confidence = min(confidence, 0.8)
            else:
                confidence = min(confidence, 0.95)
        elif decision == "repair":
            confidence = 0.85 if repair_strategy else 0.7
            if (
                result.get("regenerate") is False
                and score_for_decision is not None
                and score_for_decision >= 80
            ):
                confidence = min(confidence, 0.6)
        else:
            confidence = 0.8

        if human_status == "通过" and decision != "accept":
            confidence = min(confidence, 0.55)
        elif human_status in ("修改", "废弃") and decision == "accept":
            confidence = min(confidence, 0.6)
        confidence = round(max(0.0, min(1.0, confidence)), 2)

        return {
            "shot_id": shot_id,
            "decision": decision,
            "reason": reasons,
            "confidence": confidence,
            "next_action": _next_action(result, repair_strategy, decision),
        }

    def _collect_inputs(self, run_id):
        run_dir = self.data_dir / "runs" / run_id
        v2_dir = run_dir / "v2"
        if not v2_dir.exists():
            raise FileNotFoundError(f"v2 dir not found: {v2_dir}")

        review_results = {}
        for path in sorted(v2_dir.glob("review_result_*.json")):
            data = json.loads(path.read_text(encoding="utf-8"))
            shot_id = data.get("shot_id") or path.stem.replace("review_result_", "")
            if shot_id:
                review_results[shot_id] = data

        clip_map = {}
        visual_judge = self._load_json(self.output_dir / "review" / run_id / "visual_judge.json")
        clip_qa = (visual_judge or {}).get("clip_qa") or {}
        for item in clip_qa.get("shots") or []:
            shot_id = item.get("shot_id")
            if shot_id:
                clip_map[shot_id] = item.get("total")

        vision_dir = self.data_dir / "vision_test" / "v3"
        winner = self._load_json(vision_dir / "winner.json")
        before_report = self._load_json(vision_dir / "before_report.json")
        after_report = self._load_json(vision_dir / "after_report.json")
        selected_report = (
            after_report if winner and winner.get("winner") == "after" else before_report
        )
        visual_action = self._load_json(vision_dir / "visual_action.json")
        repair_strategy = self._load_json(vision_dir / "repair_strategy.json")
        vision_shot_id = None
        if isinstance(selected_report, dict):
            vision_shot_id = selected_report.get("shot_id")

        human_review = db.get_review(self.db_path, run_id) or self._load_json(
            self.output_dir / "review" / run_id / "review.json"
        )
        return (
            review_results,
            clip_map,
            {
                "selected_report": selected_report,
                "visual_action": visual_action,
                "repair_strategy": repair_strategy,
                "vision_shot_id": vision_shot_id,
            },
            human_review,
        )

    def run(self, run_id):
        review_results, clip_map, vision_info, human_review = self._collect_inputs(run_id)
        v2_dir = self.data_dir / "runs" / run_id / "v2"
        selected_report = vision_info["selected_report"]
        visual_action = vision_info["visual_action"]
        repair_strategy = vision_info["repair_strategy"]
        vision_shot_id = vision_info["vision_shot_id"]

        decisions = []
        for shot_id in sorted(review_results):
            shot_action = visual_action if shot_id == vision_shot_id else None
            shot_repair = repair_strategy if shot_id == vision_shot_id else None
            shot_ai = selected_report if shot_id == vision_shot_id else None
            shot_clip = _num(
                review_results[shot_id].get("clip_qa_total"),
                clip_map.get(shot_id),
            )
            decisions.append(
                self.decide_shot(
                    shot_id=shot_id,
                    ai_review=shot_ai,
                    review_result=review_results[shot_id],
                    clip_qa=shot_clip,
                    visual_action=shot_action,
                    repair_strategy=shot_repair,
                    human_review=human_review,
                )
            )

        payload = {
            "run_id": run_id,
            "generated_at": datetime.now().isoformat(timespec="seconds"),
            "model": "visual_decision_rule_v1",
            "shot_count": len(decisions),
            "decisions": decisions,
        }
        self._save_json(v2_dir / "decision.json", payload)
        return payload

    def run_v2(self, run_id):
        review_results, clip_map, vision_info, human_review = self._collect_inputs(run_id)
        v2_dir = self.data_dir / "runs" / run_id / "v2"
        selected_report = vision_info["selected_report"]
        visual_action = vision_info["visual_action"]
        repair_strategy = vision_info["repair_strategy"]
        vision_shot_id = vision_info["vision_shot_id"]

        analysis = self._load_json(self.data_dir / "vision_test" / "evaluation_analysis.json") or {}
        calibration = dict(DEFAULT_CALIBRATION)
        history_accuracy = _num(analysis.get("history_accuracy"))
        if history_accuracy is not None:
            calibration["history_accuracy"] = history_accuracy
        calibration["source"] = analysis.get("run_id") or run_id

        decisions = []
        for shot_id in sorted(review_results):
            shot_action = visual_action if shot_id == vision_shot_id else None
            shot_repair = repair_strategy if shot_id == vision_shot_id else None
            shot_ai = selected_report if shot_id == vision_shot_id else None
            shot_clip = _num(
                review_results[shot_id].get("clip_qa_total"),
                clip_map.get(shot_id),
            )
            decisions.append(
                self.decide_shot(
                    shot_id=shot_id,
                    ai_review=shot_ai,
                    review_result=review_results[shot_id],
                    clip_qa=shot_clip,
                    visual_action=shot_action,
                    repair_strategy=shot_repair,
                    human_review=human_review,
                    calibration=calibration,
                )
            )

        payload = {
            "run_id": run_id,
            "generated_at": datetime.now().isoformat(timespec="seconds"),
            "model": "visual_decision_rule_v2",
            "shot_count": len(decisions),
            "confidence_calibration": calibration,
            "decisions": decisions,
        }
        self._save_json(v2_dir / "decision_v2.json", payload)
        return payload

    def build_feedback(self, run_id):
        decision_path = self.data_dir / "runs" / run_id / "v2" / "decision.json"
        if not decision_path.exists():
            self.run(run_id)
        decision_data = self._load_json(decision_path)
        human_review = db.get_review(self.db_path, run_id) or self._load_json(
            self.output_dir / "review" / run_id / "review.json"
        )
        if not decision_data or not human_review:
            return None

        status = str(human_review.get("status") or "")
        problems = human_review.get("problems") or []
        if isinstance(problems, str):
            try:
                problems = json.loads(problems)
            except Exception:
                problems = []

        items = []
        correct = 0
        for item in decision_data.get("decisions") or []:
            ai_decision = item.get("decision")
            if status == "通过":
                is_correct = ai_decision == "accept"
            elif status == "修改":
                is_correct = ai_decision in ("repair", "manual_review")
            elif status == "废弃":
                is_correct = ai_decision != "accept"
            else:
                is_correct = None
            if is_correct is True:
                correct += 1
            items.append(
                {
                    "shot_id": item.get("shot_id"),
                    "ai_decision": ai_decision,
                    "human_status": status,
                    "ai_correct": is_correct,
                    "real_problem_type": problems if status == "修改" else [],
                }
            )

        accuracy = round(correct / len(items), 4) if items else 0.0
        feedback = {
            "run_id": run_id,
            "generated_at": datetime.now().isoformat(timespec="seconds"),
            "human_status": status,
            "summary": {
                "total": len(items),
                "ai_correct": correct,
                "accuracy": accuracy,
            },
            "items": items,
        }
        self._save_json(self.output_dir / "review" / run_id / "vision_feedback.json", feedback)
        return feedback


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-id", default="20260731_171708")
    parser.add_argument("--feedback", action="store_true")
    parser.add_argument("--v2", action="store_true")
    args = parser.parse_args()
    agent = VisualDecisionAgent()
    if args.feedback:
        result = agent.build_feedback(args.run_id)
    elif args.v2:
        result = agent.run_v2(args.run_id)
    else:
        result = agent.run(args.run_id)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
