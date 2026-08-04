# Architecture

## Workspace

- 单仓库多项目，`apps/<应用>` 为可执行应用边界
- `packages/` 放置共享公共库
- 根目录只放工程规范和文档
- 外部项目用 git 子模块
- Python 应用由 uv workspace 统一管理

## 调用关系

```mermaid
sequenceDiagram
    participant Codex as Codex / Desktop Agent
    participant Desktop as desktop-agent (MCP Server / Flask API)
    participant Job as autonomous-job-agent
    participant Manju as manju-system
    participant Edge as Edge / BOSS直聘
    participant AI as ComfyUI / Ollama / DeepSeek

    Codex->>Desktop: MCP / 本地 Agent 指令
    Desktop->>Job: HTTP 请求（端口 3456）
    Job->>Edge: CDP 自动化
    Edge-->>Job: 页面状态与投递反馈
    Job-->>Desktop: 投递与漏斗结果
    Desktop->>Manju: HTTP 请求（端口 5001）
    Manju->>AI: 图像 / 视频 / 质检调用
    AI-->>Manju: 生成与质检结果
    Manju-->>Desktop: 生产状态与质检结果
```

当前实现中，`desktop-agent` 的 Flask API 提供 `/api/run`、`/api/stream/<task_id>` 等入口，`autonomous-job-agent` 与 `manju-system` 分别通过本地端口独立提供服务；上图为仓库内目标集成边界。

## 项目

### autonomous-job-agent

- Node.js + ESM
- puppeteer-core 控制 Edge
- server.mjs + src/routes.mjs 提供本地 Web UI
- src/scrapers 抓取 BOSS 直聘
- src/scoring.js 岗位匹配评分
- SQLite 本地存储

### desktop-agent

- Python + DeepSeek API
- 搜索、TTS、视频生成、Douyin 上传
- tkinter desktop_app.py + webui.py

### manju-system

- Python 内容生产管线
- ComfyUI 图像生成
- DeepSeek 内容脚本
- Ollama 视觉质检

### ai-agent-skills

- Markdown 学习与项目记录
- 位于 docs/skills/ai-agent-skills
