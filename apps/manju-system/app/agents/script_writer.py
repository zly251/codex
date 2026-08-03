from app.utils.llm import chat_json


class AgentScriptWriter:
    def __init__(self, client, run_dir, logger):
        self.client = client
        self.run_dir = run_dir
        self.logger = logger

    def run(self, topic):
        system = (
            "你是短剧编剧，只输出 JSON，不输出任何其他文字。"
            "输出结构："
            '{"episode":1,"title":"标题","logline":"一句话故事","hook":"开场钩子",'
            '"cliffhanger":"结尾悬念","scenes":[{"id":"s1","location":"地点",'
            '"time":"时间","mood":"情绪","dialogue":["对白1"],"action":["动作1"]}]}'
            "要求：单集 60-120 秒，3-5 个场景，每个场景 1-3 句对白，适合抖音竖屏漫剧。"
        )
        user = "根据这个选题写一集短剧：" + topic
        result = chat_json(self.client, system, user, self.logger, temperature=0.8)
        result["topic"] = topic
        self.logger.info(
            "script generated: title=%s scenes=%s",
            result.get("title"),
            len(result.get("scenes", [])),
        )
        return result
