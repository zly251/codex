# Codex 工作区仓库 交接文档

## 仓库

- 远端：https://github.com/zly251/codex
- 本地工作区：D:\codex
- 结构：`projects/<项目名>`，每个子目录一个项目

## 已包含项目

| 项目 | 本地来源 |
| --- | --- |
| autonomous-job-agent | E:\autonomous-job-agent（运行目录） |
| desktop-agent | D:\desktop-agent |
| manju-system | E:\AIProjects\manju-system |
| manga-editor-desu | git 子模块：https://github.com/new-sankaku/manga-editor-desu.git |
| ai-agent-skills | E:\ai-agent\skills |

## 日常提交

```powershell
cd D:\codex
git submodule update --init --recursive
git add .
git commit -m "说明"
git push
```

## 求职助手同步

`E:\autonomous-job-agent` 是实际运行目录，修改后同步到仓库再提交：

```powershell
cd D:\codex
robocopy E:\autonomous-job-agent projects\autonomous-job-agent /E /XD node_modules dist portable data .edge-profile .edge-profile-2 get_jobs temp tmp /XF *.log .env
git add projects/autonomous-job-agent
git commit -m "说明"
git push
```

## 待整理

- DeepSeek Monitor Windows：目录骨架已建，源码待补
- ComfyUI：位于 E:\Comfy-Desktop，工作流待整理后纳入
