import contextlib
import json
import threading
from pathlib import Path

from app.data import db
from app.vision_test.visual_decision import VisualDecisionAgent
from app.visual_judge import VisualJudgeAgent
from flask import Flask, abort, jsonify, render_template, request, send_file

PROBLEM_TAGS = [
    "人物不一致",
    "画风不统一",
    "图片质量差",
    "剧情不好看",
    "声音不匹配",
    "字幕问题",
    "节奏问题",
]
VALID_STATUS = {"通过", "修改", "废弃"}


def create_app(project_dir=None):
    project_dir = Path(project_dir) if project_dir else Path(__file__).resolve().parents[2]
    config = json.loads((project_dir / "config" / "config.json").read_text(encoding="utf-8"))
    data_dir = project_dir / config["paths"]["data_dir"]
    output_dir = project_dir / config["paths"]["output_dir"]
    db_path = db.init_db(data_dir / "manju.sqlite3")
    app = Flask(__name__)
    visual_judge_cfg = config.get("visual_judge", {})
    judge_running = set()

    def load_json(path):
        path = Path(path)
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))

    def ensure_visual_decisions(run_id):
        decision_path = data_dir / "runs" / run_id / "v2" / "decision.json"
        if not decision_path.exists():
            with contextlib.suppress(Exception):
                VisualDecisionAgent(project_dir).run(run_id)
        return load_json(decision_path)

    def media_url(path):
        try:
            relative = Path(path).resolve().relative_to(output_dir.resolve())
        except ValueError:
            return None
        return "/media/" + relative.as_posix()

    def run_payload(run_id):
        run_dir = data_dir / "runs" / run_id
        if not run_dir.exists():
            return None
        topic = None
        run_status = None
        with db._connect(db_path) as conn:
            row = conn.execute("SELECT topic, status FROM runs WHERE id = ?", (run_id,)).fetchone()
            if row:
                topic = row["topic"]
                run_status = row["status"]

        script = load_json(run_dir / "script.json")
        storyboard = load_json(run_dir / "storyboard.json")
        prompts = load_json(run_dir / "prompts.json")
        shots = db.list_shots(db_path, run_id)
        images = []
        qa = {}
        for shot in shots:
            shot_id = shot["shot_id"]
            if shot.get("image_path") and Path(shot["image_path"]).exists():
                images.append(
                    {
                        "shot_id": shot_id,
                        "url": media_url(shot["image_path"]),
                        "qa_score": shot.get("qa_score"),
                    }
                )
            detail = load_json(run_dir / f"qa_{shot_id}.json")
            qa[shot_id] = {
                "score": shot.get("qa_score"),
                "detail": detail,
            }

        v2_images = []
        v2_qa = {}
        v2_render_summary = load_json(run_dir / "v2_render_summary.json") or []
        v2_summary_map = {item.get("shot_id"): item for item in v2_render_summary}
        v2_img_dir = output_dir / "v2_images" / run_id
        if v2_img_dir.exists():
            for path in sorted(v2_img_dir.glob("shot_*.png")):
                if "_hires" in path.name or "_mask" in path.name:
                    continue
                shot_id = path.stem
                v2_images.append(
                    {
                        "shot_id": shot_id,
                        "url": media_url(path),
                        "qa_score": (v2_summary_map.get(shot_id) or {}).get("qa_total"),
                    }
                )
                detail = load_json(run_dir / f"v2_qa_{shot_id}.json")
                v2_qa[shot_id] = {
                    "score": (v2_summary_map.get(shot_id) or {}).get("qa_total"),
                    "detail": detail,
                }

        audio_manifest = load_json(
            output_dir / "audio" / run_id / "audio_manifest.json"
        ) or load_json(output_dir / "audio" / "audio_manifest.json")
        audio = []
        for item in (audio_manifest or {}).get("items", []):
            if item.get("audio_path") and Path(item["audio_path"]).exists():
                audio.append(
                    {
                        "shot_id": item["shot_id"],
                        "url": media_url(item["audio_path"]),
                        "duration": item.get("duration"),
                        "voice": item.get("voice"),
                    }
                )

        video = None
        video_path = output_dir / "video" / run_id / "episode_final.mp4"
        if not video_path.exists():
            video_path = output_dir / "video" / "episode_final.mp4"
        if video_path.exists():
            video = {
                "url": f"/media/video/{run_id}/episode_final.mp4",
                "size": video_path.stat().st_size,
            }

        content_score = load_json(
            output_dir / "score" / run_id / "content_score.json"
        ) or load_json(output_dir / "score" / "content_score.json")
        review_file = load_json(output_dir / "review" / run_id / "review.json")
        review_row = db.get_review(db_path, run_id)
        review = review_file or review_row
        if review:
            review = {
                "run_id": review.get("run_id") or run_id,
                "status": review.get("status") or "",
                "score": review.get("score") or 0,
                "problems": review.get("problems") or [],
                "notes": review.get("notes") or "",
            }

        vision_test_dir = data_dir / "vision_test" / "v3"
        vision_test = {
            "visual_action": load_json(vision_test_dir / "visual_action.json"),
            "repair_strategy": load_json(vision_test_dir / "repair_strategy.json"),
            "winner": load_json(vision_test_dir / "winner.json"),
            "before_report": load_json(vision_test_dir / "before_report.json"),
            "after_report": load_json(vision_test_dir / "after_report.json"),
            "optimization_result": load_json(vision_test_dir / "optimization_result.json"),
        }

        return {
            "run_id": run_id,
            "topic": topic,
            "run_status": run_status,
            "video": video,
            "images": images,
            "audio": audio,
            "script": script,
            "storyboard": storyboard,
            "prompts": prompts,
            "qa": qa,
            "content_score": content_score,
            "review": review,
            "problem_tags": PROBLEM_TAGS,
            "visual_judge": load_json(output_dir / "review" / run_id / "visual_judge.json"),
            "v2_images": v2_images,
            "v2_qa": v2_qa,
            "v2_quality": load_json(run_dir / "v2" / "quality_report.json"),
            "v2_review_results": {
                path.stem.replace("review_result_", ""): json.loads(
                    path.read_text(encoding="utf-8")
                )
                for path in sorted((run_dir / "v2").glob("review_result_*.json"))
            },
            "vision_test": vision_test,
            "visual_decisions": ensure_visual_decisions(run_id),
            "vision_feedback": load_json(output_dir / "review" / run_id / "vision_feedback.json"),
            "calibration_report": load_json(data_dir / "vision_test" / "calibration_report.json"),
        }

    def start_visual_judge(run_id, force=False):
        if not visual_judge_cfg.get("enabled", True):
            return False
        if run_id in judge_running:
            return True
        report_path = output_dir / "review" / run_id / "visual_judge.json"
        if not force and report_path.exists():
            return False
        judge_running.add(run_id)

        def worker():
            try:
                agent = VisualJudgeAgent(project_dir, config)
                agent.run(run_id)
            except Exception:
                pass
            finally:
                judge_running.discard(run_id)

        thread = threading.Thread(target=worker, daemon=True)
        thread.start()
        return True

    @app.route("/")
    def index():
        with db._connect(db_path) as conn:
            rows = conn.execute(
                "SELECT id, topic, status, updated_at FROM runs ORDER BY updated_at DESC"
            ).fetchall()
        runs = [dict(row) for row in rows]
        return render_template("index.html", runs=runs)

    @app.route("/review/<run_id>")
    def review_page(run_id):
        payload = run_payload(run_id)
        if payload is None:
            abort(404)
        start_visual_judge(run_id)
        return render_template("review.html", run_id=run_id, data=payload)

    @app.route("/review/<run_id>/data.json")
    def review_data(run_id):
        payload = run_payload(run_id)
        if payload is None:
            abort(404)
        return jsonify(payload)

    @app.route("/review/<run_id>/visual_judge.json")
    def visual_judge_data(run_id):
        report_path = output_dir / "review" / run_id / "visual_judge.json"
        if not report_path.exists():
            abort(404)
        return jsonify(json.loads(report_path.read_text(encoding="utf-8")))

    @app.route("/review/<run_id>/visual_judge/run", methods=["POST"])
    def visual_judge_run(run_id):
        if not visual_judge_cfg.get("enabled", True):
            return jsonify({"error": "visual judge disabled"}), 400
        started = start_visual_judge(run_id, force=True)
        return jsonify({"ok": True, "started": started})

    @app.route("/review/<run_id>", methods=["POST"])
    def save_review(run_id):
        data = request.get_json(force=True) or {}
        status = str(data.get("status") or "")
        if status not in VALID_STATUS:
            return jsonify({"error": "invalid status"}), 400
        try:
            score = max(0, min(100, int(data.get("score") or 0)))
        except (TypeError, ValueError):
            score = 0
        problems = [p for p in (data.get("problems") or []) if p in PROBLEM_TAGS]
        notes = str(data.get("notes") or "")[:2000]
        review = {
            "run_id": run_id,
            "status": status,
            "score": score,
            "problems": problems,
            "notes": notes,
        }
        review_dir = output_dir / "review" / run_id
        review_dir.mkdir(parents=True, exist_ok=True)
        review_path = review_dir / "review.json"
        review_path.write_text(json.dumps(review, ensure_ascii=False, indent=2), encoding="utf-8")
        db.upsert_review(
            db_path,
            run_id,
            status,
            score,
            problems,
            notes,
            str(review_path),
        )
        with contextlib.suppress(Exception):
            VisualDecisionAgent(project_dir).build_feedback(run_id)
        return jsonify({"ok": True, "review": review})

    @app.route("/media/<path:filename>")
    def media(filename):
        path = (output_dir / filename).resolve()
        try:
            path.relative_to(output_dir.resolve())
        except ValueError:
            abort(403)
        if not path.exists():
            abort(404)
        return send_file(path, conditional=True)

    def stream_video(run_id, filename):
        if ".." in filename or "/" in filename or "\\" in filename:
            abort(403)
        path = (output_dir / "video" / run_id / filename).resolve()
        if not path.exists():
            path = (output_dir / "video" / filename).resolve()
        try:
            path.relative_to(output_dir.resolve())
        except ValueError:
            abort(403)
        if not path.exists():
            abort(404)
        return send_file(path, conditional=True, mimetype="video/mp4")

    @app.route("/media/video/<run_id>")
    def media_video(run_id):
        return stream_video(run_id, "episode_final.mp4")

    @app.route("/media/video/<run_id>/<path:filename>")
    def media_video_file(run_id, filename):
        return stream_video(run_id, filename)

    return app


app = create_app()
