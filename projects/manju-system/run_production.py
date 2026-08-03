import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.orchestration.production_runner import ProductionRunner


def main():
    parser = argparse.ArgumentParser(description="Production Runner")
    parser.add_argument("--topics", required=True, help="topics.json path")
    parser.add_argument("--limit", type=int, help="only process first N topics")
    parser.add_argument("--resume", action="store_true", help="resume batch")
    parser.add_argument("--comfy-url", help="override ComfyUI address")
    parser.add_argument("--checkpoint", help="override ComfyUI checkpoint")
    parser.add_argument("--api-key", help="override DeepSeek API key")
    args = parser.parse_args()

    topics_path = Path(args.topics)
    if not topics_path.exists():
        raise SystemExit(f"topics file missing: {topics_path}")
    topics = json.loads(topics_path.read_text(encoding="utf-8"))

    runner = ProductionRunner(
        comfy_url=args.comfy_url,
        checkpoint=args.checkpoint,
        api_key=args.api_key,
    )
    report = runner.run(topics, resume=args.resume, limit=args.limit)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
