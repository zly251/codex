# 08 Compatibility Matrix（现状取证 · P0.0）

> 状态：**已定稿** 2026-09-30（Lead 亲自取证，全部实测）。
> 用途：07 元问题一落地物 —— **先冻结事实，再冻结契约**。
> 裁决规则：P0 契约文件以本矩阵为准；矩阵与实际代码冲突时**以代码为准并回报 Lead 修订矩阵**，禁止拿"契约"覆盖事实。
> 判定三值：**K=保留**（契约照抄现状）/ **M=修改**（写目标形态+迁移路径）/ **D=废弃**（围栏，默认关）。

## 1. 取证方式

| 源 | 方式 | 备注 |
|---|---|---|
| `server.mjs` 739 行 | 通读 + grep 路由注册点 | 端点行号实测（§2） |
| `src/routes.mjs` 1223 行 | grep `^export (async )?function` | 32 导出（§4） |
| `src/chatApply.js` 3186 行 | 顶层符号抽取（历史已录） | ABI 面（§5） |
| `src/extensionLook.mjs` 286 / `src/value.mjs` 315 | 全文通读 | payload（§3、§6） |
| `extension/panel.js` 242 / `content.js` | 通读 fetch 段 + grep DOM | 扩展现状（§3） |
| env 键 | grep `process.env.` 全 src+server | §7 |
| 测试 | `npm test` 11 套实跑 exit 0 | §8 |

## 2. HTTP 端点矩阵

### 2.1 新主链路（扩展）
| # | method path | handler | 请求 | 响应 | 调用方 | 测试 | 判定 |
|---|---|---|---|---|---|---|---|
| E1 | POST `/api/extension/look`（OPTIONS :551、POST :561→impl :479） | `apiExtensionLook` server.mjs:479-514 | `{pageText,href,commuteMode,oneWayKm}` | §3.2 三态 | panel 5s 轮询 | test-v0-extension-look 46 断言 | **M**：+`requestId/timestamp/schemaVersion`（§3.1） |
| E2 | POST `/api/value` :539→impl :517 | `apiValue` | `computeValueCard` 入参 | 含金量卡全量 | 手填薪资口子 | test-v0-value 36 断言 | **K** |

### 2.2 控制台/数据（全 K）
| path（server.mjs 注册行） | handler |
|---|---|
| GET `/api/profile` `/api/stats` `/api/jobs` `/api/resumes` `/api/applications` `/api/strategy`（routes 表 :527-534） | `apiGetProfile`/`apiStats`/`apiJobs`/`apiResumes`/`apiApplications`/`apiStrategy` |
| POST `/api/profile`（:540） | `apiSaveProfile` |
| GET/POST `/api/resume/editor`（:546/:547）、GET `/api/resume/export`（:548） | `apiGetResumeEditor`/`apiSaveResumeEditor`/`apiExportResume` |
| POST `/api/resumes/upload`（:541）、GET `/api/resumes`、POST `/api/resumes/:id/default`、DELETE（:563） | resume 族 |
| GET `/api/stats` `/api/strategy` `/api/jobs` `/api/applications` | 查询族 |
| PATCH/DELETE `/api/applications/:id`（:578/:582）、POST `/api/jobs/:id/close`（:570）、`/api/jobs/close-stale`（:574） | 状态流转 |
| GET `/api/chat/messages`（:590） | `handleGetMessages` routes:1295 |
| GET `/api/chat/summaries`（:642）、POST `.../refresh`（:648） | chatSummary |
| GET `/api/review`（:654）+ POST approve/approve-all/auto-approve/reject（:655/:664/:673/:682） | routes:916-1040；**auto-approve 受 §2.3 门禁管** |

### 2.3 旧链（浏览器自动化 → D=围栏，默认关）
| path（:704-713 等） | handler（routes.mjs） | 判定 |
|---|---|---|
| `/api/boss/connect` :704 / `launch` :705 / `search` :706 / `enrich` :707 / `replenish` :708 / `apply` :709 / `stop` :710 / `chat/start` :711 / `chat/send-resume` :712 / `sync-feedback` :713 | handleConnect:376 / handleLaunch:336 / handleSearch:422 / handleEnrich:520 / handleReplenish:549 / handleApply:621 / handleChatStop:1257 / handleChatStart:1065 / handleChatSendResume:1220 / handleFeedbackSync:1268 | **D→围栏**：P0 接 legacyFence，`JOB_AGENT_LEGACY≠1` 拒绝并 409 |
| POST `/api/chat/send` :595、`/api/boss/chat/reply` :609 | `handleChatReply` routes:1188 | D→围栏 |
| GET `/api/autopilot/status` :623 / POST start :627 / stop :638 | autopilot | D→围栏 |
| GET `/api/boss/status` :694 / `/api/boss/chat/messages` / `/api/boss/chat/stop` :695 | `getStatus` routes:309 | D（只读可留，UI 标"已冻结"） |

