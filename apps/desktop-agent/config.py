import os
from pathlib import Path

DEEPSEEK_API_KEY = os.environ.get("DEEPSEEK_API_KEY", "")
DEEPSEEK_BASE_URL = "https://api.deepseek.com"
DEEPSEEK_MODEL = "deepseek-chat"

BASE_DIR = Path(__file__).parent
OUTPUT_DIR = BASE_DIR / "output"

VIDEO_WIDTH = 1080
VIDEO_HEIGHT = 1920
FPS = 24
TTS_VOICE = "zh-CN-XiaoxiaoNeural"

BROWSER_DATA_DIR = BASE_DIR / "browser_data"
