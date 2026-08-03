import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from agent.deepseek_client import DeepSeekClient
from agent.video_generator import VideoGenerator
from agent.web_search import WebSearch
from config import BROWSER_DATA_DIR, DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL, DEEPSEEK_MODEL, OUTPUT_DIR
from douyin.uploader import DouyinUploader


def main():
    print("=" * 50)
    print("  Douyin Agent MVP")
    print("=" * 50)

    api_key = DEEPSEEK_API_KEY
    if not api_key:
        api_key = input("Enter DeepSeek API Key: ").strip()
        if not api_key:
            print("Error: API Key required")
            sys.exit(1)

    client = DeepSeekClient(api_key=api_key, base_url=DEEPSEEK_BASE_URL, model=DEEPSEEK_MODEL)
    searcher = WebSearch()
    video_gen = VideoGenerator(output_dir=OUTPUT_DIR)
    uploader = DouyinUploader(data_dir=BROWSER_DATA_DIR)

    def search_web(query):
        return json.dumps(searcher.search(query), ensure_ascii=False)

    client.register_tool(
        "web_search",
        "Search the web for latest information",
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

    print(
        "Commands:\n  topic <topic>  - Search and generate video\n  upload <file>  - Upload to Douyin\n  exit          - Exit\n"
    )

    while True:
        try:
            cmd = input("> ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if cmd.lower() in ("exit", "quit"):
            break
        if cmd.lower().startswith("topic "):
            topic = cmd[6:].strip()
            if not topic:
                print("Enter topic")
                continue
            handle_topic(client, video_gen, topic)
        elif cmd.lower().startswith("upload "):
            parts = cmd.split(None, 1)
            path = parts[1] if len(parts) > 1 else ""
            handle_upload(uploader, path)
        elif cmd:
            print("Unknown command:", cmd)
    uploader.close()


def handle_topic(client, video_gen, topic):
    print("[1/4] Searching:", topic)
    messages = [
        {
            "role": "system",
            "content": "You are a short-video script writer. Topic: "
            + topic
            + "\nUse web_search to search hot topics, then write a 60-second script. Format:\n[TITLE]...\n[CONTENT]...",
        },
        {"role": "user", "content": "Create a short-video script about: " + topic},
    ]
    script = client.chat(messages, temperature=0.8)
    print("[2/4] Script generated:\n" + script)
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
    print("[3/4] Generating video...")
    video_path = video_gen.generate_video(title, content, output_name=f"{topic}.mp4")
    print("Video generated:", video_path)
    print("[4/4] Preparing to upload to Douyin...")
    uploader = DouyinUploader(data_dir=BROWSER_DATA_DIR)
    upload_video(uploader, str(video_path), title)


def upload_video(uploader, video_path, title=""):
    if not os.path.exists(video_path):
        print("File not found:", video_path)
        return
    uploader.start()
    uploader.login()
    uploader.upload(video_path, title)


def handle_upload(uploader, path):
    if not path:
        files = list(OUTPUT_DIR.glob("*.mp4"))
        if not files:
            print("No video files found in output/")
            return
        print("Available videos:")
        for i, f in enumerate(files):
            print(f"  {i + 1}. {f.name}")
        choice = input("Enter number: ").strip()
        try:
            path = str(files[int(choice) - 1])
        except (ValueError, IndexError):
            print("Invalid choice")
            return
    upload_video(uploader, path)


if __name__ == "__main__":
    main()