## 3. E1 契约细节（M 的迁移目标）

### 3.1 请求：现状 → 目标
现状（panel.js:205-213 实测）：`{pageText, href, commuteMode, oneWayKm}`，**无身份字段**。`busy`（:197）只防同时并发，**防不了迟到响应串台**：LLM 慢 12s 期间用户已切会话 → 旧建议渲染到新页面。
目标（+3 字段，旧字段名不动）：
```jsonc
{ "requestId": "crypto.randomUUID()", "timestamp": Date.now(),   // 新增
  "pageText": "...", "href": "...", "commuteMode": "ebyke", "oneWayKm": 5 }
```
- 服务端规则（`src/core/payloadContract.js` 纯函数 + guards 检查请求侧）：同 href 族内 `timestamp` ≤ 已处理最新 ⇒ 丢弃；`requestId` 重复 ⇒ 幂等丢弃；三元缺任一 ⇒ 拒绝。
- 客户端规则（panel.js）：响应 `requestId ≠ 在飞 id` ⇒ 不渲染。

### 3.2 响应：三态形状（extensionLook.mjs:209-286 实测，字段名冻结）
- 正常 `{ok:true, jobTitle, needManual:false, intent, llmFailed, suggestions:[≤3]{label≤12,text≤160}, value}`
- 空页 `{ok:true, noChat:true, jobTitle:null, needManual:false, suggestions:[], value:{ok:false, reason:"未识别到聊天内容"}}`
- 人工 `{ok:true, jobTitle, needManual:true, reason, suggestions:[], value}`（value 仍出，含金量先于 LLM）
- 异常 `{ok:false, error:≤200字}` + HTTP 500（server.mjs:511）
目标：顶层 +`schemaVersion:"look-v1"` + 回显 `requestId`；其余字段**不得改名**（46 断言锚定）。

### 3.3 content.js 现状
只读：`innerText` 截 4000（会话面板优先，`document.body` 兜底）；通道 `{type:READ_PAGE}→{ok,pageText,href}`。**无 DOM 写**（grep 已证，保持，guards 常驻检查）。

### 3.4 含金量在 E1 内的生成路径（实测链）
`extractSalaryFromText`（锚"查看职位"前 400 字、向上 6 行，防左栏别的职位薪资串入，2026-09-25 真机坑）→ `computeValueCard({salaryK,lowK,highK,monthsSalary,commuteMode,oneWayKm})` → `value.salaryMatched` 标记。`needManual` 与空页都不跳过 value。

## 4. routes.mjs 导出面归属（模块地图输入）
| 导出 | 归属（06 §3.3） | 判定/备注 |
|---|---|---|
| `runSearchJobs:394` / `runEnrichBatch:442` | ingest | **M**：纯查询/入库面从浏览器耦合中抽出 |
| `isApplyDryRun:586` / `partitionByDecision:604` | copilot/review | K：纯函数直接进契约 |
| `checkLoggedIn:107` / `ensureBrowserConnected:146` / `isBrowserConnected:138` / `manualPendingCount:129` / `approvedPendingCount:153` | channel-boss 旧链 | D：围栏后仅供 legacy 自调用 |
| `recordChatTranscript:194` / `recentChatTranscripts:216` / `groupMessagesByChat:169` / `recentMessages:163` | evidence | K：留档 `JOB_AGENT_CHAT_TRANSCRIPT_PATH`（默认 `DATA_ROOT/data/chat-transcripts.json`，上限 200 条） |
| `handleReview*:916-1040` | review | K：用 `reviewQueue` 表（**手写表，不在 SCHEMA_SQL**——P0 config 契约要登记） |
| `logProviderWarning:1180` | observability | K |
| 模块级单例 `browserManager/scraper/bot/messages/state/cookieWatcher`（:34-56） | （全局态） | 禁令：P3 收编前**禁止新增同类单例** |

