# 求职助手目标架构 v1 —— 扩展优先 · 契约先行

- 文档：`docs/06_TARGET_ARCHITECTURE.md`　|　起草：2026-09-30　|　状态：**待用户确认**
- 上游依据：`01_PRD.md`、`03_DEV_PLAN.md`、`05_MODULARIZATION_PLAN.md`（M5 拆分蓝图，已验收未执行）
- 本轮实测基线：`npm test` 11 套 exit 0；工作区含 V0 未提交改动（见 §1.2）

---

## 0. 一句话目标与非目标

**目标**：让用户在**不消耗本人注意力**的前提下，获得一份"今天哪些岗位值得聊、怎么聊、这个 offer 值多少钱"的清单与话术；所有**对外动作**（打招呼、发消息、投递）保留在人工确认之后。

**非目标（明确不做）**：
- 不做多用户 / SaaS / 支付 / 权限（PRD 已定）。
- 不做"完全无人值守自动投递"——该结论已有实证，见 §1.3。
- 不在本轮重构存量代码（理由见 §3.4）。

---

## 1. 现状体检（全部为本轮实测，非回忆）

### 1.1 数据现状（`E:\autonomous-job-agent-data\data\job-agent.db`，2026-09-30 查询）

| 指标 | 数值 |
|---|---|
| Job 总数 | 187（全部 `status=active`） |
| Application 总数 | 31（`pending` 28 + `replied` 3） |
| `interview` / `offer` | **0 / 0** |
| 2026-09-23 之后新增 Application | **0** |
| 最后一次抓取 `scrapedAt` | 2026-09-25 02:30 |
| 桌面 exe 构建时间 | 2026-09-21 21:17（**不含扩展 V0 全部工作**） |
| 127.0.0.1:3456 监听 | 无（服务未运行） |

### 1.2 代码现状

两套**并存**的链路活在同一个进程里：

| | 旧链（puppeteer / CDP 9222） | 新链（Chrome MV3 扩展，只读） |
|---|---|---|
| 入口 | `server.mjs` → `src/routes.mjs` → `browserManager` → `chatApply.js`(2932 行) | `extension/content.js` → `POST /api/extension/look` → `src/extensionLook.mjs` + `src/value.mjs` |
| 动作 | 写 DOM：自动打招呼 / 投递 / 发简历 / 自动回复 | **零 DOM 写入**，只读 `innerText` |
| 状态 | 2026-09-25 后无动作 | 代码就绪，**真机验收未做** |
| 风险 | 反爬约 16 个详情页即掐；`HARD_BLOCK_HINTS` 三词触发即熔断 | 只读，无封号面 |

未提交（真仓 `D:\autonomous-job-agent-repo`，worktree 指 E 盘）：
`M package.json`、`M server.mjs`、`?? extension/`、`?? src/value.mjs`、`?? src/extensionLook.mjs`、
`?? scripts/test-v0-value.mjs`、`?? scripts/test-v0-extension-look.mjs`、
`?? .ext-last.json`、`?? .ext-look-debug.txt`（794 KB，**未被 .gitignore 覆盖**）。

测试：11 套 exit 0，其中 `test-v0-value` 36 passed、`test-v0-extension-look` 46 passed。

### 1.3 三个结构性问题（本架构要解决的正是这三个）

**问题一：主链路选错了。** 31 次自动打招呼 → 3 回复 → 0 面试，且导致 BOSS 账号被硬封（`ea3bbef` 熔断）。旧链投入产出比已被证伪，但代码量占绝对多数（`chatApply.js` 2932 行 + 浏览器/调度/巡航 1000+ 行），新人接手的第一印象仍是"一个自动投递机器人"。而用户当前处境（`2 - Notes\Projects\GetJobs\岗位池.md`）是**过渡岗、不挑**——这恰恰是新链"给建议、人决定"最适用的场景。

**问题二：不可破坏的不变量只存在于测试断言和注释里。** 金额必须代码算、LLM 不参与、14 词技能白名单、送达证据判据、UNKNOWN 永不自动投、零 DOM 写入——这些是项目最贵的资产（每条都是一次线上事故换来的），但没有任何一个命令能"跑一遍就确认它们还在"。

**问题三：契约是隐式的。** 40+ 个 HTTP 端点散在 `server.mjs`（约 28 条 if 链）和 `src/routes.mjs`（约 9 条）两处；`extension/panel.js` 与 `web/index.html`(3586 行单文件) 各自手写了响应结构的假设；配置有三处真源（`.env` / 扩展 `storage.local` / 控制台）。**这正是"多轮重复推进、越改越乱"的机制性原因**——没有契约，子代理/多人协作必然互相踩。

