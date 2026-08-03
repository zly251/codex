FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy

COPY --from=ghcr.io/astral-sh/uv:0.11.32 /uv /uvx /bin/

WORKDIR /app

COPY pyproject.toml uv.lock README.md LICENSE ./
COPY apps apps
COPY packages packages

RUN uv sync --all-packages

EXPOSE 5050 5001

CMD ["uv", "run", "--project", "apps/desktop-agent", "python", "webui.py"]
