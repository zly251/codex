import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.orchestration.pipeline import Pipeline


def main():
    parser = argparse.ArgumentParser(description="AI 漫剧生产最小闭环")
    parser.add_argument("topic", nargs="?", default="一个穷女孩发现自己是豪门继承人")
    parser.add_argument("--resume", metavar="RUN_ID", help="从指定 run 断点恢复")
    parser.add_argument("--comfy-url", help="覆盖 ComfyUI 地址")
    parser.add_argument("--checkpoint", help="覆盖 ComfyUI 底模")
    parser.add_argument("--api-key", help="覆盖 DeepSeek API Key")
    args = parser.parse_args()
    pipeline = Pipeline(
        comfy_url=args.comfy_url,
        checkpoint=args.checkpoint,
        api_key=args.api_key,
    )
    try:
        summary = pipeline.run(args.topic, resume_run_id=args.resume)
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    except Exception as e:
        print(f"PIPELINE_ERROR {type(e).__name__}: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
