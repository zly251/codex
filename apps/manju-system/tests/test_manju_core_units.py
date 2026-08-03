import base64
import importlib.util
import json
import logging
from pathlib import Path

from app.agents.character_card import CharacterCardAgent
from app.agents.prompt import AgentPrompt
from app.agents.script_writer import AgentScriptWriter
from app.agents.storyboard import AgentStoryboard
from app.utils import llm
from app.utils.logging import setup_logger
from app.vision_test import prompt_feedback, quality_judge, repair_strategy, vision_judge
from app.vision_test.visual_issue_classifier import VisualIssueClassifier
from PIL import Image


def _load_voice_config():
    path = Path(__file__).resolve().parents[1] / "app" / "voice" / "voice_config.py"
    spec = importlib.util.spec_from_file_location("voice_config", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


voice_config = _load_voice_config()
pick_voice = voice_config.pick_voice


class FakeClient:
    def __init__(self, result):
        self.result = result

    def chat(self, messages, temperature=0.7):
        return json.dumps(self.result, ensure_ascii=False)


def test_llm_extract_json_and_retries(monkeypatch):
    assert llm.extract_json('```json\n{"ok": true}\n```') == {"ok": True}
    assert llm.extract_json('prefix {"ok": true} suffix') == {"ok": True}
    monkeypatch.setattr(llm.time, "sleep", lambda seconds: None)
    logger = logging.getLogger("test.llm")
    assert llm.chat_json(FakeClient({"ok": True}), "s", "u", logger) == {"ok": True}
    try:
        llm.extract_json("no json")
    except llm.LLMJsonError:
        pass
    else:
        raise AssertionError("expected LLMJsonError")


def test_agents_use_chat_json(tmp_path, caplog):
    logger = logging.getLogger("test.agents")
    client = FakeClient(
        {
            "title": "T",
            "scenes": [],
            "shots": [{"shot_id": "shot_001"}],
            "characters": [{"name": "A", "appearance_en": "blue hair"}],
        }
    )
    comfy_cfg = {
        "checkpoint": "model.safetensors",
        "width": 768,
        "height": 1344,
        "steps": 20,
        "cfg": 7,
        "sampler": "euler",
        "scheduler": "normal",
    }
    assert AgentScriptWriter(client, tmp_path, logger).run("topic")["topic"] == "topic"
    storyboard = AgentStoryboard(client, tmp_path, logger).run({"scenes": []})
    assert storyboard["shots"]
    cards = CharacterCardAgent(client, tmp_path, logger).run({"episode": 1}, storyboard)
    assert cards["characters"]

    prompt_agent = AgentPrompt(client, tmp_path, logger, comfy_cfg)
    result = prompt_agent.run(storyboard)
    assert result["shots"][0]["checkpoint"] == comfy_cfg["checkpoint"]
    regenerated = prompt_agent.regenerate_shot(result["shots"][0], {"problems": []})
    assert regenerated["seed"] is not None
    v2 = prompt_agent.run_v2(storyboard, cards["characters"])
    assert "width" not in v2["shots"][0]
    v2_regenerated = prompt_agent.regenerate_shot_v2(
        v2["shots"][0], {"problems": []}, cards["characters"]
    )
    assert "negative" in v2_regenerated
    assert prompt_agent._character_cards_text([]) == "无角色卡"


def test_prompt_feedback_and_issue_classifier():
    prompt = {"shot_id": "s1", "positive": "a", "negative": "b"}
    report = {
        "prompt_fix": [["extra hands", "blurry background"]],
        "problems": ["composition is cluttered", "AI artifact"],
        "character_quality": 60,
        "scene_quality": 65,
        "composition_quality": 55,
        "ai_artifact_score": 75,
    }
    fixed = prompt_feedback.PromptFeedback().generate(prompt, report)
    assert "correct hand anatomy" in fixed["positive"]
    assert "blurry background" in fixed["negative"]
    assert fixed["changed_parts"]

    classified = VisualIssueClassifier().classify(report)
    assert classified["issues"]
    assert classified["render_strategy"]["change_prompt"] is True
    assert classified["render_strategy"]["change_seed"] is True


def test_repair_strategy_and_voice_picker():
    strategy = repair_strategy.RepairStrategy()
    assert strategy.build({}) == {"repair": "none", "method": "keep_current"}
    assert strategy.build({"issues": [{"type": "character_error"}]}) == {
        "repair": "character_reference",
        "method": "IPAdapter_future",
        "fallback": "FaceDetailer",
    }
    assert pick_voice("奶奶") == "zh-CN-XiaoyiNeural"
    assert pick_voice("", {"": "custom"}) == "custom"
    assert pick_voice("Alice") in [
        "zh-CN-XiaoxiaoNeural",
        "zh-CN-YunxiNeural",
        "zh-CN-XiaoyiNeural",
        "zh-CN-YunyangNeural",
        "zh-CN-YunjianNeural",
    ]


def test_vision_judge_helpers_and_normalization(tmp_path):
    assert vision_judge._as_list(None) == []
    assert vision_judge._as_list([[1], 2]) == [1, 2]
    assert vision_judge._clamp([80, 90]) == 85.0
    assert vision_judge._extract_json('x {"a": 1} y') == {"a": 1}
    image = Image.new("RGB", (20, 20), "white")
    image_path = tmp_path / "frame.png"
    image.save(image_path)
    encoded = vision_judge._image_to_base64(image_path, max_side=16)
    assert base64.b64decode(encoded)

    judge = quality_judge.QualityJudge()
    normalized = judge._normalize(
        {
            "character_quality": 90,
            "scene_quality": 85,
            "composition_quality": 80,
            "ai_artifact_score": 20,
        }
    )
    assert normalized["character_identity"] == 90
    assert normalized["rerender"] is False

    judge._normalize(
        {
            "character_quality": 60,
            "scene_quality": 60,
            "composition_quality": 60,
            "ai_artifact_score": 80,
        }
    )


def test_quality_judge_judge_call(monkeypatch, tmp_path):
    image = Image.new("RGB", (16, 16), "black")
    image_path = tmp_path / "shot.png"
    image.save(image_path)

    class FakeHTTPResponse:
        def raise_for_status(self):
            pass

        def json(self):
            return {
                "message": {
                    "content": json.dumps(
                        {
                            "character_quality": 90,
                            "scene_quality": 90,
                            "composition_quality": 90,
                            "ai_artifact_score": 10,
                            "problems": [],
                            "prompt_fix": [],
                        }
                    )
                }
            }

    monkeypatch.setattr(quality_judge.httpx, "post", lambda *args, **kwargs: FakeHTTPResponse())
    result = quality_judge.QualityJudge().judge(image_path, {"positive": "x"})
    assert result["rerender"] is False


def test_setup_logger_writes_file(tmp_path):
    logger = setup_logger("test.setup", tmp_path)
    logger.info("hello")
    assert (tmp_path / "pipeline.log").exists()
    assert any(isinstance(handler, logging.FileHandler) for handler in logger.handlers)
