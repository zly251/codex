from app.utils.llm import chat_json


class AgentStoryboard:
    def __init__(self, client, run_dir, logger):
        self.client = client
        self.run_dir = run_dir
        self.logger = logger

    def run(self, script):
        system = (
            "你是分镜师，只输出 JSON，不输出任何其他文字。"
            "根据剧本 JSON 拆分为镜表，输出结构："
            '{"shots":[{"shot_id":"shot_001","scene_id":"s1","duration":6,'
            '"camera":"中景，平视，轻微推近","characters":[{"name":"角色名",'
            '"emotion":"情绪","pose":"动作姿势"}],"dialogue_text":"该镜对白",'
            '"sfx":"音效","bgm":"配乐"}]}'
            "要求：每句对白至少一镜，每镜 3-8 秒，镜头数量 4-8 个，全部字段必填。"
        )
        user = "把下面的剧本拆成分镜表：\n" + __import__("json").dumps(script, ensure_ascii=False)
        result = chat_json(self.client, system, user, self.logger, temperature=0.7)
        self.logger.info("storyboard generated: shots=%s", len(result.get("shots", [])))
        return result