---

## 2. 架构三原则

1. **契约先行，契约冻结。** 先把不变量和接口机器化，再动业务代码。契约层在并行期**只读**，任何改动走 Lead。
2. **叶子不碰叶子。** 六个模块各自独占目录，只能 import `src/core/**` 和自己目录；跨模块需求走契约。这条规则是"6 个子代理并行不撞车"的**充分条件**。
3. **对外动作默认关闭。** 系统只产出"建议"，任何"做"的动作都需要显式开关 + 证据回执。旧链保持围栏状态（§6）。

---

## 3. 分层与依赖规则

### 3.1 四层

```
L0 不变量守卫   src/core/guards/       —— 把事故教训变成可执行断言（npm run guards）
L1 契约层       src/core/contracts/    —— adapter 20 钩子、HTTP 端点表、JSON 结构、配置键
L2 业务模块     src/modules/<name>/    —— 六个叶子，互不 import（六个子代理的战场）
L3 冻结旧链     src/legacy-*           —— 不删、不跑、加围栏（见 §6）
```

依赖方向**严格单向**：`L3 → L2 → L1 → L0`。L0/L1 不 import 上层；L2 之间零 import。

### 3.2 禁止清单（写进 `src/core/guards`，能自动检出）

- `src/core/**` 不得 import `src/platforms/**`、`src/modules/**`、`src/chatApply.js`（防环，05 蓝图 §5.2 铁律）。
- `src/modules/A/**` 不得 import `src/modules/B/**`。
- 任何 `await import(变量)` / 动态 specifier —— 会打断 esbuild 静态图，打包必断（05 蓝图 §5.1）。
- 任何模块不得 import `../platforms/boss` —— 平台细节只在 `modules/channels/boss/**`。
- 扩展侧（`extension/**`）不得出现 DOM 写操作（`innerText=`、`appendChild`、`dispatchEvent` 等）——A7 已用 grep 验证过一次，现在要变成常驻守卫。

### 3.3 六个模块

| 模块 | 目录 | 一句话职责 | 平台相关 |
|---|---|---|---|
| **M1 ingest** | `src/modules/ingest/` | 岗位发现与详情增补：搜索解析、详情补全、去重、六列距离字段落库 | 否 |
| **M2 value** | `src/modules/value/` | 含金量卡：税前 / 五险一金 / 到手 / 可支配，**全部代码算**，口径可 env 覆盖，输出带来源标签 | 否 |
| **M3 copilot** | `src/modules/copilot/` | 聊天话术建议：意图分类 → 建议生成 → 输出守卫；驱动扩展 5s 轮询只读回路 | 否 |
| **M4 evidence** | `src/modules/evidence/` | 送达 / 简历附件 / 投递 的**证据判定**，产出"真的做了没"的结构化回执 | 否 |
| **M5 channel-boss** | `src/modules/channels/boss/` | BOSS 直聘 adapter：把 05 蓝图 §3.2 的 20 钩子真正立约并实现 | **是** |
| **M6 console** | `extension/` + `web/` | 侧边小窗与控制台：只读渲染、复制、设置、决策留痕可回看 | 否 |

M1–M4 之间零依赖，**四个子代理可同时开工**；M5 只碰平台细节；M6 只碰 UI。

### 3.4 为什么本轮**不搬**存量代码（关键决策）

`scripts/test-multiagent-flow.mjs` 以 `new AutoApplyBot({})` 直接调用约 26 个**私有方法**（`_waitForResumeConfirmEnabled` / `_sendResumeViaDialog` / `_selectChatRow` / `_sendResumeForChat` / `autoApply` …），且从 `../src/chatApply.js` 具名 import 27 个符号。搬文件 = 打断这条 import 面 = 11 套测试红。

因此：**并行期只做"新代码进新家 + 旧路径门面 re-export"**，与 05 蓝图步骤 7 的 facade 手法一致。存量代码的物理搬移放到 P3 **串行**进行（一次一个模块，每步 `npm test` 绿）。理由：让 6 个子代理的风险从"改 2932 行老代码"降到"写新文件"。

---

## 4. L1 契约层规格（Lead 亲自写，是并行安全的根）

`src/core/contracts/` 四份文件，每份一份 `.md` + 一份 `.js`（JSDoc typedef + 运行时校验函数）：

