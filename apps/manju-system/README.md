# manju-system

抖音 + 红果短剧 AI 漫剧生产系统（M0 最小闭环）。

## 运行

```powershell
cd D:\codex
uv run --project apps/manju-system python run_pipeline.py "一个穷女孩发现自己是豪门继承人"
```

需要 `DEEPSEEK_API_KEY` 环境变量或 `~/.douyin_agent_key` 文件。
需要 ComfyUI 运行在 `http://127.0.0.1:8188`，启动脚本：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start_comfyui.ps1
```

## 中间产物

- `data/runs/{run_id}/script.json`：剧本
- `data/runs/{run_id}/storyboard.json`：分镜
- `data/runs/{run_id}/prompts.json`：图片提示词
- `data/runs/{run_id}/render_result.json`：渲染结果
- `output/images/`：生成图片
