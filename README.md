# Codex AI Engineering Workspace

个人 AI 工程实验仓库。

用于管理基于 Codex、DeepSeek、Agent、ComfyUI 等技术栈的 AI 自动化开发项目，包括模型配置、Agent 工作流、提示词工程、自动化脚本以及实验记录。

## 项目列表

| 项目 | 路径 | 状态 |
| --- | --- | --- |
| 求职助手 | projects/autonomous-job-agent | 可运行，BOSS直聘自动化 |
| 抖音桌面 Agent | projects/desktop-agent | MVP，DeepSeek + TTS + 视频生成 + Douyin |
| Manju 内容生产系统 | projects/manju-system | 半成品 |
| Manga Editor | projects/manga-editor-desu | git 子模块（new-sankaku） |
| AI Agent Skills | projects/ai-agent-skills | 学习记录 |
| DeepSeek Monitor | projects/deepseek-monitor-windows | 半成品，待补源码 |

## 结构

- `projects/` 每个子目录一个项目
- 只提交源码，不提交 venv、node_modules、模型、数据、exe、日志
- `projects/manga-editor-desu` 是 git 子模块，克隆后执行 `git submodule update --init`
- 根目录 LICENSE 为 MIT

## Git

- 远端：https://github.com/zly251/codex
- 本地工作区：D:\codex

```powershell
cd D:\codex
git add .
git commit -m "说明"
git push
```