1. `adapterContract.js` —— 05 蓝图 §3.2 的 20 钩子清单，升级为**有名字的 typedef** + `assertAdapter(adapter)`。新增平台 = 实现这 20 个函数。
2. `httpContract.js` —— 把 `server.mjs` + `routes.mjs` 的 40+ 端点收成一张**路由表**（`{method, path, handler, auth?, module}`），server 从表里生成 if 链。契约文档同时是 API 文档。
3. `payloadContract.js` —— `buildLookResponse` / `computeValueCard` / evidence 回执的 JSON 结构**版本化**（`schemaVersion`）。`extension/panel.js` 与 `web/index.html` 都只允许通过这里的 accessor 读字段。
4. `configContract.js` —— 配置键的唯一清单（见 §7），三处真源合并为"服务端一份 + 扩展从服务端拉"。

**L1 硬约束**：这四个文件在并行期**只读**。子代理发现契约不足 ⇒ 上报 Lead，不自行修改。

---

## 5. 六个模块规格（含子代理任务书）

> 每个任务的通用部分：① 先读 `docs/06_TARGET_ARCHITECTURE.md` §3 禁止清单；② 只写自己的目录 + 一个新测试文件 `scripts/test-<模块>.mjs`；③ **禁止改 `package.json`**（Lead 统一接测试链）；④ 目录内必须有 `README.md`（模板见 §9）；⑤ 提交前 `npm test` 全绿。

### M1 ingest —— 岗位发现与详情增补
- **交付**：`src/modules/ingest/{index.js, parseList.js, parseDetail.js, dedupe.js, distance.js, README.md}`
- **契约**：`ingest.search({keyword, city, pages}) → JobDraft[]`；`ingest.enrich(draft) → JobDraft`；`JobDraft` 结构见 `payloadContract`。
- **红线**：去重键 = `(platform, url)`（DB 已有 `Job.url UNIQUE`）；六列距离字段 `lng/lat/distanceKm/distanceTier/hasDormitory/dormitorySource` 占位坐标（0/null）**不得落库**（09-19 三处污染事故）；`UNKNOWN` 永不自动投。
- **验收**：新测试 ≥ 25 断言，含三个 09-19 污染回归用例。

### M2 value —— 含金量卡
- **交付**：`src/modules/value/{index.js, rates.js, brackets.js, format.js, README.md}`
- **契约**：`value.card({salaryText, jobContext, env}) → ValueCard`；门面先 re-export 现有 `src/value.mjs`（保持 36 断言不破），真实实现逐步收拢。
- **红线**：**钱的数字 100% 代码算，LLM 不参与**；每个数字带 `source` 标签（`职位卡自报` / `估算` / `公式推导`）；社保个税口径必须显示"估算"，不许精确承诺；社保比例常量在 `rates.js` 顶部集中，env 可覆盖；**已砍掉"实际时薪"，不许加回来**。
- **验收**：`6-8K·13薪 → gross 7000 / 到手 5683.85 / 可支配 5657.45` 冒烟复现（09-22 A4 基线）。

### M3 copilot —— 聊天话术建议
- **交付**：`src/modules/copilot/{index.js, intent.js, suggest.js, guard.js, README.md}`
- **契约**：`copilot.respond({pageText, jobContext, profile, resume, env}) → LookResponse`，三态不变：`正常建议` / `needManual`（offer·社保·薪资谈判类不出建议只提示人工）/ `noChat`（空 pageText）。
- **红线**：LLM 吐手机号/邮箱/身份证/具体住址/精确生日**必被隐藏**（A5 守卫，`guard.js` 独立成文件便于单测）；技能只能在底细卡 14 词白名单内；LLM 挂了仍要 `ok:true` + 兜底模板 + `llmFailed:true`；建议条数截断 ≤160 字、正文去重。
- **验收**：`scripts/test-v0-extension-look.mjs` 现有 46 断言不破 + 新增 guard 专项。

### M4 evidence —— 证据与回执
- **交付**：`src/modules/evidence/{index.js, greeting.js, resumeAttach.js, apply.js, receipt.js, README.md}`
- **契约**：`evidence.classify({kind, before, after, text}) → {ok, reason, markers}`，`kind ∈ greeting|resumeAttach|resumeScreenshot|apply`。
- **红线**：判据唯一真源在此（现有 `src/replyVerification.js` 60 行为其前身，门面 re-export 保持不破）；简历送达必须有"附件简历请求已发送"证据，未收到回复时按钮被禁应记 `简历-待HR回复后发`；"报告回复 N 条实际送达 1 条"是已发生过的事故（09-20），任何"已发送"结论必须落到具体 marker。
- **验收**：≥ 20 断言，含 09-20 送达事故回归。

