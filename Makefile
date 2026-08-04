.PHONY: install test lint format run-agent run-desktop

install:
	uv sync --all-packages

test:
	uv run pytest

lint:
	uv run ruff check .

format:
	uv run ruff format .

run-agent:
	cd apps/autonomous-job-agent && npm run dev

run-desktop:
	cd apps/desktop-agent && uv run --project . python webui.py
