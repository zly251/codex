# Codex AI Engineering Workspace

![CI](https://github.com/zly251/codex/actions/workflows/ci.yml/badge.svg)
![License](https://img.shields.io/github/license/zly251/codex)

基于 uv 的 Python Mono-Repo Workspace，用于管理 Codex、DeepSeek、Agent、ComfyUI 等 AI 自动化项目。

## 3 条命令

```bash
git clone --recurse-submodules https://github.com/zly251/codex.git codex
cd codex && uv sync --all-packages
uv run --project apps/desktop-agent python main.py
```

Manju 内容生产系统：

```bash
uv run --project apps/manju-system python run_final.py
```

Node 应用（求职助手）：

```bash
cd apps/autonomous-job-agent && npm install && npx tsx server.mjs
```

## 项目列表

| 项目 | 路径 | 状态 | 说明 |
| --- | --- | --- | --- |
| 求职助手 | apps/autonomous-job-agent | 可运行 | Node，BOSS直聘搜索、筛选、投递自动化 |
| 抖音桌面 Agent | apps/desktop-agent | MVP | Python，DeepSeek + TTS + 视频生成 + Douyin |
| Manju 内容生产系统 | apps/manju-system | 半成品 | Python，内容生产、视觉质检、视频生成 |
| Manga Editor | apps/manga-editor-desu | 子模块 | new-sankaku/manga-editor-desu |
| AI Agent Skills | docs/skills/ai-agent-skills | 学习记录 | 项目经验与技能笔记 |

## 目录结构

```text
codex/
├── .devcontainer/
├── .github/workflows/ci.yml
├── apps/
│   ├── autonomous-job-agent/
│   ├── desktop-agent/
│   ├── manju-system/
│   └── manga-editor-desu/
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