## 5. chatApply.js ABI 面（临时 ABI，P3 前冻结）
- 测试具名 import 面（test-multiagent-flow.mjs 实测 29 符号）：`AutoApplyBot, RESUME_SENT_MARKERS, RESUME_APPLIED_MARKERS, RESUME_SEND_BUTTON_TEXTS, isResumeSendUnavailable, isResumeSendInEffect, isResumeFileLastText, isSelectedResumeFallbackAllowed, isResumeDialogSignal, isResumeDialogConfirmAvailable, isResumePdfItem, shouldUseResumeVueFallback, isFatalBrowserError, isGenerationCurrent, isResumeFileAccept, resolveRedirectUrl, isStartChatApiSuccess, resolveChatStartPlan, isJobDetailReady, resolveResumeUploadState, resolveResumeUploadPoll, isChatPageReady, isChatActionReady, isChatActionEvidence, isUsableChatInput, resolveChatStartState, CHAT_READY_AREA_SELECTORS, CHAT_INPUT_SELECTORS, CHAT_NOT_READY`。
- `new AutoApplyBot({})` 空 manager + 假 page 驱动 ~26 个 `_` 私有方法。
- 规则（06 §3.4）：名称/签名/入参形状 = 契约；P1 不得改；P3"搬"与"改测试/改契约"不得混一步。

## 6. value 契约（`computeValueCard` 输出形状冻结点，test-v0-value 36 断言锚定）
入参：`{grossMonthly | salaryK, lowK, highK, monthsSalary, commuteMode, oneWayKm, socialBase, fundRate, specialDeduct, workdays, includeHousingInNet}`。
输出（`value.mjs:289-314` 实测形状，字段名冻结）：
```jsonc
{ "ok":true, "gross":6000, "grossSource":"职位卡自报",
  "grossRange":[6000,10000], "netRange":[…,…], "disposableRange":[…,…],   // 无区间→null
  "insurance":{ "base":8000, "baseSource":"估算(基数=月薪)", "fundRate":0.08,
    "items":{pension,medical,unemployment,housing}, "total":… },
  "tax":{ "taxable":…, "rate":0.03, "deduction":0, "tax":…, "special":0 },
  "net":…, "netWithHousing":…,
  "commute":{ "mode":"ebyke", "modeLabel":"电动车", "known":true, "perOneWay":…,
    "monthly":…, "oneWayMinutes":…, "monthlyMinutes":…, "workdays":22, "source":"估算(通勤方式经验价)" },
  "disposable":…, "disposableWithHousing":…,
  "annual":{ "monthsSalary":13, "annualNet":… },
  "sources":{ "gross":…, "insuranceBase":…, "fundRate":…, "specialDeduct":…, "commute":…, "tax":"估算(月度累进,忽略部分专项附加)" },
  "breakdown":[{ "label":"税前月薪","formula":"职位卡薪资区间取中值","value":"6000.00 ~ 10000.00","note":"职位卡标区间，按两端分别测算" }, …] }
```
口径常量（默认值）：社保 8%/2%/0.5%、公积金 8%、起征 5000、税率 7 档 `[3000,.03,0]…[∞,.45,15160]`、基数钳 `[4000,24000]`、工作日 22、`COMMUTE_MODES` 六种（metro/bus/ebyke/drive/walk/none）。
**红线（用户 09-22/09-25 拍板，不得改）**：钱全代码算、LLM 不参与；到手为王（无"实际时薪"字段）；区间薪资必须出 `*Range`（只报中值=假精确）；`breakdown` 算式明细随卡下发；所有口径带 `sources`/`note` 标签。

