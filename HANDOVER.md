# 求职助手 交接文档

更新时间：2026-08-06

## 给下一个 Codex 对话的最短上下文

- 项目源码：当前仓库根目录
- 运行中：`dist\求职助手.exe` 或桌面 `求职助手.exe`，服务 `http://127.0.0.1:3456`
- Git 远端：`https://github.com/zly251/codex.git`
- Git 分支：`autonomous-job-agent`，不要覆盖远端 `main`
- 已推送：`06e6f8c`（清理）、`a378bec`（debug 清理）、`4d4d355`（平台抽象+跨平台）
- 当前登录态：Cookie 已备份；失效时自动打开 BOSS 扫码页
- 仓库状态：打招呼、简历附件投递、自动回复、去重、并发锁、发送成功判定等功能已开发、打包并验证
- 仓库内不写本机盘符和用户绝对路径；需要本机路径时使用环境变量或相对路径

## 项目用途

本地运行的自动求职代理。当前默认平台是 BOSS 直聘，负责职位抓取、筛选、评分、简历匹配、投递打招呼和反馈统计。

## 架构

- `src/platforms/index.js`：平台注册表，默认 `JOB_PLATFORM=boss`
- `src/platforms/boss.js`：BOSS 直聘 adapter
- `src/routes.mjs`：HTTP API 和投递流程，通过 `platform.createScraper()/createBot()` 解耦
- `src/edgeLauncher.js`：Windows/macOS/Linux 浏览器（Edge/Chrome/Chromium）发现与启动
- `src/browser/browserManager.js`：浏览器连接管理，`ensureEdge()` 统一启动+attach
- `src/scrapers/bossApi.js`、`src/chatApply.js`、`src/scoring.js`：核心业务
- `packaging/entry.cjs`、`packaging/setup-sea.cjs`：SEA exe 启动器
- `server.mjs`、`web/index.html`：本地控制台

> 浏览器链路已统一为 Edge/Chrome（CDP 9222），由服务端 `/api/boss/launch` 自动启动。launcher.ps1 只负责起服务、触发 launch、打开控制台。

## 数据位置

- 运行数据：`portable/`
- 登录配置：`.edge-profile/`，备用 `.edge-profile-2/`
- Cookie 备份：`portable/data/boss-cookies.json`
- 用户档案：`portable/data/profile.json`
- 数据库：`portable/data/job-agent.db`，旧临时库首次启动会自动迁移

## 常用命令

开发运行：

```bash
cd 项目目录
npm install
npx tsx server.mjs
```

访问 `http://127.0.0.1:3456`。浏览器由服务端自动启动（`/api/boss/launch`），无需手动开 Edge。

Git 操作：

```powershell
git status
git add .
git commit -m "说明"
git push origin HEAD:autonomous-job-agent
```

以后改完源码（含 `.env`），执行 `npm run build:exe` 即可完整重打：脚本会自动完成 esbuild 打包（`sea-entry.cjs` / `sea-server.cjs` / `sea-worker.cjs`，worker 产物自动生成）、SEA blob、postject 注入、GUI 子系统修复并断言、图标与版本信息写入，并自动替换当前用户桌面的 `求职助手.exe`，无需再手动跑 esbuild / postject / rcedit。

> ⚠️ exe 内嵌 `.env`（环境变量配置随构建写入 exe），请勿将 exe 外传；修改 `.env` 后必须重新执行 `npm run build:exe` 才会生效。

## 关键改动与验证

- 登录态：固定复用 `.edge-profile`，Cookie 自动备份/恢复，未登录自动打开扫码页。
- 稳定性：单实例顶替、看护不自杀式重启、空页 reload、失败保留页面、子进程隐藏窗口。
- 页面管理：本地控制台通过 CDP 复用同一标签页，BOSS 只保留一个标签页，后台同步/搜索不再反复抢焦点。
- 去重：启动时合并同一职位的重复投递记录，并建立 `Application(jobId)` 唯一索引。
- 统一路径：新增 `src/paths.js`，profile/cookie/chat/resume/db 统一落到 `portable`，SEA 打包显式设置 `JOB_AGENT_DATA_DIR`。
- 跳过已投递：投递前按 `Application(jobId)` 过滤，全部投递完自动实时搜索新职位，UI 可开关并显示跳过数量。
- OCR：默认使用 `portable/tessdata`，根据模型是否为 gzip 自动选择加载方式。
- 简历编辑：新增“简历编辑”板块，可维护基本信息、工作/项目/教育经历，支持导出 PDF 和 Word。
- 前端设计：按 frontend-design 方法重做 Web 控制台，采用深青/冷灰绿配色、投递状态轨道和明确动作按钮，支持移动端、键盘焦点与 reduced motion。
- 打招呼优化：投递前自动输入自定义打招呼语，发送按钮支持按文字兜底定位，复核增加输入框清空和聊天状态变化判断。
- 反馈同步：新增 `/api/boss/sync-feedback`，聊天监控每次扫描后同步，Web 控制台也提供手动按钮。
- 简历投递：附件投递与发送成功判定已补全，简历已发送状态按强特征识别，避免误判。
- 自动回复：新增聊天回复执行、发送成功复核和代际校验，防止旧任务覆盖新会话状态。
- 简历截图：BOSS 未回复前不能发附件时，改为生成简历截图后直传 BOSS 图片接口，再调用 ImageBtn `sendImageMsg` 发出；已真机验证“打招呼后自动发简历截图”。
- 打包流程：`npm run build:exe` 一键完整重打（自动生成 tesseract worker 产物 `dist/sea-worker.cjs`、PE subsystem 断言），产物在 `dist\求职助手.exe` 并自动复制到当前用户桌面；exe 图标已改为与托盘一致的“求”字蓝底圆形图标。exe 内嵌 `.env`，勿外传。
- 平台抽象：路由不再直接依赖 BOSS，换平台只需实现 adapter 并设置 `JOB_PLATFORM`。
- 跨平台：浏览器发现、进程清理、端口检查、打开 URL 均按平台实现。
- 清理：所有历史 debug/test/临时脚本已从 git 和本地删除，`.gitignore` 已补规则。

## 待办/风险

- 只实现了 BOSS adapter，其他平台尚未实现。
- BOSS 页面结构或风控变化时，优先看 `portable/data/watchdog.log` 和控制台日志。
- 不提交 `.env`、`node_modules/`、`portable/`、`dist/`、`.edge-profile/`、临时脚本。
- 不要提交本机绝对路径、用户名、盘符 ACL 或本机专属配置。

## 已修复（2026-08-11）

- 浏览器链路统一为 Edge/Chrome（CDP 9222）：`routes.mjs` 的 `ensureEdgeLaunched` 改名为 `ensureBrowserLaunched` 并真正启动浏览器；`browserManager` 新增 `ensureEdge()`；`entry.cjs` 的 `launchEdge()` 改为真 Edge 启动（原为 Firefox）；`launcher.ps1` 瘦身为只起服务+触发 launch。
- 控制台未连接时状态提示显示 `lastError`，连接失败原因人话化。
- PowerShell 脚本统一 UTF-8 BOM + CRLF（Windows PowerShell 5.1 解析中文必需）。

## 下次接手建议

1. 先读本文件和 `README.md`。
2. 再读 `src/platforms/boss.js`，理解 adapter 接口。
3. 如需新平台，复制 boss adapter 模板，注册到 `src/platforms/index.js`。
4. 改动后用 `git status` 确认不包含临时文件，再提交推送。
