# M5 平台模块化拆分蓝图（chatApply.js → core + platforms/boss）

> 状态：蓝图（本文件是 M5 唯一产出，不改任何代码）。
> 验收标准：**新平台只需实现 adapter 接口清单**，不碰 `src/core/`。
> 反目标：不做代码美容。BOSS 巨型流程（简历弹窗、上传确认、Vue 兜底、截图上传）**整块留在 BOSS 侧**，不值得拆的不拆。
> 基线：`npm test` = 512 断言（`scripts/test-multiagent-flow.mjs` + `scripts/test-reply-salary.mjs`），测试直接 import 现有模块路径 → 第 6 节「不可破坏清单」优先于一切结构洁癖。

---

## 1. chatApply.js 现状分类（3260 行逐块判定）

### 1.1 模块级区段

| 行范围 | 内容 | 判定 |
|---|---|---|
| 1–13 | import（db/*、log、node:fs/path、paths、greeting、chatState、resumeExport、replyVerification、llmProvider） | 平台无关 |
| 15–19 | `sleep / randBetween / randSleep / log / clamp` 工具 | 平台无关 |
| 21–136 | 全部选择器/文案常量表：`START_CHAT_SELECTORS(21)` `START_CHAT_DATA_SELECTORS(33)` `CHAT_AREA_SELECTORS(46)` `CHAT_READY_AREA_SELECTORS(55)` `CHAT_NOT_READY(59)` `SEND_SELECTORS(61)` `SEND_TEXTS/START_TEXTS/RESUME_*_TEXTS(71–74)` `RESUME_SENT_MARKERS(76)` `RESUME_APPLIED_MARKERS(77)` `RESUME_SEND_BUTTON_*、RESUME_CHOOSE_DIALOG_*…RESUME_UPLOAD_*SELECTORS(82–112)` `UPLOAD_DIALOG_SKIP_SELECTORS(113)` `VUE_ACTION_METHODS(91)` `CHAT_SESSION_SELECTORS(92)` `BLOCKED_HINTS(121)` `SENT_MARKERS(122)` `FATAL_BROWSER_ERROR_HINTS(126)` | **BOSS 专用**（116 行） |
| 138–346 | 纯函数判据层（见 1.3） | 混合，可拆 |
| 348–366 | `normalizeCompany / normalizeJobTitle / feedbackStatusFromMessage` | 平台无关 |

### 1.2 AutoApplyBot 方法（368–3260，67 个方法）

| 判定 | 方法（行号） |
|---|---|
| **平台无关（内核）** | `_isResumeCurrent(383)` `_stoppedResumeResult(392)` `_persistResumeSentForChat(396)` `_finishResumeForChat(406)` `_humanWait(499)` `_humanMove(506)` `_humanClick(519)` `_locatePoint(528)` `_clickFirst(578)` `_clickTextControl(587)`（此六个是通用 DOM 机械：选择器/文案全部作参数传入，无 BOSS 字面量） `_findApplicationByCompany(1305)` `_progress(1395)` `_findResumeForJob(1410)` `_findResumeForChat(1415)` `generateReply(3243)` `stop(3250)` |
| **BOSS 专用** | `_getPage(416)`（`zhipin` URL 判断、`登录/注册` 探测） `_closeCurrentPage(476)` `_clickSendButton(655)` `_collectChatPageSnapshot(690)` `_waitForChatReady(721)` `_waitForChatReadyOrReload(732)` `_waitForChatAction(747)` `_collectChatActionState(757)` `_hasChatInputCandidate(792)` `_humanType(809)`（内嵌聊天作用域输入框判据+`CHAT_INPUT_SELECTORS`） `_checkPageState(937)`（`.btn-startchat`/`ka=` 字面量） `_isOnChatPage(1001)` `_collectJobDetailState(1009)` `_startChatWithJob(1033)`（data-url API + redirect goto） `_navigateToChat(1163)`（`/web/geek/chat?ka=header-message`） `_scanChatSessions(1257)` `_clickResumeSubmitButton(1421)` `_collectResumeSendState(1438)` `_collectSelectedResumeLastText(1511)`（`__vue__` 内省） `_selectedResumeSent(1573)` `_collectResumeState(1580)` `_resumeSentMarker(1685)` `_hasVisibleSend(1698)` `_clickResumeConfirm(1715)` `_waitForResumeDialog(1828)` `_waitForResumeConfirmEnabled(1857)` `_invokeVueMethod(1885)` `_openResumeSendDialog(1968)` `_selectResumeFromDialog(2016)`（硬编码 `"简历.pdf"` 2017 附近） `_waitForResumeSent(2068)` `_waitForResumeDialogSendDone(2078)` `_confirmResumeDialog(2106)` `_sendResumeViaDialog(2186)` `_countOwnImageMessages(2417)`（`.chat-record`） `_sendResumeScreenshot(2439)`（`/wapi/zpupload/image/uploadSingle` + `conversation.gid/securityId` + `sendImageMsg`） `_sendPreferredResume(2585)`（调度附件/截图，依赖上两者，暂归 BOSS） `_collectCurrentChatIdentity(2598)` `.chat-conversation` `_selectChatRow(2656)` |
| **混合，需拆分** | `_findApplicationForChat(1320)`（含 `/job_detail/<id>.html` 正则 1341） `syncFeedback(1373)`（含 `"BOSS 同步: "` 文案） `_isVerified(1399)` `_confirmResumeUpload(1740)`（轮询骨架无关，确认按钮判据 BOSS） `_sendResume(2209)`（流程骨架无关，全部页面动作 BOSS） `_sendResumeForChat(2610)` `_humanType` 的“定位→注入→回车”骨架无关 `autoApply(2725–2987)` `monitorChat(2989–3121)`（generation/`_checking`/onFatal/timer 语义全无关，DOM 动作全 BOSS） `sendReply(3122–3242)`（代际检查+验证判据无关，输入/发送/复核 collect 全 BOSS） |

### 1.3 纯判据函数（138–346）细分

| 平台无关（→ core） | BOSS 形（→ platforms/boss） |
|---|---|
| `isGenerationCurrent(147)` `resolveRedirectUrl(217)` `isChatPageReady(234)` `isChatActionReady(238)` `isChatActionEvidence(246)` `isJobDetailReady(261)` `resolveChatStartState(266)` `isResumeFileLastText(303)` | `isFatalBrowserError(138)` `isResumeFileAccept(155)` `isResumeSendUnavailable(159)` `isResumeSendInEffect(173)` `resolveResumeUploadState(180)` `resolveResumeUploadPoll(199)` `isStartChatApiSuccess(230)` `resolveChatStartPlan(255)` `CHAT_INPUT_SELECTORS(276)` `isUsableChatInput(287)` `isResumePdfItem(299)` `isSelectedResumeFallbackAllowed(313)` `isResumeDialogSignal(327)` `isResumeDialogConfirmAvailable(336)` `shouldUseResumeVueFallback(344)` |

### 1.4 占比统计

| 类别 | 行数 | 占比 |
|---|---|---|
| BOSS 专用（常量表 116 + BOSS 形判据 136 + BOSS 方法 ≈1694） | ≈1946 | **60%** |
| 平台无关（imports/工具/通用机械/无关判据/无关方法/helpers） | ≈367 | 11% |
| 混合需拆分（autoApply、monitorChat、sendReply、_sendResume 系、syncFeedback、_findApplicationForChat 等 8 块） | ≈932 | 29% |

拆分后预期归属：混合块中约 2/3 是嵌在编排里的 BOSS 页面动作与文案，落到 boss 侧 hook 实现；`src/core/` 最终约 900–1000 行，`src/platforms/boss/` 约 2200–2300 行。**结论：BOSS 耦合面远大于通用面，拆分收益点在编排层（第 3、5、6 节），不在判据层搬运。**

---

## 2. 依赖流向图（现状）

```
server.mjs
 └─ src/routes.mjs ──────────────────────────────┐
     ├─ src/platforms/index.js（注册表）          │
     │    └─ src/platforms/boss.js（adapter）     │
     │         ├─ src/scrapers/bossApi.js ──→ browser/browserManager.js
     │         └─ src/chatApply.js（AutoApplyBot）│ ← 唯一生产消费者是 boss.js:4
     ├─ src/applyScheduler.js   ← 在飞(M2)        │
     ├─ src/scoring.js / salary.js ← 在飞          │
     ├─ src/db/{index,application,company,job,resume,reviewQueue}.js ← reviewQueue 在飞
     ├─ src/resumeExport.js / llmProvider.js ← llmProvider 在飞
     ├─ src/browser/browserManager.js + edgeLauncher.js
     └─ src/paths.js
src/chatApply.js（叶子，除 boss.js 外无人 import；core 一旦反向 import 它就是环）
 ├─ db/* log.js paths.js(DATA_ROOT) node:fs node:path
 ├─ greeting.js   chatState.js   replyVerification.js
 ├─ resumeExport.js（ensureResumeScreenshot，平台无关）
 └─ llmProvider.js
```

要点：
- `chatApply → chatState/replyVerification/greeting/paths` 均为平台无关叶子，拆分时**留在 core，路径不动**。
- `platforms/boss.js → chatApply.js` 是单向边。拆出 bot 类后必须保持 **core ↛ platforms**，即 `BossBot` 只能被 boss 侧 import；adapter 对象（含 hooks）通过 `createBot(m)` 时注入（`new BossBot(m, bossPlatform)`），bot 内**禁止静态 import `platforms/*`**，否则 `boss → bot → boss` 成环。
- 在飞新增文件（`applyScheduler.js`、`distance.js`、`enrich.js`、`db/reviewQueue.js`）天然属于平台无关层，与 core 目标一致；本蓝图**只引用其现路径，不搬移、不修改**（见 §5.3）。

---

## 3. 目标结构与扩展 adapter 接口

### 3.1 目标文件树（每行 = 一句话职责 + 来源）

```
src/core/                         ← 平台无关内核（第二平台不许碰）
  utils.js                        通用工具 sleep/randBetween/randSleep/clamp     ← chatApply 15–19
  predicates.js                   无关纯判据：isGenerationCurrent/resolveRedirectUrl/
                                  isChatPageReady/isChatActionReady/isChatActionEvidence/
                                  isJobDetailReady/resolveChatStartState/isResumeFileLastText ← 138–346 子集
  humanize.js                     通用拟人机械：_humanWait/_humanMove/_humanClick/
                                  _locatePoint/_clickFirst/_clickTextControl（选择器全部入参）← 499–654
  feedback.js                     反馈状态机：syncFeedback 骨架 + feedbackStatusFromMessage +
                                  normalizeCompany/normalizeJobTitle + 应用查找            ← 348–366,1305–1393
  resumeState.js                  简历发送去重/代际锁语义：_isResumeCurrent/_stoppedResumeResult/
                                  _persistResumeSentForChat/_finishResumeForChat（chatState.js 之上的运行态封装）← 383–415
  chatMonitor.js                  会话监控循环骨架：generation/_checking/onFatal/timer 全语义
                                  （2993–3005 注释逐字保留为行为规格）+ sendReply 编排 + isReplyVerified 粘合 ← 2989–3242
  applyFlow.js                    投递编排骨架：autoApply 主循环（配额→节流→结果计数→截图文件名→
                                  stop 检查→致命错误终止），页面动作全走 adapter hooks       ← 2725–2987
  resumeFlow.js                   附件投递编排：_sendResumeForChat/_sendResume/_sendPreferredResume
                                  的流程骨架（预检→入口可用性→弹窗/上传路径选择→重试表→复核），
                                  页面动作走 adapter                                       ← 2209–2416,2585–2655
  llm.js                          LLM 胶水：generateReply 透传 llmProvider                  ← 3243–3249
  scheduler.js                    （不搬移）applyScheduler/distance/enrich 保持在现路径，core 直接 import
  adapterContract.js              adapter 接口清单 + 缺实现时的显式报错（仅约定，不做运行时强校验）
  botKernel.js                    BotKernel 基类：constructor(manager, style, adapter)、
                                  running/generation/_checking/stop()/progress/反馈与简历锁等无关状态

src/platforms/boss/               ← BOSS 专用（全部 selector/DOM/接口/风控留这里）
  selectors.js                    21–136 常量表 + CHAT_INPUT_SELECTORS(276) 原样搬运
  predicates.js                   §1.3 右列 BOSS 形判据 136 行原样搬运
  collectors.js                   page.evaluate 采集器：_collectChatPageSnapshot/_collectChatActionState/
                                  _checkPageState/_collectResumeState/_collectResumeSendState/
                                  _collectSelectedResumeLastText/_countOwnImageMessages/_hasVisibleSend/
                                  _hasChatInputCandidate/_collectCurrentChatIdentity        ← 690–1008,1438–1697,2417–2437,2598–2609
  domInput.js                     _humanType（聊天输入框注入+打字机）+ _clickSendButton      ← 655–689,809–936
  jobFlow.js                      _getPage/_closeCurrentPage/_collectJobDetailState/
                                  _startChatWithJob/_navigateToChat/_waitForChatReady*/
                                  _waitForChatAction                                        ← 416–498,721–756,1009–1256
  sessionFlow.js                  _scanChatSessions/_selectChatRow                          ← 1257–1304,2656–2724
  resumeDialog.js                 简历弹窗全链：_clickResumeSubmitButton/_selectedResumeSent/
                                  _resumeSentMarker/_waitForResumeDialog/_waitForResumeConfirmEnabled/
                                  _invokeVueMethod/_openResumeSendDialog/_selectResumeFromDialog/
                                  _waitForResumeSent/_waitForResumeDialogSendDone/
                                  _confirmResumeDialog/_sendResumeViaDialog/_clickResumeConfirm ← 1421–2208（弹窗整块，不拆）
  resumeUpload.js                 _confirmResumeUpload 的 BOSS 部分（上传对话框文案/选择器驱动）← 1740–1827
  resumeScreenshot.js             _sendResumeScreenshot（uploadSingle API + Vue sendImageMsg 整块保留）← 2439–2584
  scraper.js                      （步骤 7，需等在飞改动落地）现 src/scrapers/bossApi.js 整体迁入
  bot.js                          BossBot extends BotKernel：装配上述实现为 adapter hooks，
                                  并保留全部旧方法名（测试直接调用私有方法）
  index.js                        现 src/platforms/boss.js 内容：bossPlatform（含扩展 hooks 定义 + createBot）
