import json
import os
from datetime import datetime
from pathlib import Path

from app.agents.prompt import AgentPrompt
from app.agents.script_writer import AgentScriptWriter
from app.agents.storyboard import AgentStoryboard
from app.comfy.client import ComfyClient
from app.data import db
from app.data.store import load_json, save_json
from app.utils.deepseek_client import DeepSeekClient
from app.utils.logging import setup_logger
from app.visual_qa.agent import VisualQAAgent

STEP_SCRIPT = "script_writer"
STEP_STORYBOARD = "storyboard"
STEP_PROMPTS = "prompt"


class Pipeline:
    def __init__(self, project_dir=None, comfy_url=None, checkpoint=None, api_key=None):
        self.project_dir = Path(project_dir) if project_dir else Path(__file__).resolve().parents[2]
        self.config = self._load_config()
        if comfy_url:
            self.config["comfy"]["base_url"] = comfy_url
        if checkpoint:
            self.config["comfy"]["checkpoint"] = checkpoint
        self.data_dir = self.project_dir / self.config["paths"]["data_dir"]
        self.output_dir = self.project_dir / self.config["paths"]["output_dir"]
        self.log_dir = self.data_dir / "logs"
        self.db_path = db.init_db(self.data_dir / "manju.sqlite3")
        self.logger = setup_logger("manju", self.log_dir)

        self.api_key = api_key or self._resolve_api_key()
        deepseek_cfg = self.config["deepseek"]
        self.client = DeepSeekClient(
            api_key=self.api_key,
            base_url=deepseek_cfg["base_url"],
            model=deepseek_cfg["model"],
        )
        self.run_id = None
        self.run_dir = None
        self.comfy = None

    def _load_config(self):
        config_path = self.project_dir / "config" / "config.json"
        with open(config_path, encoding="utf-8") as f:
            return json.load(f)

    def _resolve_api_key(self):
        key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
        if key:
            return key
        key_file = Path.home() / ".douyin_agent_key"
        if key_file.exists():
            return key_file.read_text(encoding="utf-8").strip()
        raise RuntimeError(
            "缺少 DeepSeek API Key：设置 DEEPSEEK_API_KEY 或创建 ~/.douyin_agent_key"
        )

    def run(self, topic, resume_run_id=None):
        if resume_run_id:
            run = db.get_run(self.db_path, resume_run_id)
            if not run:
                raise RuntimeError(f"run 不存在: {resume_run_id}")
            self.run_id = resume_run_id
            topic = run["topic"]
            self.logger.info("resume run_id=%s status=%s", resume_run_id, run["status"])
        else:
            self.run_id = datetime.now().strftime("%Y%m%d_%H%M%S")
            db.create_run(self.db_path, self.run_id, topic)
        self.run_dir = self.data_dir / "runs" / self.run_id
        self.run_dir.mkdir(parents=True, exist_ok=True)
        self.logger.info("run_id=%s topic=%s", self.run_id, topic)

        try:
            script = self._run_step(
                STEP_SCRIPT,
                "script.json",
                lambda: AgentScriptWriter(self.client, self.run_dir, self.logger).run(topic),
            )
            storyboard = self._run_step(
                STEP_STORYBOARD,
                "storyboard.json",
                lambda: AgentStoryboard(self.client, self.run_dir, self.logger).run(script),
            )
            self.prompt_agent = AgentPrompt(
                self.client, self.run_dir, self.logger, self.config["comfy"]
            )
            prompts = self._run_step(
                STEP_PROMPTS,
                "prompts.json",
                lambda: self.prompt_agent.run(storyboard),
            )

            comfy_cfg = self.config["comfy"]
            self.comfy = ComfyClient(
                base_url=comfy_cfg["base_url"],
                checkpoint=comfy_cfg["checkpoint"],
                output_dir=self.output_dir / "images",
                timeout_seconds=comfy_cfg["timeout_seconds"],
                logger=self.logger,
            )
            self.comfy.check_ready()
            self.comfy.ensure_checkpoint()

            self.qa_agent = VisualQAAgent(self.project_dir, self.config, self.logger)
            results = self.render_shots(prompts, storyboard)
            failed = [r for r in results if r.get("error")]
            status = "done" if not failed else "partial"
            db.update_run(self.db_path, self.run_id, status=status, clear_error=status == "done")
            summary = {
                "run_id": self.run_id,
                "topic": topic,
                "status": status,
                "script": str(self.run_dir / "script.json"),
                "storyboard": str(self.run_dir / "storyboard.json"),
                "prompts": str(self.run_dir / "prompts.json"),
                "render_summary": str(self.run_dir / "render_summary.json"),
                "shots": results,
            }
            summary_path = save_json(self.run_dir / "run_summary.json", summary, self.logger)
            self.logger.info("pipeline done: %s", summary_path)
            return summary
        except Exception as e:
            db.update_run(self.db_path, self.run_id, status="failed", error=str(e))
            self.logger.error("pipeline failed: %s", e)
            raise

    def _run_step(self, step_name, filename, fn):
        output_path = self.run_dir / filename
        step = db.get_step(self.db_path, self.run_id, step_name)
        if step and step["status"] == "done" and output_path.exists():
            self.logger.info("step %s already done, skip", step_name)
            return load_json(output_path)
        retries = (step["retries"] if step else 0) + 1
        db.upsert_step(self.db_path, self.run_id, step_name, "running", retries=retries)
        try:
            data = fn()
            save_json(output_path, data, self.logger)
            db.upsert_step(
                self.db_path,
                self.run_id,
                step_name,
                "done",
                output_path=str(output_path),
                retries=retries,
            )
            return data
        except Exception as e:
            db.upsert_step(
                self.db_path, self.run_id, step_name, "error", error=str(e), retries=retries
            )
            raise

    def render_shots(self, prompts, storyboard=None, shot_filter=None):
        results = []
        shots = prompts.get("shots", [])
        storyboard_map = {shot["shot_id"]: shot for shot in (storyboard or {}).get("shots", [])}
        character_refs = {}
        self.logger.info("render_shots start, total=%s", len(shots))
        for shot in shots:
            shot_id = shot["shot_id"]
            if shot_filter and shot_id not in shot_filter:
                continue
            record = db.get_shot(self.db_path, self.run_id, shot_id)
            if (
                record
                and record["status"] == "done"
                and record["image_path"]
                and Path(record["image_path"]).exists()
            ):
                self.logger.info("shot %s already done, skip", shot_id)
                results.append(
                    {
                        "shot_id": shot_id,
                        "image_path": record["image_path"],
                        "seed": record["seed"],
                        "skipped": True,
                    }
                )
                continue
            retries = (record["retries"] if record else 0) + 1
            db.upsert_shot(
                self.db_path,
                self.run_id,
                shot_id,
                "running",
                seed=shot.get("seed"),
                retries=retries,
            )
            try:
                attempts = 0
                qa_result = None
                while True:
                    attempts += 1
                    result = self.comfy.generate(shot, filename_prefix=self.run_id)
                    story_shot = storyboard_map.get(shot_id, {})
                    characters = story_shot.get("characters") or []
                    character_name = characters[0].get("name") if characters else None
                    reference_path = character_refs.get(character_name) if character_name else None
                    qa_result = self.qa_agent.run(
                        result["image_path"],
                        shot,
                        story_shot,
                        reference_path,
                    )
                    if not qa_result["needs_regenerate"] or attempts > self.qa_agent.max_retries:
                        break
                    self.logger.warning(
                        "shot %s qa=%.1f below %s, regenerate attempt=%s/%s",
                        shot_id,
                        qa_result["scores"]["total"],
                        self.qa_agent.threshold,
                        attempts,
                        self.qa_agent.max_retries,
                    )
                    shot = self.prompt_agent.regenerate_shot(shot, qa_result["reason"])
                    self._update_prompts_shot(shot)
                save_json(self.run_dir / f"qa_{shot_id}.json", qa_result, self.logger)
                save_json(self.run_dir / f"render_{shot_id}.json", result, self.logger)
                db.upsert_shot(
                    self.db_path,
                    self.run_id,
                    shot_id,
                    "done",
                    seed=shot.get("seed"),
                    image_path=result["image_path"],
                    retries=retries,
                    qa_score=qa_result["scores"]["total"],
                    qa_retries=attempts - 1,
                )
                if character_name:
                    character_refs[character_name] = result["image_path"]
                results.append(
                    {
                        **result,
                        "qa": qa_result,
                        "qa_retries": attempts - 1,
                    }
                )
                self.logger.info("shot %s done: %s", shot_id, result["image_path"])
            except Exception as e:
                self.logger.error("shot %s failed: %s", shot_id, e)
                db.upsert_shot(
                    self.db_path,
                    self.run_id,
                    shot_id,
                    "error",
                    seed=shot.get("seed"),
                    error=str(e),
                    retries=retries,
                )
                results.append({"shot_id": shot_id, "error": str(e)})
        save_json(self.run_dir / "render_summary.json", results, self.logger)
        return results

    def _update_prompts_shot(self, updated_shot):
        prompts_path = self.run_dir / "prompts.json"
        prompts = load_json(prompts_path)
        for idx, shot in enumerate(prompts.get("shots", [])):
            if shot["shot_id"] == updated_shot["shot_id"]:
                prompts["shots"][idx] = updated_shot
                break
        save_json(prompts_path, prompts, self.logger)
