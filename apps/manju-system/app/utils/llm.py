import json
import re
import time


class LLMJsonError(RuntimeError):
    pass


def extract_json(text):
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise LLMJsonError("LLM 输出中没有 JSON 对象")
    return json.loads(text[start : end + 1])


def chat_json(client, system, user, logger, temperature=0.7, retries=2, backoff_seconds=3):
    last_error = None
    for attempt in range(retries + 1):
        try:
            content = client.chat(
                [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                temperature=temperature,
            )
            return extract_json(content)
        except Exception as e:
            last_error = e
            logger.warning("DeepSeek 调用失败 attempt=%s/%s: %s", attempt + 1, retries + 1, e)
            if attempt < retries:
                time.sleep(backoff_seconds * (attempt + 1))
    raise LLMJsonError(f"DeepSeek 重试 {retries + 1} 次后仍失败: {last_error}")
