# Codex AI Engineering Workspace

![CI](https://github.com/zly251/codex/actions/workflows/ci.yml/badge.svg)
![License](https://img.shields.io/github/license/zly251/codex)

个人 AI 工程实验仓库。

用于管理基于 Codex、DeepSeek、Agent、ComfyUI 等技术栈的 AI 自动化开发项目，包括模型配置、Agent 工作流、提示词工程、自动化脚本以及实验记录。

## 项目列表

| 项目 | 路径 | 状态 | 说明 |
| --- | --- | --- | --- |
| 求职助手 | projects/autonomous-job-agent | 可运行 | BOSS直聘搜索、筛选、投递自动化 |
| 抖音桌面 Agent | projects/desktop-agent | MVP | DeepSeek + TTS + 视频生成 + Douyin |
| Manju 内容生产系统 | projects/manju-system | 半成品 | 内容生产、视觉质检、视频生成 |
| Manga Editor | projects/manga-editor-desu | 子模块 | new-sankaku/manga-editor-desu |
| AI Agent Skills | projects/ai-agent-skills | 学习记录 | 项目经验与技能笔记 |
| DeepSeek Monitor | projects/deepseek-monitor-windows | 待补源码 | 目录骨架已建 |

## 目录结构

```text
codex/
├── .github/workflows/ci.yml
├── docs/
│   ├── ARCHITECTURE.md
│   └── ROADMAP.md
├── projects/
│   ├── autonomous-job-agent/
│   ├── desktop-agent/
│   ├── manju-system/
│   ├── manga-editor-desu/
│   └── ai-agent-skills/
├── CONTRIBUTING.md
├── LICENSE
├── PROJECT_STATUS.md
├── README.md
└── SECURITY.md
```

## 快速开始

```powershell
git clone --recurse-submodules https://github.com/zly251/codex.git
cd codex
git submodule update --init --recursive
```

各项目运行方式见 `projects/<项目>/README.md`。

## 工程规范

- 只提交源码，不提交 venv、node_modules、模型、数据、exe、日志、密钥
- 每个项目维护自己的 README、PROJECT_STATUS、.env.example
- 提交格式：`feat: ...` / `fix: ...` / `docs: ...` / `chore: ...` / `test: ...`

## Git

- 远端：https://github.com/zly251/codex
- 默认分支：main
- 本地工作区：D:\codex

```powershell
cd D:\codex
git add .
git commit -m "说明"
git push
```

## License

MIT License，见 [LICENSE](LICENSE)。