## 7. 配置键全量 + 两级真源映射（07 §1.3 裁决版）
| 键（组） | 现真源 | 目标真源 | 判定 |
|---|---|---|---|
| `serverBase`/`pollIntervalSec` | 扩展 `storage.local`（panel.js:2-5） | **扩展 storage.local（不动）** | K |
| `commuteMode`/`oneWayKm` | 扩展 `storage.local`（panel 默认 ebyke/5） | **服务端 config**（参与含金量计算） | M |
| `PORT`(3456) / `LLM_TIMEOUT_MS` / `EXT_LOOK_DEBUG` | env（server.mjs） | env 覆盖层 | K |
| `AUTOPILOT`、`JOB_AGENT_AUTO_APPROVE(_MIN/_MAX)` | env（.env 现全开+真发） | env + **受总闸 `JOB_AGENT_LEGACY` 管辖**（P0 新键） | M |
| `JOB_PLATFORM`、`BROWSER_PATH`/`EDGE_PATH`/`FIREFOX_PATH`/`JOB_AGENT_FIREFOX_PATH` | env | env（围栏内） | K |
| `JOB_AGENT_ROOT/DATA_DIR/DB_PATH/PROFILE_PATH/PROFILE_DIR/FALLBACK_PROFILE_DIR/FIREFOX_PROFILE_DIR/FIREFOX_FALLBACK_PROFILE_DIR/COOKIE_PATH/CHAT_PATH/CHAT_STATE_PATH/CHAT_TRANSCRIPT_PATH/SUMMARY_PATH/RESUME_DIR/RESUME_EDITOR_PATH/WEB_DIR/HOME_LAT/HOME_LNG/SELF_TIMEOUT_MS/TESS_WORKER/TESSDATA` | env（`paths.js`） | env | K |
| `JOB_AGENT_REPLENISH(_CITY/_ENRICH_MIN/_KEYWORDS/_PAGES/_SEARCH_MIN)` | env（keywords 默认"外贸业务员,销售,客服,业务助理,跟单文员"，routes.mjs:63） | env（围栏内） | K |
| `JOB_VALUE_*` 15 键：`PENSION/MEDICAL/UNEMP/FUND/TAX_THRESHOLD/METRO_KM/METRO_BASE/BUS_KM/BUS_BASE/EBYKE_KM/EBYKE_BASE/DRIVE_KM/DRIVE_BASE/SOCIAL_BASE_MIN/SOCIAL_BASE_MAX` | env（value.mjs `envNum()` 动态读） | **服务端 config + env 覆盖**（业务口径必须服务端可查可审计） | M |
| `LOCALAPPDATA`/`ProgramFiles` | 系统 env（paths 拼接） | 不动 | K |
> 禁令：**不得双写**。`commuteMode/oneWayKm` 迁服务端后，面板改 `GET /api/config` 只读显示、**不写回**；写入走控制台 `POST /api/config`。失败模式案例（07）：扩展 5km / 服务端 8km / 控制台 3km 而测试全绿 —— 因测试直调服务端私有方法。
> 打包双登记（06 §7）：新增数据资产必须同时登记 `sea-config.json` assets + `packaging/setup-sea.cjs`，guards 检查。

## 8. 测试基线（`npm test` 串行 11 套，2026-09-30 实测全绿 exit 0）
| 脚本 | 锚定面 | 围栏后要求 |
|---|---|---|
| test-multiagent-flow.mjs（84KB） | chatApply ABI 全量 + routes 假 page 流 | 必须保持绿（ABI 冻结） |
| test-reply-salary.mjs（30KB） | llmProvider / salary 口径 | 保持绿 |
| test-m1-distance.mjs（28KB） | distance / scoring 排序 | 保持绿 |
| test-m2-scheduler.mjs（16KB） | applyScheduler | 保持绿 |
| test-m3-llm.mjs（25KB） | llm 兜底链 | 保持绿 |
| test-autopilot.mjs（19KB） | autopilot **纯逻辑**（不驱动浏览器） | 围栏后仍须绿（纯逻辑不进门禁） |
| test-chat-summary.mjs（18KB） | chatSummary + evidence 留档 | 保持绿 |
| test-human-rhythm.mjs（5.7KB） | 拟人节奏 | 保持绿 |
| test-reply-delivery.mjs（12KB） | 回复投递判定 | 保持绿 |
| test-v0-value.mjs（5KB） | `computeValueCard` 36 断言 | 保持绿（§6 形状冻结） |
| test-v0-extension-look.mjs（11KB） | `buildLookResponse` 46 断言 | **M**：E1 加字段后此套必须扩展（+ident 三元/schemaVersion 断言），不得反向删旧断言 |
npm scripts：`start`（node server.mjs）、`test`（11 链）、`build:exe`（powershell packaging）、`import:resume`（tsx）、`build:icon`；P0 需新增 `guards`。

## 9. 汇总统计与 P1 派工映射
- 端点：27 个动作端点 = K 18（含 GET 查询族 6 + :527-534 表）/ M 3（E1、autopilot 门禁、config 迁移）/ D 6 组围栏（boss 10 口 + chat 写 2 口 + autopilot 3 口）。
- ABI：29 具名 import + ~26 私有方法 = 冻结。
- env：39 键（grep 实测）→ 两级真源映射 §7。
- P1 六子代理 → 模块归属已在 §4 表格"归属"列预埋（ingest / copilot / evidence / channel-boss-adapter / value+config / console+guards）。
- **矩阵未覆盖且子代理不得自行扩张**：`web/` 控制台前端路由（未取证）、`platforms/` 适配器（仅 `getPlatform` 一处调用点实测）、`chatState.js`/`chatSummary.js` 内部方法面（P1 各自模块内自行取证写入各自 README）。
