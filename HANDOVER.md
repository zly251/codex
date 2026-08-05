# 求职助手 交接文档

更新时间：2026-08-05

## 给下一个 Codex 对话的最短上下文

- 项目源码：`E:\autonomous-job-agent`
- 运行中：桌面 `C:\Users\asus\Desktop\求职助手.exe`，服务 `http://127.0.0.1:3456`
- Git 远端：`https://github.com/zly251/codex.git`
- Git 分支：`autonomous-job-agent`，不要覆盖远端 `main`
- Git 元数据：`D:\autonomous-job-agent-repo\.git`
- Git 工作区：`E:\autonomous-job-agent`
- 已推送：`06e6f8c`（清理）、`a378bec`（debug 清理）、`4d4d355`（平台抽象+跨平台）
- 当前登录态：Cookie 已备份；失效时自动打开 BOSS 扫码页
- 仓库状态：反馈同步功能已开发、打包并验证
- E 盘删除权限已补：`LAPTOP-5M3QFS52\asus:(OI)(CI)(D,DC)`

## 项目用途

本地运行的自动求职代理。当前默认平台是 BOSS 直聘，负责职位抓取、筛选、评分、简历匹配、投递打招呼和反馈统计。

## 架构

- `src/platforms/index.js`：平台注册表，默认 `JOB_PLATFORM=boss`
- `src/platforms/boss.js`：BOSS 直聘 adapter
- `src/routes.mjs`：HTTP API 和投递流程，通过 `platform.createScraper()/createBot()` 解耦
- `src/edgeLauncher.js`：Windows/macOS/Linux 浏览器发现与启动
- `src/scrapers/bossApi.js`、`src/chatApply.js`、`src/scoring.js`：核心业务
- `packaging/entry.cjs`、`packaging/setup-sea.cjs`：SEA exe 启动器
- `server.mjs`、`web/index.html`：本地控制台

## 数据位置

- 运行数据：`portable/`
- 登录配置：`.edge-profile/`，备用 `.edge-profile-2/`
- Cookie 备份：`portable/data/boss-cookies.json`
- 用户档案：`portable/data/profile.json`
- 数据库：`portable/data/job-agent.db`，旧临时库首次启动会自动迁移

## 常用命令

开发运行：

```bash
cd /d E:\autonomous-job-agent
npm install
npx tsx server.mjs
```

访问 `http://127.0.0.1:3456`。

Git 操作：

```powershell
git --git-dir=D:\autonomous-job-agent-repo\.git --work-tree=E:\autonomous-job-agent status
git --git-dir=D:\autonomous-job-agent-repo\.git --work-tree=E:\autonomous-job-agent add .
git --git-dir=D:\autonomous-job-agent-repo\.git --work-tree=E:\autonomous-job-agent commit -m "说明"
git --git-dir=D:\autonomous-job-agent-repo\.git --work-tree=E:\autonomous-job-agent push origin HEAD:autonomous-job-agent
```

Windows exe 打包步骤见 `README.md`，当前桌面 exe 已是最新版。

## 关键改动与验证

- 登录态：固定复用 `.edge-profile`，Cookie 自动备份/恢复，未登录自动打开扫码页。
- 稳定性：单实例顶替、看护不自杀式重启、空页 reload、失败保留页面、子进程隐藏窗口。
- 页面管理：本地控制台通过 CDP 复用同一标签页，BOSS 只保留一个标签页，后台同步/搜索不再反复抢焦点。
- 去重：启动时合并同一职位的重复投递记录，并建立 `Application(jobId)` 唯一索引。
- 统一路径：新增 `src/paths.js`，profile/cookie/chat/resume/db 统一落到 `portable`，SEA 打包显式设置 `JOB_AGENT_DATA_DIR`。
- 跳过已投递：投递前按 `Application(jobId)` 过滤，全部投递完自动实时搜索新职位，UI 可开关并显示跳过数量。
- OCR：默认使用 `portable/tessdata`，根据模型是否为 gzip 自动选择加载方式。
- 简历编辑：新增“简历编辑”板块，可维护基本信息、工作/项目/教育经历，支持导出 PDF 和 Word。
- 反馈同步：新增 `/api/boss/sync-feedback`，聊天监控每次扫描后同步，Web 控制台也提供手动按钮。
- 平台抽象：路由不再直接依赖 BOSS，换平台只需实现 adapter 并设置 `JOB_PLATFORM`。
- 跨平台：浏览器发现、进程清理、端口检查、打开 URL 均按平台实现。
- 清理：所有历史 debug/test/临时脚本已从 git 和本地删除，`.gitignore` 已补规则。

## 待办/风险

- 只实现了 BOSS adapter，其他平台尚未实现。
- BOSS 页面结构或风控变化时，优先看 `portable/data/watchdog.log` 和控制台日志。
- 不提交 `.env`、`node_modules/`、`portable/`、`dist/`、`.edge-profile/`、临时脚本。
- E 盘 ACL 已修复，但不要随意修改系统级权限。

## 下次接手建议

1. 先读本文件和 `README.md`。
2. 再读 `src/platforms/boss.js`，理解 adapter 接口。
3. 如需新平台，复制 boss adapter 模板，注册到 `src/platforms/index.js`。
4. 改动后用 `git status` 确认不包含临时文件，再提交推送。
