import json

import httpx


class DeepSeekClient:
    def __init__(self, api_key, base_url="https://api.deepseek.com", model="deepseek-chat"):
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.client = httpx.Client(timeout=60)
        self._tools = []

    def register_tool(self, name, description, parameters, handler):
        self._tools.append(
            {
                "type": "function",
                "function": {"name": name, "description": description, "parameters": parameters},
            }
        )
        setattr(self, f"_call_{name}", handler)

    def chat(self, messages, temperature=1.0):
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload = {"model": self.model, "messages": messages, "temperature": temperature}
        if self._tools:
            payload["tools"] = self._tools
            payload["tool_choice"] = "auto"

        resp = self.client.post(
            f"{self.base_url}/v1/chat/completions", json=payload, headers=headers
        )
        try:
            resp.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise Exception(f"API {resp.status_code}: {resp.text}") from exc

        data = resp.json()
        msg = data["choices"][0]["message"]

        if msg.get("tool_calls"):
            messages.append(msg)
            for tc in msg["tool_calls"]:
                fn_name = tc["function"]["name"]
                fn_args = json.loads(tc["function"]["arguments"])
                handler = getattr(self, f"_call_{fn_name}", None)
                if handler:
                    result = handler(**fn_args)
                    messages.append(
                        {"role": "tool", "tool_call_id": tc["id"], "content": str(result)}
                    )
            return self.chat(messages, temperature)

        return msg["content"]
