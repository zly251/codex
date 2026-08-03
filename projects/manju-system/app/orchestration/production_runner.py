import json
import time
from datetime import datetime
from pathlib import Path

from app.content_qa.content_qa_agent import ContentScoreAgent
from app.cover.cover_agent import CoverAgent
from app.data import db
from app.orchestration.pipeline import Pipeline
from app.subtitle.subtitle_agent import SubtitleAgent
from app.utils.logging import setup_logger
from app.video.enhanced_editor import EnhancedVideoEditor
from app.voice.tts_agent import TTSAgent

STEP_TTS = "tts"
STEP_SUBTITLE = "subtitle"
STEP_VIDEO = "video"
STEP_CONTENT_SCORE = "content_score"


def load_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


class ProductionRunner:
    def __init__(
        self,
        project_dir=None,
        comfy_url=None,
        checkpoint=None,
        api_key=None,
    ):
        self.project_dir = (
            Path(project_dir)
            if project_dir
            else Path(__file__).resolve().parents[2]
        )
        self.config = json.loads(
            (self.project_dir / "config" / "config.json").read_text(
                encoding="utf-8"
            )
        )
        self.data_dir = self.project_dir / self.config["paths"]["data_dir"]
        self.output_dir = self.project_dir / self.config["paths"]["output_dir"]
        self.db_path = db.init_db(self.data_dir / "manju.sqlite3")
        self.logger = setup_logger("manju-production", self.data_dir / "logs")
        self.comfy_url = comfy_url
        self.checkpoint = checkpoint
        self.api_key = api_key
        self.state_path = self.output_dir / "production" / "batch_state.json"
        self.report_path = self.output_dir / "production" / "production_report.json"

    def _load_state(self):
        if self.state_path.exists():
            return json.loads(self.state_path.read_text(encoding="utf-8"))
        return {"topics": []}

    def _save_state(self, topics):
        state = {"topics": topics}
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self.state_path.write_text(
            json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    def _resolve_run_id(self, topic, resume):
        if resume:
            state = self._load_state()
            for item in state.get("topics", []):
                if item.get("topic") == topic and item.get("run_id"):
                    return item["run_id"]
            with db._connect(self.db_path) as conn:
                row = conn.execute(
                    "SELECT id FROM runs WHERE topic = ? ORDER BY updated_at DESC LIMIT 1",
                    (topic,),
                ).fetchone()
            if row:
                return row["id"]
        now = datetime.now()
        run_id = now.strftime("%Y%m%d_%H%M%S")
        suffix = 1
        while db.get_run(self.db_path, run_id):
            run_id = f"{now.strftime('%Y%m%d_%H%M%S')}_{suffix}"
            suffix += 1
        return run_id

    def _run_dir(self, run_id):
        return self.data_dir / "runs" / run_id

    def _audio_dir(self, run_id):
        return self.output_dir / "audio" / run_id

    def _subtitle_dir(self, run_id):
        return self.output_dir / "subtitle" / run_id

    def _video_dir(self, run_id):
        return self.output_dir / "video" / run_id

    def _cover_dir(self, run_id):
        return self.output_dir / "cover" / run_id

    def _score_dir(self, run_id):
        return self.output_dir / "score" / run_id

    def _score_file(self, run_id):
        return self._score_dir(run_id) / "content_score.json"

    def _read_score(self, run_id):
        score_file = self._score_file(run_id)
        if not score_file.exists():
            row = db.get_content_score(self.db_path, run_id)
            if row and row.get("scores"):
                try:
                    return json.loads(row["scores"]).get("overall_score")
                except Exception:
                    return None
            return None
        return load_json(score_file).get("overall_score")

    def _stage_done(self, run_id, step_name, artifacts):
        step = db.get_step(self.db_path, run_id, step_name)
        return step and step["status"] == "done" and all(
            Path(path).exists() for path in artifacts
        )

    def _run_stage(self, run_id, step_name, artifacts, fn):
        if self._stage_done(run_id, step_name, artifacts):
            self.logger.info("stage %s already done, skip", step_name)
            return None
        db.upsert_step(self.db_path, run_id, step_name, "running")
        try:
            result = fn()
            db.upsert_step(
                self.db_path,
                run_id,
                step_name,
                "done",
                output_path=str(artifacts[0]),
            )
            return result
        except Exception as e:
            db.upsert_step(
                self.db_path,
                run_id,
                step_name,
                "error",
                error=str(e),
            )
            raise

    def _run_tts(self, run_id):
        storyboard = load_json(self._run_dir(run_id) / "storyboard.json")
        audio_dir = self._audio_dir(run_id)

        def fn():
            agent = TTSAgent(
                run_id=run_id,
                run_dir=self._run_dir(run_id),
                output_dir=audio_dir,
                db_path=self.db_path,
                logger=self.logger,
            )
            return agent.run(storyboard)

        self._run_stage(
            run_id, STEP_TTS, [audio_dir / "audio_manifest.json"], fn
        )

    def _run_subtitle(self, run_id):
        storyboard = load_json(self._run_dir(run_id) / "storyboard.json")
        audio_manifest = load_json(
            self._audio_dir(run_id) / "audio_manifest.json"
        )
        subtitle_dir = self._subtitle_dir(run_id)

        def fn():
            agent = SubtitleAgent(
                run_id=run_id,
                output_dir=subtitle_dir,
                db_path=self.db_path,
                logger=self.logger,
            )
            return agent.run(storyboard, audio_manifest)

        self._run_stage(
            run_id,
            STEP_SUBTITLE,
            [subtitle_dir / "episode.ass", subtitle_dir / "subtitle_manifest.json"],
            fn,
        )

    def _run_video(self, run_id, topic):
        shot_images = [
            {"shot_id": row["shot_id"], "image_path": row["image_path"]}
            for row in db.list_shots(self.db_path, run_id)
            if row.get("image_path") and Path(row["image_path"]).exists()
        ]
        if not shot_images:
            raise RuntimeError("no rendered images")
        audio_manifest = load_json(
            self._audio_dir(run_id) / "audio_manifest.json"
        )
        subtitle_path = self._subtitle_dir(run_id) / "episode.ass"
        video_dir = self._video_dir(run_id)
        work_dir = video_dir / "final_work"
        cover_dir = self._cover_dir(run_id)

        def fn():
            cover_agent = CoverAgent(
                run_id=run_id,
                output_dir=cover_dir,
                db_path=self.db_path,
                logger=self.logger,
            )
            cover_agent.run(shot_images[0]["image_path"], topic)
            editor = EnhancedVideoEditor(
                run_id=run_id,
                video_dir=video_dir,
                work_dir=work_dir,
                db_path=self.db_path,
                logger=self.logger,
                subtitle_path=subtitle_path,
            )
            return editor.run(shot_images, audio_manifest)

        self._run_stage(
            run_id,
            STEP_VIDEO,
            [video_dir / "episode_final.mp4", cover_dir / "cover.jpg"],
            fn,
        )

    def _run_content_score(self, run_id):
        run_dir = self._run_dir(run_id)
        score_dir = self._score_dir(run_id)

        def fn():
            agent = ContentScoreAgent(
                run_id=run_id,
                output_dir=score_dir,
                db_path=self.db_path,
                logger=self.logger,
                tmp_dir=self.data_dir / "logs",
            )
            return agent.run(
                run_dir / "script.json",
                run_dir / "storyboard.json",
                self._video_dir(run_id) / "episode_final.mp4",
                self._cover_dir(run_id) / "cover.jpg",
                self._subtitle_dir(run_id) / "subtitle_manifest.json",
                self._audio_dir(run_id) / "audio_manifest.json",
            )

        self._run_stage(
            run_id, STEP_CONTENT_SCORE, [self._score_file(run_id)], fn
        )

    def run_single_topic(self, topic, resume=False):
        run_id = self._resolve_run_id(topic, resume)
        run = db.get_run(self.db_path, run_id)
        if (
            resume
            and run
            and run["status"] == "done"
            and self._score_file(run_id).exists()
        ):
            self.logger.info(
                "topic already completed, skip: run_id=%s topic=%s", run_id, topic
            )
            return {
                "topic": topic,
                "run_id": run_id,
                "status": "done",
                "resumed": True,
                "elapsed_seconds": 0.0,
                "score": self._read_score(run_id),
            }
        if not run:
            db.create_run(self.db_path, run_id, topic)
        start = time.time()
        try:
            pipeline = Pipeline(
                project_dir=self.project_dir,
                comfy_url=self.comfy_url,
                checkpoint=self.checkpoint,
                api_key=self.api_key,
            )
            pipeline.run(topic, resume_run_id=run_id)
            self._run_tts(run_id)
            self._run_subtitle(run_id)
            self._run_video(run_id, topic)
            self._run_content_score(run_id)
            db.update_run(self.db_path, run_id, status="done", clear_error=True)
            elapsed = round(time.time() - start, 1)
            return {
                "topic": topic,
                "run_id": run_id,
                "status": "done",
                "elapsed_seconds": elapsed,
                "score": self._read_score(run_id),
            }
        except Exception as e:
            self.logger.error("topic failed: %s (%s)", topic, e)
            db.update_run(self.db_path, run_id, status="failed", error=str(e))
            elapsed = round(time.time() - start, 1)
            return {
                "topic": topic,
                "run_id": run_id,
                "status": "failed",
                "error": str(e),
                "elapsed_seconds": elapsed,
                "score": None,
            }

    def _failure_stage_stats(self, results):
        stats = {}
        for result in results:
            if result["status"] == "done":
                continue
            with db._connect(self.db_path) as conn:
                step_rows = conn.execute(
                    "SELECT step_name FROM steps WHERE run_id = ? AND status = 'error'",
                    (result["run_id"],),
                ).fetchall()
                shot_rows = conn.execute(
                    "SELECT COUNT(*) AS c FROM shots WHERE run_id = ? AND status = 'error'",
                    (result["run_id"],),
                ).fetchone()
            for row in step_rows:
                stats[row["step_name"]] = stats.get(row["step_name"], 0) + 1
            if shot_rows and shot_rows["c"]:
                stats["image"] = stats.get("image", 0) + shot_rows["c"]
        return stats

    def run(self, topics, resume=False, limit=None):
        topics = [t if isinstance(t, str) else t.get("topic") for t in topics]
        if limit:
            topics = topics[:limit]
        state = {item["topic"]: item for item in self._load_state().get("topics", [])}
        results = []
        for topic in topics:
            item = state.get(topic)
            if (
                resume
                and item
                and item.get("status") == "done"
                and self._score_file(item["run_id"]).exists()
            ):
                run_id = item["run_id"]
                self.logger.info("state done, skip: %s", topic)
                results.append(
                    {
                        "topic": topic,
                        "run_id": run_id,
                        "status": "done",
                        "resumed": True,
                        "elapsed_seconds": 0.0,
                        "score": self._read_score(run_id),
                    }
                )
                continue
            result = self.run_single_topic(topic, resume=resume)
            results.append(result)
            state[topic] = {
                "topic": topic,
                "run_id": result["run_id"],
                "status": result["status"],
            }
            self._save_state(list(state.values()))

        success = [r for r in results if r["status"] == "done"]
        failed = [r for r in results if r["status"] != "done"]
        success_times = [r["elapsed_seconds"] for r in success]
        success_scores = [r.get("score") for r in success if r.get("score") is not None]
        report = {
            "generated_at": datetime.now().isoformat(timespec="seconds"),
            "summary": {
                "total": len(results),
                "success": len(success),
                "failed": len(failed),
                "avg_duration_seconds": (
                    round(sum(success_times) / len(success_times), 1)
                    if success_times
                    else 0.0
                ),
                "avg_score": (
                    round(sum(success_scores) / len(success_scores), 1)
                    if success_scores
                    else 0.0
                ),
            },
            "failure_stages": self._failure_stage_stats(results),
            "topics": results,
        }
        self.report_path.parent.mkdir(parents=True, exist_ok=True)
        self.report_path.write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        self.logger.info(
            "production report: success=%s failed=%s avg_score=%s",
            report["summary"]["success"],
            report["summary"]["failed"],
            report["summary"]["avg_score"],
        )
        return report
