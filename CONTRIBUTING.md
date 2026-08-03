# Contributing

## Quick Start

```bash
git clone --recurse-submodules https://github.com/zly251/codex.git codex
cd codex && uv sync --all-packages
uv run pre-commit install && uv run pytest
```

## Environment Setup

1. 复制环境变量模板：

```bash
cp .env.example .env
```

2. 填写必要的 API Key 和 Cookie。

3. `.env` 不要提交到仓库，已由 `.gitignore` 忽略。

## 环境要求

- Python 3.11+
- uv
- Node.js 20+（仅求职助手）

## 开发流程

1. 从 main 新建分支：`codex/<功能名>`
2. 修改或新增文件
3. 本地验证：`uv run ruff check .`、`uv run ruff format --check .`、`uv run pytest`
4. 提交并推送
5. 创建 Pull Request

## 提交格式

- `feat:` 新功能
- `fix:` 修复
- `docs:` 文档
- `chore:` 工程化
- `test:` 测试

## 规范

- 可执行应用放在 `apps/`
- 共享公共库放在 `packages/`
- 不提交模型、缓存、数据、密钥、Cookie、`.venv`
- 新应用必须包含 README.md、PROJECT_STATUS.md、.env.example
- 修改前先阅读 `PROJECT_STATUS.md` 和 `docs/ARCHITECTURE.md`
- 提交前运行 `uv run pre-commit run --all-files`
