# 求职助手 交接文档

更新时间：2026-08-16

## 给下一个 Codex 对话的最短上下文

- 项目源码：当前仓库根目录（本机路径见 `CLAUDE.md`）
- 运行中：`dist\求职助手.exe` 或桌面 `求职助手.exe`，服务 `http://127.0.0.1:3456`
- Git 远端：`https://github.com/zly251/codex.git`
- Git 分支：本地 `main` 跟踪远端 `autonomous-job-agent`，不要覆盖远端 `main`
- 当前状态：抓取、评分、打招呼、简历截图发送、聊天监控、反馈漏斗、简历编辑/导出全链路可用；`npm test` 全绿（313 + 199 断言）
- 重要修复：`.env` 中 `JOB_AGENT_DATA_DIR` 已修正为正确路径，避免 dev 模式落到 `C:Usersasus...` 错误路径

## 项目用途

本地运行的自动求职代理。当前默认平台是 BOSS 直聘，负责职位抓取、筛选、评分、简历匹配、投递打招呼和反馈统计。

## 架构

- `src/platforms/index.js`：平台注册表，默认 `JOB_PLATFORM=boss`
- `src/platforms/boss.js`：BOSS 直聘 adapter
- `src/routes.mjs`：HTTP API 和投递流程，通过 `platform.createScraper()/createBot()` 解耦
- `src/edgeLauncher.js`：Windows/macOS/Linux 浏览器（Edge/Chrome/Chromium）发现与启动
- `src/browser/browserManager.js`：浏览器连接管理，`ensureEdge()` 统一启动+attach
- `src/scrapers/bossApi.js`、`src/chatApply.js`、`src/scoring.js`、`src/salary.js`：核心业务
- `src/chatState.js`、`src/replyVerification.js`、`src/greeting.js`、`src/llmProvider.js`：聊天状态、发送验证、打招呼与 LLM 回复
- `src/utils/resumeParser.js`：简历文本提取（PDF/DOCX/图片 OCR）与结构化解析
- `src/resumeExport.js`：简历编辑器、PDF/Word 导出、简历截图
- `packaging/entry.cjs`、`packaging/setup-sea.cjs`：SEA exe 启动器
- `server.mjs`、`web/index.html`：本地控制台

## 常用命令

```bash
npm install
npm start          # 开发运行 http://127.0.0.1:3456
npm test           # 单元测试
npm run build:exe  # 重打桌面 exe（自动复制到桌面）
```

Git 操作：本项目是分离仓库，`--git-dir` / `--work-tree` 路径见 `CLAUDE.md`。本机若存在 `C:\Windows\system32\git` 0 字节占位文件，直接 `git` 会失败，请使用完整 Git 路径（例如 `C:\Program Files\Git\cmd\git.exe`）。

## 数据位置

- 运行数据：由 `.env` 的 `JOB_AGENT_DATA_DIR` 指定；exe 内嵌 `.env`
- 开发模式无环境变量时回退：项目根目录 `portable/`
- 登录配置：`.edge-profile/`、`.edge-profile-2/`（相对数据根目录）
- 用户档案：`data/profile.json`
- Cookie 备份：`data/boss-cookies.json`
- 数据库：`data/job-agent.db`

## 已实现功能

- 自动连接/启动 Edge/Chrome（CDP 9222），固定复用登录配置，Cookie 自动备份/恢复
- 按关键词/城市/页数搜索并抓取 BOSS 职位，写入本地 SQLite
- 按技能、经验、学历、期望薪资计算匹配度与薪资排序
- 自动生成 `AUTO_APPLY / REVIEW / IGNORE` 决策
- 自动选择简历、批量投递打招呼、跳过已投递、实时补充搜索
- 打招呼后自动发送简历截图，规避 HR 未回复时不能发附件的限制
- 聊天监控、自动回复、手动回复、发送简历、发送成功复核与代际保护
- BOSS 聊天反馈自动同步（已回复/面试/Offer/不合适）
- 结构化简历编辑、上传解析（PDF/DOCX/图片 OCR）、导出 PDF/Word
- 本地 Web 控制台（深青/冷灰绿求职作战台），支持移动端与键盘焦点
- 单实例顶替、看护进程、失败保留页面、多平台浏览器发现

## 测试

```bash
npm test
```

覆盖：打招呼占位符、聊天状态去重、发送成功判定、简历附件/弹窗强特征、简历截图发送流程、致命错误判定、薪资解析、LLM 回复隐私脱敏、能力白名单、手动意图识别等。

## 待办/风险

- 只实现了 BOSS adapter，其他平台尚未实现
- BOSS 页面结构或风控变化时，优先看 `data/watchdog.log` 和控制台日志
- 不提交 `.env`、`node_modules/`、`portable/`、`dist/`、`.edge-profile*/`、临时脚本
- 不要提交本机绝对路径、用户名、盘符 ACL 或本机专属配置（`CLAUDE.md` 属已知例外，按需维护）
