from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_core_files_exist():
    for name in ["config.py", "main.py", "pyproject.toml", "README.md"]:
        assert (ROOT / name).exists()