src/platforms/boss.js             ← 改为 re-export shim：export * from "./boss/index.js"（防外部路径断裂）
src/chatApply.js                  ← 最终改为 facade（§4 步骤 7 前逐名 re-export；不删除，见 §4 末）
```

### 3.2 扩展 adapter 接口清单（新平台要实现的钩子）

现有 6 方法保留：`id/name/baseUrl/jobsUrl/loginUrl`、`isJobDomain(url)`、`findJobPage(manager)`、`isLoggedIn(page)`、`cookieBackupPath/saveCookies/restoreCookies`、`createScraper(manager)`、`createBot(manager)`。

新增钩子（全部从 chatApply 的 BOSS-only 调用归纳，签名为建议值）：

| # | 钩子 | 职责 | BOSS 实现来源 |
|---|---|---|---|
| 1 | `openJobPage(page, job)` | 导航到职位详情页（URL 模板） | autoApply 内 `job_detail` 拼接段 2731–2800 |
| 2 | `collectJobDetailState(page)` | 采集详情页可沟通状态 | `_collectJobDetailState` 1009–1032 |
| 3 | `startChat(page, job)` | 发起会话（返回 `"skip"｜true｜CHAT_NOT_READY`） | `_startChatWithJob` 1033–1162 |
| 4 | `navigateToChat(page)` | 进入聊天页并确保就绪（含 reload 重试） | `_navigateToChat` + `_waitForChatReadyOrReload` |
| 5 | `readThreads(page)` | 扫描会话列表，返回规范化 `[{name,company,msg,rowId,href,unread,hrLast,text}]` | `_scanChatSessions` 1257–1304 |
| 6 | `selectChatRow(page, chat)` | 按身份选中会话行 | `_selectChatRow` 2656–2724 |
| 7 | `collectCurrentChatIdentity(page)` | 读当前会话头部的对端身份 | 2598–2609 |
| 8 | `readChatState(page)` | 页面状态快照（inputExists/hasSendVisible/hasDelivered/hasGreeted/chatTextLen…） | `_checkPageState` 937–1000 |
| 9 | `typeText(page, text)` | 聊天输入框打字（含注入兜底） | `_humanType` 809–936 |
| 10 | `clickSend(page)` | 点发送按钮（含文案兜底、回车由 core 决定） | `_clickSendButton` 655–689 |
| 11 | `verifyGreeting(before, after)` | 打招呼成功判据（DOM 证据侧） | `_isVerified` 的 BOSS 字段依赖 |
| 12 | `sendResumeAttachment(page, resume, opts)` | 附件简历发送整链（弹窗/上传/Vue 兜底，返回 `{ok,reason,fileName}`） | `_sendResumeViaDialog` + `_sendResume` BOSS 段 |
| 13 | `captureResumeShot(page, resume, opts)` | 简历截图上传发送（`ensureResumeScreenshot` + 平台图消息接口） | `_sendResumeScreenshot` 2439–2584 |
| 14 | `clickResumeSubmit(page)` | 详情页“投递简历”按钮路径 | `_clickResumeSubmitButton` 1421–1437 |
| 15 | `detectBlocked(bodyText)` | 风控/登录拦截文案判定，返回命中文案 | `BLOCKED_HINTS` + autoApply 2803–2812 登录判定 |
| 16 | `isFatalError(err)` | 致命浏览器错误判定 | `isFatalBrowserError` + `FATAL_BROWSER_ERROR_HINTS` |
| 17 | `jobIdFromUrl(url)` | 会话↔职位关联：从 href 提取 jobId | `_findApplicationForChat` 1341 正则 |
| 18 | `notePrefix` | 应用备注来源标记（替代 `"BOSS 同步: "`，用 `platform.name`） | `syncFeedback` 1373–1393 |
| 19 | `failureShot(kind)` | 失败截图文件名（`last_fail/last_blocked/last_unverified`，目录仍 `path.join(DATA_ROOT,"data")`） | 2814/2830/2955/2962 |
| 20 | `resumeAltNames()` | 简历别名列表（**替换 4 处硬编码 `"简历.pdf"`**：2017 区、2187、2221、2887、2924） | 现散布在弹窗/发送/投递三处 |

明确**不进接口**（留在 boss/bot.js，第二平台自己另写）：`_invokeVueMethod`、`_collectResumeState`、`_waitForResumeDialogSendDone`、`_confirmResumeDialog`、`_sendResumeViaDialog`、`_countOwnImageMessages` 及其选择器 —— 按反目标原则整块不拆。

---

## 4. 迁移步骤（每步可测、可回滚，按序执行）

**每步通用回归**：`npm test`（512 断言必须全绿）；步骤涉及新文件后追加 `npx esbuild --bundle server.mjs --platform=node --format=cjs --outfile=NUL 的替代检查`（见 §5.1，实际用 `powershell scripts/build-exe.ps1` 的 bundle 阶段或 `node -e "import('./src/routes.mjs')"` 冒烟）。任何一步失败 = git revert 该步，不影响前步。

1. **步骤 1｜零风险抽叶**：新建 `core/utils.js`、`core/predicates.js`、`core/humanize.js`，把 §3.1 对应块移入；`chatApply.js` 顶部改为 import + **逐名 `export { … } from "./core/…"` re-export**（含测试引用的 26 个具名导出），类内 `_humanWait` 等方法体改为一行委托。测试的具名 import 面不破。跑 `npm test`。
2. **步骤 2｜BOSS 常量与判据外迁**：新建 `platforms/boss/selectors.js` + `boss/predicates.js`，整块搬运 21–136 与 §1.3 右列；`chatApply.js` 同样逐名 re-export（`RESUME_SENT_MARKERS`、`isResumeDialogSignal`、`CHAT_INPUT_SELECTORS`、`CHAT_READY_AREA_SELECTORS`、`CHAT_NOT_READY` 等测试直接引用）。行为零改动。跑 `npm test` + SEA bundle 检查。
3. **步骤 3｜立约**：新建 `core/adapterContract.js`（§3.2 钩子清单文档化）；`platforms/boss/index.js` 出现（内容由现 `boss.js` 搬来），旧路径 `src/platforms/boss.js` 改 re-export shim；`createBot(m)` 改 `new BossBot(m, bossPlatform)`，BossBot 此步只是 `class BossBot extends AutoApplyBot {}` 占位（放 `boss/bot.js`）。**不成环**：bot 不 import adapter，靠构造注入。跑 `npm test`（覆盖 `getPlatform("boss").createBot` 路径）。
4. **步骤 4｜反馈 + LLM 下沉**：新建 `core/feedback.js`、`core/llm.js`；`syncFeedback` 骨架、`feedbackStatusFromMessage`、`_findApplicationByCompany`、`generateReply`、`_findResumeForJob/_findResumeForChat` 入 core；`"BOSS 同步: "` 改 `this.adapter.name` 拼接，`_findApplicationForChat` 的正则改调 `adapter.jobIdFromUrl`。routes 用的 `b._findApplicationForChat/b._findResumeForChat` 名字保留（基类方法委托）。跑 `npm test` + 手动 once 反馈同步冒烟。
5. **步骤 5｜监控与回复骨架**：新建 `core/chatMonitor.js`：把 `monitorChat` 的循环/generation/`_checking`/fatal 复位/timer 竞态防御（3074–3119 语义）**连同原注释**移入，DOM 动作（navigate/scan/select/type/clickSend/verify-collect）改调 `this.adapter.*`；`sendReply` 同理，`isReplyVerified` 粘合留 core。`_humanType/_clickSendButton` 移入 `boss/domInput.js` 并以 hook 暴露。跑 `npm test`（含 `_scanChatSessions`、`_selectChatRow` 旧名可达性）。
6. **步骤 6｜投递与简历编排**：新建 `core/applyFlow.js`、`core/resumeFlow.js`、`core/resumeState.js`、`boss/jobFlow.js`、`boss/sessionFlow.js`、`boss/resumeDialog.js`、`boss/resumeUpload.js`、`boss/resumeScreenshot.js`。`autoApply` 主循环与 `_sendResumeForChat/_sendResume` 的流程骨架（重试原因表 2644–2646、already-sent 预检顺序、stop 检查点）入 core；全部页面动作、`last_fail.png` 落盘点走 hook（`failureShot`、`detectBlocked`、`resumeAltNames` 在此步替换硬编码文件名）。**本步改动面最大，单独一 commit，测 `autoApply(dryRun)`/`once` 监控 + `npm test`。**
7. **步骤 7｜收口 facade（bossApi 搬移放在最后且需协调）**：`AutoApplyBot` 类体全部迁入 `boss/bot.js`（改名 `BossBot`，旧方法名一个不减），`chatApply.js` 仅剩 `export { BossBot as AutoApplyBot } from "./platforms/boss/bot.js"` + 各步累积的具名 re-export。然后才把 `src/scrapers/bossApi.js` 平移为 `platforms/boss/scraper.js`（旧路径留 re-export shim）——**必须等 in-flight 代理对 bossApi 的 rawData/JD 采集改动落库后再做**。跑 `npm test`。
8. **步骤 8｜（另立项）第二平台验证**：新平台只新增 `src/platforms/<x>/{selectors,predicates,collectors,domInput,jobFlow,sessionFlow,resumeDialog,resumeScreenshot,index}.js` 中它需要的文件 + adapter 实现；`JOB_PLATFORM=<x>` 切换。**`chatApply.js` facade 永久保留不删**（测试与 `scripts/test-multiagent-flow.mjs` 按此路径 import；删除动作被本蓝图明确否决）。

---

## 5. 风险清单

### 5.1 SEA 打包（`packaging` + esbuild）
- `scripts/build-exe.ps1` 用 `npx esbuild --bundle --platform=node --format=cjs` 从 `packaging/entry.cjs` 与 `server.mjs` 追静态 import 图。**相对路径 re-export shim 完全安全**；任何 `await import(变量)` 会打包断链——全程禁止动态 specifier。
- 步骤 2/7 完成后必须跑一次 bundle（不必出 exe，esbuild 零报错即通过），验证新目录在打包图里可达。
- `sea-config.json` 的 assets 只含 `dist/` 产物与 web/tessdata，不含 `src/`，目录重组不需要改它。

### 5.2 循环 import
- 铁律：**`src/core/**` 不得 import `src/platforms/**` 与 `chatApply.js`**。adapter 一律构造注入（§2）。
- `boss/index.js → boss/bot.js → (基类 core/botKernel.js)` 单向；botKernel 只收 adapter 实例。若 boss/index 需要引用 BossBot 再被 BossBot 引用 adapter 对象，用「index.js 文件底部对象里闭包 `() => new BossBot(m, bossPlatform)`」规避。

### 5.3 在飞代理冲突（改这些文件=撞车）
- 正在被改：`src/routes.mjs`（M2 调度/dry-run、`partitionByDecision` 预留 `distanceTier`）、`src/scoring.js`、`src/llmProvider.js`、`src/db/*`（+新 `db/reviewQueue.js`）、`src/scrapers/bossApi.js`、`web/index.html`、新文件 `applyScheduler.js/distance.js/enrich.js`。
- 本蓝图工作面锁死为 `chatApply.js + src/platforms/** + 新建 src/core/**`；**步骤 1–6 一律不动上述在飞文件**。routes 侧对 bot 的私有成员依赖（`b.running/b._checking/b.generation/b._findApplicationForChat/b._findResumeForChat/b._sendResumeForChat/b.syncFeedback/b.monitorChat/b.sendReply/b.generateReply/b.stop`）由基类+facade 保证不变。
- `applyScheduler.throttleOptions → autoApply(delayMin/delayMax)` 契约在步骤 6 重写 autoApply 时必须原样保留（含 fallback `{delayMin:8,delayMax:25}`）。

### 5.4 测试耦合（最高风险）
- `test-multiagent-flow.mjs` 以 `new AutoApplyBot({})`（manager 传空对象、**不触碰浏览器**）直接调用约 26 个**私有方法**（`_waitForResumeConfirmEnabled/_confirmResumeDialog/_selectChatRow/_sendResumeForChat/_scanChatSessions/_sendResume/_startChatWithJob/autoApply(假jobs,…)` 等）驱动假 page。因此：类必须保持单参构造可用；私有方法名与签名不变、且在同一实例上可达（委托可以，改名不行）；`_getPage` 等被调路径不得在构造时访问 `manager`。
- 每步迁移后跑测试不是「应该能过」，是**合入门槛**。

### 5.5 路径解析
- `chatApply` 无 `require()`、无 `import.meta`；`DATA_ROOT` 均来自 `paths.js`（其 `import.meta.url` try/catch → `process.cwd()` 兜底已 SEA 适配）。迁移时 `data/last_fail.png`、`data/chat-state.json`、`boss-cookies.json` 继续走 `paths.js`/`DATA_ROOT`，**禁止引入第二套路径解析**。
- `require('fs')/node:fs`：`chatApply` 用 `fs.existsSync/readFileSync`（2217/2462）随代码搬到 boss 侧即可，无行为风险。

### 5.6 已知债务（迁移时顺带处理，不单独立项）
- 硬编码 `"简历.pdf"` ×4 → `adapter.resumeAltNames()`（步骤 6）。
- `"BOSS 同步: "` → `platform.name` 参数化（步骤 4）。
- page.evaluate 内联复制 `PENDING_CHIP_HINTS` 判据：因页面 CSP 禁 eval/new Function，**这份重复是有意设计，保留**，两侧加注释互相锚定。
- BOSS `viewed` 状态自动回写：M5 明确不做（见 03_DEV_PLAN §13）。
- `monitorChat` 的 `_checking` 互斥注释（3000–3005）与 fatal 复位注释（3077–3088）是行为规格，搬移时逐字随代码走。

---

## 6. 不可破坏清单（合入前逐项核对）

### 6.1 `scripts/test-multiagent-flow.mjs` 的 import 面
- `../src/db/index.js {initDb, getDb}`；`../src/db/{application,company,job,resume}.js`（命名空间）
- `../src/greeting.js {buildGreeting}`；`../src/chatState.js`（命名空间）；`../src/replyVerification.js {isReplyVerified, isResumeSentEvidence, isResumeAttachmentSentEvidence, hasPendingChipHint, isPendingChipText, PENDING_CHIP_HINTS}`
- `../src/chatApply.js {AutoApplyBot, RESUME_SENT_MARKERS, RESUME_APPLIED_MARKERS, RESUME_SEND_BUTTON_TEXTS, isResumeSendUnavailable, isResumeSendInEffect, isResumeFileLastText, isSelectedResumeFallbackAllowed, isResumeDialogSignal, isResumeDialogConfirmAvailable, isResumePdfItem, shouldUseResumeVueFallback, isFatalBrowserError, isGenerationCurrent, isResumeFileAccept, resolveRedirectUrl, isStartChatApiSuccess, resolveChatStartPlan, isJobDetailReady, resolveResumeUploadState, resolveResumeUploadPoll, isChatPageReady, isChatActionReady, isChatActionEvidence, isUsableChatInput, resolveChatStartState, CHAT_READY_AREA_SELECTORS, CHAT_INPUT_SELECTORS, CHAT_NOT_READY}`
- `../src/routes.mjs`（命名空间 import）
- 类实例面：`new AutoApplyBot({})` + 上述私有方法名与入参形状（fake page 注入）

### 6.2 `scripts/test-reply-salary.mjs` 的 import 面
- `../src/llmProvider.js {buildReplyPrompt, buildSafeResumeText, extractSkillWhitelist, extractPositiveClaims, validateReplyForCapabilities, classifyIntent, generateReply, getProviderConfig, sanitizePromptText}`
- `../src/salary.js {parseMonthlySalaryK, salaryRankForJob, sortJobsForApply}`；`../src/scoring.js {scoreJob}`（**不 import chatApply**，但 llmProvider/salary 在飞改动会牵动它 → 模块化步骤禁止顺手改这两处）

### 6.3 `server.mjs` / `src/routes.mjs` 面
- `server.mjs`：11 个 `handle*` 具名 + db/paths/resumeExport/scoring/strategy/utils import 不变。
- `routes.mjs`：`getPlatform(...).createBot(manager)` 返回值必须仍暴露 `running/generation/_checking/style` 字段与 `autoApply/monitorChat/sendReply/syncFeedback/generateReply/stop/_findApplicationForChat/_findResumeForChat/_sendResumeForChat`。
- `platforms/index.js` 注册表与 `JOB_PLATFORM` 环境变量语义不变；`boss.js` 路径经 shim 仍可达。

### 6.4 行为面（测试没盖住但线上依赖）
- `data/chat-state.json` 键语义与重试闸门（60s / resume_unavailable 90s）不变；`CHAT_STATE_PATH` env 覆盖不变。
- `data/boss-cookies.json` 与 15s cookie 巡检不变。
- `monitorChat` 代际/互斥/fatal 复位语义（routes 409 判断依赖 `b.running、b._checking`）不变。
- `throttleOptions → delayMin/delayMax`（秒）契约不变。
