import json
import random

from app.utils.llm import chat_json


class AgentPrompt:
    def __init__(self, client, run_dir, logger, comfy_cfg):
        self.client = client
        self.run_dir = run_dir
        self.logger = logger
        self.comfy_cfg = comfy_cfg
        self.negative = (
            "deformed, extra hands, blurry, text, watermark, low quality, "
            "bad anatomy, unnatural face, inconsistent features, duplicate, cropped"
        )

    def run(self, storyboard):
        system = (
            "你是 ComfyUI 图像提示词工程师，只输出 JSON，不输出任何其他文字。\n"
            "输出结构：\n"
            '{"shots":[{"shot_id":"shot_001","positive":"英文正向提示词",'
            '"negative":"英文负向提示词","checkpoint":"majicMIXrealv4.safetensors",'
            '"width":768,"height":1344,"steps":20,"cfg":7,"seed":12345,'
            '"sampler":"euler","scheduler":"normal"}]}\n'
            "要求：竖屏 768x1344；漫画画风；positive 包含画风、场景、人物、表情动作、光影、构图；"
            "negative 包含变形、多手、模糊、文字水印；每个 shot 只描述该镜画面，不包含对白文字。"
        )
        user = "根据分镜表生成每个镜头的 ComfyUI 提示词：\n" + json.dumps(
            storyboard, ensure_ascii=False
        )
        result = chat_json(self.client, system, user, self.logger, temperature=0.7)

        for shot in result.get("shots", []):
            shot.setdefault("checkpoint", self.comfy_cfg["checkpoint"])
            shot.setdefault("width", self.comfy_cfg["width"])
            shot.setdefault("height", self.comfy_cfg["height"])
            shot.setdefault("steps", self.comfy_cfg["steps"])
            shot.setdefault("cfg", self.comfy_cfg["cfg"])
            shot.setdefault("sampler", self.comfy_cfg["sampler"])
            shot.setdefault("scheduler", self.comfy_cfg["scheduler"])
            shot.setdefault("seed", random.randint(1, 2147483646))
        self.logger.info("prompts generated: shots=%s", len(result.get("shots", [])))
        return result

    def regenerate_shot(self, shot, feedback):
        system = (
            "你是 ComfyUI 图像提示词工程师，只输出 JSON，不输出任何其他文字。\n"
            "根据 QA 反馈重新生成单个镜头的提示词，保持画风和原有内容，修复被指出的问题。\n"
            "输出结构：\n"
            '{"shot_id":"shot_001","positive":"英文正向提示词","negative":"英文负向提示词",'
            '"width":768,"height":1344,"steps":20,"cfg":7,"seed":12345,'
            '"sampler":"euler","scheduler":"normal"}'
        )
        user = "原镜头提示词和 QA 反馈：\n" + json.dumps(
            {"shot": shot, "qa_feedback": feedback}, ensure_ascii=False
        )
        result = chat_json(self.client, system, user, self.logger, temperature=0.8)
        merged = dict(shot)
        merged.update(result)
        merged["seed"] = random.randint(1, 2147483646)
        merged.setdefault("checkpoint", self.comfy_cfg["checkpoint"])
        merged.setdefault("width", self.comfy_cfg["width"])
        merged.setdefault("height", self.comfy_cfg["height"])
        merged.setdefault("steps", self.comfy_cfg["steps"])
        merged.setdefault("cfg", self.comfy_cfg["cfg"])
        merged.setdefault("sampler", self.comfy_cfg["sampler"])
        merged.setdefault("scheduler", self.comfy_cfg["scheduler"])
        self.logger.info(
            "shot %s prompt regenerated, new seed=%s", merged["shot_id"], merged["seed"]
        )
        return merged

    def run_v2(self, storyboard, characters):
        cards_text = self._character_cards_text(characters)
        system = (
            "你是漫剧分镜绘图提示词工程师，只输出 JSON，不输出任何其他文字。\n"
            "输出结构：\n"
            '{"shots":[{"shot_id":"shot_001","positive":"英文正向提示词",'
            '"negative":"英文负向提示词"}]}\n'
            "规则：\n"
            "1. 输出中不包含 width/height/steps/cfg/seed 等采样参数。\n"
            "2. 角色卡 appearance_en 必须逐字保留，禁止改写外貌、服装、发型、瞳色、标志物。\n"
            "3. 每个 shot 的 positive 必须以该镜头出场角色的 appearance_en 原文开头，"
            "再补充场景、机位、表情、动作、光影、构图。\n"
            "4. 画风固定为：manga style, anime illustration, detailed background。\n"
            "5. negative 使用下面给定内容，不得删除。\n"
            "负面词：" + self.negative + "\n"
            "角色卡（原文，必须逐字使用 appearance_en）：\n" + cards_text
        )
        user = "根据分镜表生成每个镜头的 V2 提示词：\n" + json.dumps(
            storyboard, ensure_ascii=False
        )
        result = chat_json(self.client, system, user, self.logger, temperature=0.65)
        for shot in result.get("shots", []):
            shot.pop("width", None)
            shot.pop("height", None)
            shot.pop("steps", None)
            shot.pop("cfg", None)
            shot.pop("seed", None)
            shot.pop("checkpoint", None)
            shot.pop("sampler", None)
            shot.pop("scheduler", None)
            shot.setdefault("negative", self.negative)
        self.logger.info("v2 prompts generated: shots=%s", len(result.get("shots", [])))
        return result

    def regenerate_shot_v2(self, shot, feedback, characters):
        cards_text = self._character_cards_text(characters)
        system = (
            "你是漫剧分镜绘图提示词工程师，只输出 JSON，不输出任何其他文字。\n"
            "根据 QA 反馈修复单个镜头提示词，保持角色卡外貌原文不变，修复构图、场景符合度、画面质量。\n"
            "输出结构：\n"
            '{"shot_id":"shot_001","positive":"英文正向提示词","negative":"英文负向提示词"}\n'
            "输出中不包含 width/height/steps/cfg/seed 等采样参数。\n"
            "负面词：" + self.negative + "\n"
            "角色卡（原文，必须逐字使用 appearance_en）：\n" + cards_text
        )
        user = "原镜头提示词和 QA 反馈：\n" + json.dumps(
            {"shot": shot, "qa_feedback": feedback}, ensure_ascii=False
        )
        result = chat_json(self.client, system, user, self.logger, temperature=0.75)
        merged = dict(shot)
        merged.update(result)
        merged.pop("width", None)
        merged.pop("height", None)
        merged.pop("steps", None)
        merged.pop("cfg", None)
        merged.pop("seed", None)
        merged.pop("checkpoint", None)
        merged.pop("sampler", None)
        merged.pop("scheduler", None)
        merged.setdefault("negative", self.negative)
        self.logger.info("shot %s v2 prompt regenerated", merged["shot_id"])
        return merged

    def _character_cards_text(self, characters):
        lines = []
        for char in characters or []:
            char_id = char.get("character_id", "")
            name = char.get("name", "")
            appearance = char.get("appearance_en", "")
            lines.append(f"{char_id}|{name}: {appearance}")
        return "\n".join(lines) if lines else "无角色卡"