### M5 channel-boss —— BOSS adapter
- **交付**：`src/modules/channels/boss/{index.js, selectors.js, collectors.js, domInput.js, sessionFlow.js, resumeDialog.js, README.md}`
- **契约**：实现 05 蓝图 §3.2 全部 20 钩子 + 现有 6 方法；`assertAdapter(bossAdapter)` 通过。
- **红线**：只读优先——本模块**不实现任何点击/输入钩子**（`typeText`/`clickSend`/`openJobPage` 等写动作钩子先定义签名并 `throw new Error("未启用：见 §6 围栏")`）；不得 import `src/chatApply.js`；`detectBlocked` 必须含"访问受限/限制访问/异常行为"三词。
- **验收**：`assertAdapter` 通过 + 每钩子单测（含"未启用钩子抛错"用例）。

### M6 console —— 侧边小窗与控制台
- **交付**：`extension/{manifest.json, background.js, content.js, panel.html, panel.css, panel.js, README.md}` 瘦身 + `web/index.html` 拆分方案文档
- **红线**：`extension/content.js` **零 DOM 写**（守卫 grep）；只通过 `payloadContract` accessor 读字段，禁止裸 `res.xxx`；扩展设置**不再自存真源**，改为从服务端拉（§7）；`web/index.html` 3586 行单文件先出**拆分方案文档**，本轮不拆（拆 UI 需要真机回归，成本高收益低）。
- **验收**：扩展 manifest 校验通过；`content.js` 零写断言；"报告 N 条 vs 实际 1 条"类 UI 谎报在 M4 回执到位后消解。

---

## 6. L3 旧链围栏方案（不删、不跑、不改）

**决定：物理文件全部留在原位**（移动会打断测试 import 面），只加三道围栏：

1. **启动门禁**：`src/core/guards/legacyFence.js` —— `edgeLauncher` / `browserManager` / `autopilot` / `applyScheduler` / `replenish` 的启动路径统一检查 `JOB_AGENT_LEGACY`；未显式置 `1` 则**拒绝启动浏览器并打日志说明原因**（旧链是封号来源，默认关是唯一安全默认值）。
2. **文档围栏**：每个旧链文件头加三行注释——为什么冻结、什么时候可以解冻、解冻需要什么证据。
3. **资产化**：旧链不是垃圾，是**平台知识资产**（选择器表、20 钩子的真实来源、采集逻辑）。M5 立约时从旧链"读"实现，不"搬"实现。

`.env` 现状（`AUTOPILOT=1`、`JOB_AGENT_AUTO_APPROVE=1`、`APPLY_DLY_RUN=0` 真发）在围栏落地后**必须显式关闭**，否则门禁形同虚设。

---

## 7. 配置单一真源

现状三处真源：`.env`（服务进程 + 内嵌进 exe）、`extension/panel.js` 的 `storage.local`（`serverBase`/`pollIntervalSec`/`commuteMode`/`oneWayKm`）、控制台表单。

**目标**：服务端 `config/` 一份，`configContract.js` 定义键名与默认值；扩展**启动时向服务端拉取**并只读缓存（它本来就在轮询服务端，加一个 `GET /api/config` 成本≈0）；控制台只读渲染 + 显式提交；`.env` 降级为**环境覆盖层**（优先级：env > 配置文件 > 默认值）。

**配置键必须登记的两处**（09-19 事故根因）：`sea-config.json` 的 assets + `packaging/setup-sea.cjs`。任何新增数据资产（如 `prompts/candidate-card.md`、未来的 `config/`）**必须同时登记这两处**，否则桌面版静默缺资产。这条写进 `guards` 的打包检查。

---

## 8. 执行分期

| 期 | 内容 | 执行者 | 合入门槛 |
|---|---|---|---|
| **P0** | 契约层四份文件 + `guards` 六条不变量 + legacy 围栏 + 配置单一真源 | **Lead 亲自**（定所有人的边界，不能外包） | `npm test` 11 套绿 + `npm run guards` 绿 |
| **P0.5** | 提交 V0 基线（先 commit 未提交扩展工作，含 `.gitignore` 补 `.ext-*`），架构文档落库 | Lead | 单 commit，不夹带 |
| **P1** | 六个模块并行（M1–M6 六个子代理，写范围互斥） | 子代理 | 各模块自测绿 + README 齐全 + `npm test` 绿 |
| **P2** | 集成：M6 接 M2/M3/M4 的契约，扩展切到 `GET /api/config` | 子代理（写范围单点） | 扩展零写守卫 + 端点冒烟 |
| **P3** | 串行搬移存量代码（一次一模块，facade re-export，旧路径留 shim） | Lead | 每步 `npm test` 绿，每步一 commit |
| **P4** | **真机验收**：用户装载扩展 → 跑一次真实 BOSS 页面 → 按结果分叉 | 用户 + Lead | 09-22 任务卡 A1~A7 结清 |

