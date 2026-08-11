# 求职助手（autonomous-job-agent）

本地自动求职代理，默认平台 BOSS 直聘：职位抓取、评分、投递打招呼、简历截图、聊天监控、反馈统计。

## 技术栈与结构

- Node.js 18+（ESM）、puppeteer-core（CDP）、tesseract.js（OCR）、node:sqlite、原生 http + 单页 Web UI
- `src/platforms/`：平台适配层（boss.js），新增平台实现 adapter 后在 index.js 注册
- `src/routes.mjs`：HTTP API 与投递流程
- `src/browser/browserManager.js`：浏览器管理，`ensureEdge()` 统一启动+attach
- `src/edgeLauncher.js`：浏览器发现与启动（Edge/Chrome，CDP 9222）
- `packaging/entry.cjs` + `setup-sea.cjs`：SEA exe 启动器
- `server.mjs`：Web 服务入口；`web/index.html`：控制台

## 常用命令

```bash
npm install
npx tsx server.mjs        # 开发运行，http://127.0.0.1:3456
npm run build:exe         # 重打桌面 exe（自动复制到桌面，改源码后必须重打才生效）
```

浏览器由服务端自动启动（/api/boss/launch），独立 profile，不影响日常浏览器。

## Git 管理规则（借鉴 Codex 规范）

- 不要频繁提交；以下情况才提交：功能完成 / 阶段测试通过 / 形成稳定版本
- 提交前必须 `git status` 检查
- 禁止提交：模型文件、API Key、缓存、临时文件、日志
- Commit 格式：`类型: 内容`，如 `feat: add video generation pipeline`、`fix: repair api connection`
- 常用操作（git 分离仓库）：
  ```bash
  git --git-dir=/d/autonomous-job-agent-repo/.git --work-tree=/e/autonomous-job-agent status
  git --git-dir=/d/autonomous-job-agent-repo/.git --work-tree=/e/autonomous-job-agent add <文件>
  git --git-dir=/d/autonomous-job-agent-repo/.git --work-tree=/e/autonomous-job-agent commit -m "类型: 内容"
  git --git-dir=/d/autonomous-job-agent-repo/.git --work-tree=/e/autonomous-job-agent push origin HEAD:autonomous-job-agent
  ```

## 关键事实（坑）

- exe 内嵌 .env，勿外传；改 .env 后必须重新 build:exe
- 数据目录：`C:\Users\asus\.autonomous-job-agent\portable`（.env 里 JOB_AGENT_DATA_DIR 指向）；开发模式同样读这里，两边数据一致
- git 元数据在 D 盘，工作区在 E 盘：所有 git 命令需 `--git-dir=/d/autonomous-job-agent-repo/.git --work-tree=/e/autonomous-job-agent`
- 远端 github.com/zly251/codex，分支 autonomous-job-agent（不覆盖 main）
- 提交前 git status 检查，不提交 .env、node_modules、portable、dist、.edge-profile、临时脚本
- 浏览器连接失败时看 `portable/data/watchdog.log` 和控制台日志
- PowerShell 脚本必须 UTF-8 BOM + CRLF（Windows PowerShell 5.1 中文解析）
