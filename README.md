# Codex AI Engineering Workspace

![CI](https://github.com/zly251/codex/actions/workflows/ci.yml/badge.svg)
![License](https://img.shields.io/github/license/zly251/codex)

基于 uv 的 Python Mono-Repo Workspace，用于管理 Codex、DeepSeek、Agent、ComfyUI 等 AI 自动化项目。

## 快速开始

## Python 项目

1. 克隆并进入仓库：

```bash
git clone --recurse-submodules https://github.com/zly251/codex.git codex
cd codex
```

2. 安装依赖：

```bash
uv sync --all-packages
```

3. 启动抖音桌面 Agent：

```bash
uv run --project apps/desktop-agent python main.py
```

4. 启动 Manju 内容生产系统：

```bash
uv run --project apps/manju-system python run_final.py
```

## Node/TypeScript 项目

求职助手：

```bash
cd apps/autonomous-job-agent
npm install
npm run dev
```

Manga Editor（第三方子模块）：

```bash
cd apps/manga-editor-desu
npm install
python 99_server.py

```

## Using Docker

前置条件：

- 确保 Docker Desktop 已启动，且 Docker 的 WSL 数据盘有读写权限。
- 如果构建失败，优先检查 Docker 数据盘挂载位置。Windows 常见问题：Docker 数据盘位于权限受限分区时，WSL 无法挂载 `ext4.vhdx`，`docker compose build` 会返回 500。

启动全部容器：

```bash
docker compose up -d
```

服务端口：`desktop-agent` 5050，`autonomous-job-agent` 3456，`manju-system` 5001。
请先在根目录复制 `.env.example` 为 `.env` 并填写 `DEEPSEEK_API_KEY`，Docker Compose 会自动读取。

如果 Docker 无法启动，仍可本地运行：

```bash
uv sync --all-packages
uv run --project apps/desktop-agent python webui.py
cd apps/autonomous-job-agent && npm install && npm run dev
```

## 项目列表

| 项目 | 路径 | 技术栈 | 状态 | 说明 |
| --- | --- | --- | --- | --- |
| 求职助手 | apps/autonomous-job-agent | Node/TypeScript + Python helper | 可运行 | BOSS直聘搜索、筛选、投递自动化 |
| 抖音桌面 Agent | apps/desktop-agent | Python | MVP | DeepSeek + TTS + 视频生成 + Douyin |
| Manju 内容生产系统 | apps/manju-system | Python | 半成品 | 内容生产、视觉质检、视频生成 |
| Manga Editor | apps/manga-editor-desu | Node/TypeScript | 子模块 | new-sankaku/manga-editor-desu |
| AI Agent Skills | docs/skills/ai-agent-skills | Markdown | 学习记录 | 项目经验与技能笔记 |

## 目录结构

```text
codex/
├── .devcontainer/
├── .github/workflows/ci.yml
├── apps/
│   ├── autonomous-job-agent/   # Node/TypeScript + Python helper
│   ├── desktop-agent/          # Python
│   ├── manju-system/           # Python
│   └── manga-editor-desu/      # Node/TypeScript (submodule)
├── packages/
├── docs/
│   ├── ARCHITECTURE.md
│   ├── ROADMAP.md
│   └── skills/ai-agent-skills/
├── pyproject.toml
├── uv.lock
├── CONTRIBUTING.md
├── LICENSE
├── PROJECT_STATUS.md
├── README.md
└── SECURITY.md
```

## 开发工具

- uv：依赖和虚拟环境
- Ruff：格式化和 lint
- pre-commit：提交前检查
- pytest：测试
- GitHub Actions：CI

## 工程规范

- 可执行应用放在 `apps/`
- 共享公共库放在 `packages/`
- 只提交源码，不提交 `.venv`、node_modules、模型、数据、exe、日志、密钥
- 每个应用维护自己的 README、PROJECT_STATUS、.env.example
- 提交格式：`feat: ...` / `fix: ...` / `docs: ...` / `chore: ...` / `test: ...`

## Git

- 远端：https://github.com/zly251/codex
- 默认分支：main

## License

MIT License，见 [LICENSE](LICENSE)。
