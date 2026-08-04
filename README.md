# 求职助手

本地运行的自动求职代理。当前默认平台是 BOSS 直聘，负责职位抓取、筛选、评分、简历匹配、投递和反馈统计。

## 功能

- 自动连接本机 Edge / Chrome / Chromium（CDP 9222），固定复用登录配置
- 按筛选条件搜索、抓取并解析平台职位
- 按技能、经验、学历计算岗位匹配度
- 自动生成 `AUTO_APPLY / REVIEW / IGNORE` 投递决策
- 自动选择并关联简历，历史投递记录自动补挂简历
- 批量投递打招呼，单职位手动沟通
- 聊天会话监控，支持查看和发送消息
- Cookie 自动备份与恢复
- 看护进程在浏览器异常后自动重试拉起
- 单任务并发锁，重复投递会被拦截
- 重复启动 exe 会自动顶掉旧实例，不产生双看护进程
- 投递失败时保留最后一个平台页面，不再关闭浏览器
- 反馈漏斗统计（待处理/已查看/已回复/面试/Offer）与策略建议
- 本地 Web 控制台，默认 http://localhost:3456

## 平台抽象

平台相关逻辑集中在 `src/platforms/`：

- `src/platforms/index.js`：平台注册表和默认平台
- `src/platforms/boss.js`：BOSS 直聘适配器

默认平台通过环境变量控制：

```bash
JOB_PLATFORM=boss
```

新平台只需要实现同一个 adapter 接口（页面定位、登录判断、Cookie 备份、抓取器、投递机器人），然后在 `src/platforms/index.js` 注册。切换平台时修改 `JOB_PLATFORM` 或 `DEFAULT_PLATFORM` 一行即可。

## 跨平台

- Windows：支持 Edge、Chrome、Chromium，桌面 exe 使用 Node SEA 打包
- macOS / Linux：直接用 Node 运行，自动发现 Chrome / Chromium / Edge
- 可用 `BROWSER_PATH` 显式指定浏览器可执行文件
- 浏览器发现、进程清理、端口检查、打开 URL 均按平台实现，不再依赖 PowerShell 作为唯一路径

## 技术栈

- Node.js 18+（ESM）
- puppeteer-core（CDP 控制浏览器）
- tesseract.js（图片 OCR）
- SQLite（`node:sqlite`）
- 原生 http 服务 + 单页 Web UI
- Node SEA 单文件 exe 打包（Windows）

## 环境要求

- Windows 11 / macOS / Linux
- Microsoft Edge、Google Chrome 或 Chromium
- Node.js 18+
- 无需 GPU

## 启动

安装依赖：

```bash
npm install
```

开发模式运行：

```bash
npx tsx server.mjs
```

浏览器打开 http://localhost:3456

Windows 也可以使用 `launcher.ps1` 或桌面 exe。首次使用在自动打开的页面扫码登录，Cookie 会自动备份。

## 数据位置

- 运行数据：`portable/`
- 登录配置：`.edge-profile/`，备用 `.edge-profile-2/`
- 用户档案：`data/profile.json`
- Cookie 备份：`portable/data/boss-cookies.json`
- 本地数据库：`%TEMP%\autonomous-job-agent\dev.db`

## 打包为 Windows exe

```powershell
npx esbuild packaging/entry.cjs --bundle --platform=node --format=cjs --outfile=dist/sea-entry.cjs
npx esbuild server.mjs --bundle --platform=node --format=cjs --outfile=dist/sea-server.cjs
node --experimental-sea-config sea-config.json
Copy-Item E:\node.exe dist\求职助手.exe
postject dist\求职助手.exe NODE_SEA_BLOB dist\sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
```

postject 后会损坏签名，需要把 PE subsystem 从 3 改为 2（GUI）。

macOS / Linux 当前使用 Node 直接运行，暂不生成单文件安装包。

## 目录结构

```text
src/
  platforms/       平台适配层
  scrapers/        平台抓取器
  browser/         浏览器连接与 CDP 管理
  db/              数据访问层
  routes.mjs       HTTP API
  scoring.js       评分与决策
  chatApply.js     投递机器人
web/index.html     本地控制台
packaging/         SEA 打包与启动器
```

## Git

- 远端：https://github.com/zly251/codex
- Git 元数据：`D:\autonomous-job-agent-repo\.git`
- 工作区：`E:\autonomous-job-agent`
- 项目分支：`autonomous-job-agent`（远端 `main` 已被其他工作区占用，不覆盖）
- E 盘 `.git` 被 ACL 拒绝写入，提交时必须指定 `--git-dir` 和 `--work-tree`

```powershell
git --git-dir=D:\autonomous-job-agent-repo\.git --work-tree=E:\autonomous-job-agent status
git --git-dir=D:\autonomous-job-agent-repo\.git --work-tree=E:\autonomous-job-agent add .
git --git-dir=D:\autonomous-job-agent-repo\.git --work-tree=E:\autonomous-job-agent commit -m "说明"
git --git-dir=D:\autonomous-job-agent-repo\.git push
```

提交前检查 `git status`，只提交应用源码、配置和文档，不提交诊断脚本、临时文件、日志、模型和 API Key。

## License

MIT License，见 [LICENSE](LICENSE)。
