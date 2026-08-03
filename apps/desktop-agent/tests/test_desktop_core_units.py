import json
from pathlib import Path

import httpx
from agent import deepseek_client, video_generator, web_search
from config import DEEPSEEK_MODEL


class FakeDDGS:
    def __init__(self, mode="ok"):
        self.mode = mode

    def text(self, query, max_results=5):
        if self.mode == "error":
            raise RuntimeError("search failed")
        return [{"title": f"{query} title", "href": "https://example.com", "body": "body"}]

    def news(self, query, max_results=5):
        return [{"title": f"{query} news", "url": "https://example.com/news", "body": "news"}]


class FakeResponse:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code
        self.text = json.dumps(payload)

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(f"HTTP {self.status_code}", request=None, response=self)

    def json(self):
        return self._payload


def test_deepseek_chat_tool_call_round_trip(monkeypatch):
    client = deepseek_client.DeepSeekClient("test-key", model=DEEPSEEK_MODEL)
    tool_payload = {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "tool_calls": [
                        {
                            "id": "call_1",
                            "function": {
                                "name": "echo",
                                "arguments": json.dumps({"value": "ok"}),
                            },
                        }
                    ],
                }
            }
        ]
    }
    final_payload = {"choices": [{"message": {"content": "done"}}]}
    responses = iter([FakeResponse(tool_payload), FakeResponse(final_payload)])
    monkeypatch.setattr(client.client, "post", lambda url, json, headers: next(responses))
    client.register_tool("echo", "Echo value", {"type": "object"}, lambda value: value)
    assert client.chat([{"role": "user", "content": "hi"}]) == "done"


def test_web_search_success_and_error(monkeypatch, tmp_path):
    monkeypatch.setattr(web_search, "DDGS", FakeDDGS)
    searcher = web_search.WebSearch()
    assert searcher.search("codex")[0]["title"] == "codex title"
    assert searcher.search_news("codex")[0]["url"].endswith("/news")
    monkeypatch.setattr(web_search, "DDGS", lambda: FakeDDGS(mode="error"))
    searcher.ddgs = web_search.DDGS()
    assert searcher.search("codex")[0]["error"] == "search failed"


def test_video_generator_helpers_and_missing_ffmpeg(tmp_path, monkeypatch):
    generator = video_generator.VideoGenerator(tmp_path)
    frame = generator._create_text_frame("hello")
    assert Path(frame).exists()
    monkeypatch.setattr(video_generator, "FFMPEG", None)
    assert generator.generate_video("title", "content") is None


def test_webui_routes():
    from webui import app

    with app.test_client() as client:
        response = client.get("/")
        assert response.status_code == 200
        empty = client.post("/api/run", json={"command": "", "api_key": "x"})
        assert empty.status_code == 400
        missing_key = client.post("/api/run", json={"command": "topic ai", "api_key": ""})
        assert missing_key.status_code == 400
