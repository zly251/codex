# 求职助手 交接文档

更新时间：2026-09-19（架构收尾轮 M1~M4 合流后）

## 给下一个会话的最短上下文

- 项目源码：当前仓库根目录（分离仓库，git 操作见下文）
- 运行：桌面 `求职助手.exe`（双击即用）或 `npm start`，服务 `http://127.0.0.1:3456`
- 数据根：`.env` 的 `JOB_AGENT_DATA_DIR=E:\autonomous-job-agent-data`（2026-09-19 起；C 盘旧目录改名保留 7 天回滚）
- 当前状态：抓取、距离分档、宿舍信号、评分决策、待确认队列、节奏投递（默认干跑）、聊天监控、简历导出全链路可用；`npm test` 791 断言全绿（313+199+102+70+107 五段）
- ⚠️ **真实打招呼开关**：`APPLY_DRY_RUN` 默认 `true`（只出节奏计划不触浏览器）。改为真实投递需 `.env` 显式 `APPLY_DRY_RUN=0`，属用户决策，勿代设

## 项目用途

本地运行的自动求职代理。当前默认平台是 BOSS 直聘，负责职位抓取、距离/宿舍分档、评分决策、待确认人工闸门、按日配额随机摊开的投递节奏、聊天监控与反馈统计。

## 架构（本轮新增/关键）

- `src/platforms/index.js` + `src/platforms/boss.js`：平台注册表与 BOSS adapter（`createScraper()/createBot()/findJobPage/isLoggedIn`）
- `src/distance.js`：**距离引擎**。家坐标（`JOB_AGENT_HOME_LAT/LNG` 可覆盖，默认椒江大润发 WGS84）；坐标→haversine 精确档，无坐标→区县中心近似（approx）；档位 CORE ≤5km / NEAR ≤15km / FAR >15km / UNKNOWN / OUT_OF_CITY。`DISTRICT_CENTERS` 为 Nominatim 构建期一次性硬编码（2026-09-19），GCJ02/WGS84 数百米偏差对档位划分可忽略，未做转换
- `src/enrich.js`：详情页增补（JD 正文/福利标签宿舍/可能坐标），page 契约可注入假对象
- `src/scoring.js`：五维权重 `BASE_WEIGHTS={skill:.5,experience:.15,education:.15,distance:.15,dormitory:.05}`；`decideJob(score, reviewThreshold, job)` 三参返回 `{decision,reason,tier,hasDormitory}`；规则叠加：OUT_OF_CITY→IGNORE；FAR 无宿舍→IGNORE；FAR 有宿舍→AUTO 门槛下调 10；UNKNOWN→封顶 REVIEW（**未 enrich 的数据永远不会自动投递**）；CORE→门槛下调 10
- `src/applyScheduler.js`：每日 150 配额、2~4h 窗口随机时间轴、30~90s 间隔、约每 20 单 5~15 分钟长休息、22:00 硬截断；`dryRunReport()` 输出审计时间轴
- `src/db/reviewQueue.js`：待确认队列表（自建，UNIQUE jobId）；enqueue 幂等；**approve 后才进下次投递集合**（findApproved 窥视 + 真进集才 markConsumed，防 dry-run/截断吞放行）
- `src/routes.mjs`：HTTP API。决策分桶真拦截（IGNORE 剔除、REVIEW 入队）；`POST /api/boss/enrich` 详情页批量增补（随机停顿、encryptJobId 防串写、maxMs 断点续跑）；`GET /api/review` + `POST /api/review/approve|reject`；搜索落库后自动距离回填
- `src/llmProvider.js`：provider 链 `localgateway(3010 qwen3.8-flash 免费)→zhipu→deepseek→template`（`.env` `LLM_PROVIDER=localgateway`）；网关不认 max_tokens，控长靠系统提示词（80 字）；PII 脱敏作用于全部消息；capability_guard 白名单拦截；面试/Offer 意图转人工。**AI 回复事实唯一来源=底细卡** `prompts/candidate-card.md`（WHITELIST 标记区=可无条件认领词；待用户签字）
- `src/chatApply.js`：聊天/打招呼门面（3260 行，`docs/05_MODULARIZATION_PLAN.md` 已给出拆分蓝图，尚未执行）
- `src/scrapers/bossApi.js`：列表卡整包存 `rawData`（chatApply L1347 的匹配依赖由此复活）、防御式坐标提取、卡片福利标签宿舍扫描
- `src/db/*`：`node:sqlite` 手写 CRUD；`initDb()` 内 `migrateJobDistanceColumns()` 幂等 ALTER 加 6 列（lng/lat/distanceKm/distanceTier/hasDormitory/dormitorySource）
- `web/index.html`：控制台含"待确认岗位"面板（放行/拒绝）
- `packaging/entry.cjs`、`scripts/build-exe.ps1`：SEA exe（`npm run build:exe` → `dist\求职助手.exe` 自动复制桌面）

## 常用命令

```bash
npm install
npm start          # 开发运行 http://127.0.0.1:3456
npm test           # 全部回归（四段，见 package.json）
npm run build:exe  # 重打桌面 exe
node scripts/enrich-jobs.mjs [--limit N] [--only-missing]  # 存量岗位距离回填（纯 DB）
```

Git 操作（分离仓库）：

```powershell
& "C:\Program Files\Git\bin\git.exe" --git-dir=D:\autonomous-job-agent-repo\.git --work-tree=E:\autonomous-job-agent <子命令>
```

远端 `https://github.com/zly251/codex.git`，本地 `main` 跟踪远端 `autonomous-job-agent`，不要覆盖远端 `main`。

## 数据位置

- 运行数据：`E:\autonomous-job-agent-data\`（`.edge-profile*/`、`data/profile.json`、`data/boss-cookies.json`、`data/job-agent.db`、日志）
- 开发模式无环境变量时回退：项目根 `portable/`
- 家坐标覆盖：`JOB_AGENT_HOME_LAT` / `JOB_AGENT_HOME_LNG`（见 `src/distance.js` 注释）

## 测试

`npm test` = test-multiagent-flow(313) + test-reply-salary(199) + test-m1-distance(102) + test-m2-scheduler(70) + test-m3-llm(107)。
规矩：**存量断言只增不减**；新模块测试独立成 `scripts/test-mX-*.mjs` 并追加进 package.json test 行；代理勿改 package.json，由主代理合并。

覆盖新增：距离三档/边界/脏区县文本、迁移幂等、updateEnrichment、决策规则链（UNKNOWN 封顶 REVIEW、FAR+宿舍入 AUTO）、配额/时间轴/22:00 截断、放行→投递端到端、dry-run 分桶。

## 待办/风险

- **M5 平台内核抽象未执行**：`docs/05_MODULARIZATION_PLAN.md` 蓝图已验收（8 步、每步 npm test 绿、re-export 垫片、chatApply.js 永为门面），改动前必读其"不可破坏清单"
- 底细卡 `prompts/candidate-card.md` 尚有〔待确认〕字段，用户签字前 AI 对这些字段一律不报具体值
- 详情页 enrich 需浏览器在环（登录态 Edge），批量首跑建议先 `limit=10` 试水
- BOSS 页面结构或风控变化时，优先看 `<数据根>/logs/` 与控制台日志
- 不提交 `.env`、`node_modules/`、`portable/`、`dist/`、`.edge-profile*/`、临时脚本；不提交本机绝对路径与密钥（`CLAUDE.md` 属已知例外）
- 踩坑：**PS5.1 `Get-Content` 读无 BOM UTF-8 中文会显示假 GBK 乱码**——判编码/查源文件用 `read` 工具或 node，别据此"修文件"