**P1 并行安全的三个前提**（缺一不可）：① 契约层已冻结；② 每个子代理写范围只有"自己的目录 + 一个新测试文件"；③ 禁止改 `package.json` / `server.mjs` / 任何存量文件。

---

## 9. 模块 README 规范（用户明确要求：各个模块之间都要有 readme）

每个模块目录必须有 `README.md`，九个固定小节，缺一不可：

1. **一句话职责** —— 不超过 25 字，说不清就是职责没拆干净
2. **对外契约** —— 导出的函数签名、输入输出结构（指向 `payloadContract`）
3. **依赖** —— 依赖 `core/` 的哪些；**明确写出禁止依赖哪些模块**
4. **数据与配置** —— 读哪些配置键 / 写哪些表；env 覆盖项
5. **不变量** —— 本模块必须守住的硬规则（配断言位置）
6. **测试** —— 测试文件名 + 一条能复现的冒烟命令
7. **已知债务** —— 现状哪里是临时的、什么时候会变
8. **改动红线** —— 改这里最容易踩什么坑
9. **上游/下游** —— 谁调用我、我调用谁（与禁止清单互为印证）

---

## 10. 风险与红线

- **禁止多代理改同一文件** —— 每个任务的 `write_scopes` 显式登记，越界即停。
- **契约层冻结** —— 并行期要改 `core/**` 一律上报 Lead。
- **11 套测试全绿是合入门槛**，不是"应该能过"（05 蓝图 §5.4）。
- **不频繁提交**；禁止提交 `.env` / key / `*.log` / 诊断文件 / 临时脚本。
- **不引入新框架**：控制台保持原生 JS 单页，扩展保持 MV3 原生（任务卡轮子表已定）。
- **不重复造轮子**：BOSS 自动投递类轮子市面上已有，已造的继续维护（`2 - Notes\AI\DSH\协作铁律-不造轮子.md:31`）。
- **BOSS 链路再失效** → 走 reverse-skill（`D:\opensource\reverse-skill\skills\SKILL.md`），不做渗透测试。
- **禁调付费 API**：DSH 侧禁 `api.deepseek.com`；项目内 LLM 走 3010 本地网关（`LLM_PROVIDER=localgateway`）免费优先，429 降级 zhipu → deepseek → template。

---

## 11. 与 05 蓝图的关系

05 蓝图的 8 个步骤**全部保留有效**，但按新方向重排优先级，并明确"哪些步已被本架构的模块化吸收"：

| 05 步骤 | 本架构下的处置 |
|---|---|
| 步骤 1 零风险抽叶 | **已完成**（`src/core/utils.js`、`src/core/predicates.js`） |
| 步骤 2 BOSS 常量外迁 | 归入 **M5**（`modules/channels/boss/selectors.js`） |
| 步骤 3 立约 adapter | 归入 **L1 `adapterContract.js` + M5**（本轮最大新增） |
| 步骤 4 反馈 + LLM 下沉 | 归入 **M4**（evidence/feedback 部分） |
| 步骤 5 监控与回复骨架 | **降级延后** —— 新链是只读建议，不需要监控骨架 |
| 步骤 6 投递与简历编排 | **降级延后** —— 同上，围栏内不动 |
| 步骤 7 收口 facade | 归入 **P3 串行搬移** |
| 步骤 8 第二平台验证 | 保留为远期；L1 契约层已为它铺好路 |

**净效果**：原计划要拆的 2932 行，拆完也只是把一个**已被证伪的自动投递器**拆得更整齐。新架构把同样的工程量投在"证据、价值、话术、边界"上。

---

## 12. 需要用户拍板的四件事

1. **主链路确认**：是否认可"扩展只读 = 主链路，旧自动投递 = 围栏默认关"？
2. **旧链处置**：围栏冻结（推荐）／彻底删除／维持现状原样？
3. **真机验收时间**：P4 需要你本人装载扩展跑一次真实 BOSS 页面；排在 P0.5 提交之后、P1 并行期间（并行期不需要你）最省时间。
4. **是否要外部第二意见**：有 2~3 个取舍（控制台是否引框架、扩展是否自存配置、旧链删还是冻）适合拿网页版 ChatGPT 复核，本机 skill `chatgpt-web-second-opinion` 可直接驱动，需要时会占用你的桌面。
