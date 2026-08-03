import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_config_loads():
    cfg = json.loads((ROOT / "config" / "config.json").read_text(encoding="utf-8"))
    assert "deepseek" in cfg
    assert "comfy" in cfg


def test_readme_exists():
    assert (ROOT / "README.md").exists()
