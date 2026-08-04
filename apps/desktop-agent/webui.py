import json
import queue
import sys
import threading
import time
from pathlib import Path

from flask import Flask, Response, jsonify, render_template, request, send_file

sys.path.insert(0, str(Path(__file__).parent))
import contextlib

from agent.deepseek_client import DeepSeekClient
from agent.video_generator import VideoGenerator
from agent.web_search import WebSearch
from config import BROWSER_DATA_DIR, DEEPSEEK_BASE_URL, DEEPSEEK_MODEL, OUTPUT_DIR
from douyin.uploader import DouyinUploader

app = Flask(__name__)
tasks = {}


@app.route("/health")
def health():
    return jsonify({"status": "ok"})


def worker(task_id, cmd, api_key):
    q = tasks.get(task_id)

    def log(msg):
        q.put(msg)
        print(msg)

    try:
        client = DeepSeekClient(api_key=api_key, base_url=DEEPSEEK_BASE_URL, model=DEEPSEEK_MODEL)
        searcher = WebSearch()
        video_gen = VideoGenerator(output_dir=OUTPUT_DIR)
        uploader = DouyinUploader(data_dir=BROWSER_DATA_DIR)

        def search_web(query):
            return json.dumps(searcher.search(query), ensure_ascii=False)

        client.register_tool(
            "web_search",
            "Search web for latest info",
            {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
            search_web,
        )

        def search_news(query):
            return json.dumps(searcher.search_news(query), ensure_ascii=False)

        client.register_tool(
            "web_search_news",
            "Search latest news",
            {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
            search_news,
        )

        if cmd.startswith("topic "):
            topic = cmd[6:].strip()
            log("[1/4] Searching: " + topic)
            messages = [
                {
                    "role": "system",
                    "content": "You are a short-video script writer. Topic: "
                    + topic
                    + ". Use web_search first to search hot topics, then write a 60-second script.",
                },
                {"role": "user", "content": "Create a short-video script about: " + topic},
            ]
            script = client.chat(messages, temperature=0.8)
            log("[2/4] Script generated")
            lines = script.strip().split("\n")
            title = topic
            content_lines = []
            for line in lines:
                line = line.strip()
                if line.startswith("[TITLE]") or line.startswith("# "):
                    title = line.replace("[TITLE]", "").replace("# ", "").strip()
                elif line.startswith("[CONTENT]"):
                    content_lines.append(line.replace("[CONTENT]", "").strip())
                else:
                    content_lines.append(line)
            content = "\n".join(content_lines) or script
            log("[3/4] Generating video...")
            safe_name = topic.replace(" ", "_")[:30]
            video_path = video_gen.generate_video(title, content, output_name=safe_name + ".mp4")
            log("[done] Video: " + str(video_path))
            log("[4/4] Opening browser for Douyin upload...")
            uploader.start()
            uploader.login()
            uploader.upload(str(video_path), title)
            log("[done] Upload completed")

        elif cmd == "upload" or cmd.startswith("upload "):
            path_part = cmd[7:].strip() if cmd.startswith("upload ") else ""
            if path_part:
                video_path = Path(path_part)
            else:
                files = list(OUTPUT_DIR.glob("*.mp4"))
                if not files:
                    log("No videos found in output/")
                    q.put("__DONE__")
                    return
                video_path = files[-1]
                log("Selected: " + video_path.name)
            uploader.start()
            uploader.login()
            uploader.upload(str(video_path))
            log("[done] Upload completed")
        else:
            log("Unknown command. Use: topic <subject> or upload")
    except Exception as e:
        log("[error] " + str(e))
    finally:
        q.put("__DONE__")


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/run", methods=["POST"])
def api_run():
    data = request.json
    cmd = data.get("command", "")
    api_key = data.get("api_key", "")
    if not cmd:
        return jsonify({"error": "empty command"}), 400
    if not api_key:
        return jsonify({"error": "API key required"}), 400
    task_id = str(int(time.time() * 1000))
    q = queue.Queue()
    q.put("> " + cmd)
    tasks[task_id] = q
    threading.Thread(target=worker, args=(task_id, cmd, api_key), daemon=True).start()
    return jsonify({"task_id": task_id})


@app.route("/api/stream/<task_id>")
def api_stream(task_id):
    with contextlib.suppress(Exception):
        pass
    q = tasks.get(task_id)
    if not q:
        return Response('data: {"done":true}\n\n', mimetype="text/event-stream")

    def generate():
        while True:
            try:
                msg = q.get(timeout=2)
                if msg == "__DONE__":
                    yield 'data: {"done":true}\n\n'
                    break
                import json as jmod

                yield "data: " + jmod.dumps({"log": msg}, ensure_ascii=False) + "\n\n"
            except Exception:
                yield ": keepalive\n\n"

    return Response(generate(), mimetype="text/event-stream")


@app.route("/output/<path:filename>")
def serve_output(filename):
    return send_file(OUTPUT_DIR / filename)


if __name__ == "__main__":
    print("Starting Douyin Agent Web UI at http://127.0.0.1:5050")
    print("Press Ctrl+C to stop")
    app.run(host="127.0.0.1", port=5050, debug=False, threaded=True)
