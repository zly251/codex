# 抖音桌面 Agent

基于 DeepSeek API 的桌面自动化 Agent MVP，支持网页搜索、TTS、视频生成和 Douyin 上传。

## 功能

- DeepSeek 对话与任务解析
- 网页搜索
- TTS 与视频生成
- Douyin 上传
- tkinter 桌面界面和 Web UI

## 运行

```powershell
cd D:\codex
uv run --project apps/desktop-agent python main.py
```

Web UI：

```powershell
cd D:\codex
uv run --project apps/desktop-agent python webui.py
```

## 环境变量

复制 `.env.example` 为 `.env`，填入：

```text
DEEPSEEK_API_KEY=
```

## 状态

MVP，可运行，后续完善 TTS 产物流程和自动上传。
