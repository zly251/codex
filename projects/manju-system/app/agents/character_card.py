import json

from app.utils.llm import chat_json


class CharacterCardAgent:
    def __init__(self, client, run_dir, logger):
        self.client = client
        self.run_dir = run_dir
        self.logger = logger

    def run(self, script, storyboard):
        system = (
            "你是漫剧角色设定师，只输出 JSON，不输出任何其他文字。\n"
            "根据剧本和分镜提取全部角色，输出结构：\n"
            '{"characters":[{"character_id":"char_001","name":"角色名","role":"主角/配角",'
            '"gender":"女","age":"20岁左右","appearance_cn":"中文外貌描述",'
            '"appearance_en":"英文外貌标签，逗号分隔，用于Stable Diffusion",'
            '"clothing_cn":"中文服装描述","clothing_en":"英文服装标签",'
            '"hair_style":"发型","eye_color":"瞳色","distinctive_marker":"标志性特征",'
            '"style_tags":"统一画风标签","voice":"zh-CN-XiaoxiaoNeural"}]}\n'
            "要求：\n"
            "1. 每个在分镜中出现的角色都必须生成角色卡。\n"
            "2. appearance_en 必须是可直接写进 ComfyUI 正向提示词的英文标签，禁止中文。\n"
            "3. distinctive_marker 用于跨镜头锁定角色，必须是具体且可画的标志。\n"
            "4. 所有角色必须共享统一风格标签：manga style, anime illustration, detailed background。\n"
        )
        user = (
            "剧本：\n"
            + json.dumps(script, ensure_ascii=False)
            + "\n\n分镜：\n"
            + json.dumps(storyboard, ensure_ascii=False)
        )
        result = chat_json(self.client, system, user, self.logger, temperature=0.5)
        self.logger.info(
            "character cards generated: %s", len(result.get("characters", []))
        )
        return result
