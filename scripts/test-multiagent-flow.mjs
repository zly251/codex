// 最小多智能体流程测试：buildGreeting 占位符替换 + chatState 去重/会话身份
// 使用临时路径，不写入项目 portable 数据。
// 注：monitorChat 的 _checking 互斥属浏览器集成行为（依赖 page/running），不在纯函数测试
// 范围内；代际有效性已抽为 isGenerationCurrent 纯函数，在本文件直接断言。
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// 必须在 import chatState 前设置，chatState 的 CHAT_STATE_PATH 在模块顶层求值
const tmpState = path.join(
  os.tmpdir(),
  `job-agent-chat-state-${process.pid}-${Date.now()}.json`
);
process.env.JOB_AGENT_CHAT_STATE_PATH = tmpState;

const tmpDb = path.join(
  os.tmpdir(),
  `job-agent-test-${process.pid}-${Date.now()}.db`
);
process.env.JOB_AGENT_DB_PATH = tmpDb;

const { initDb: initTestDb, getDb: getTestDb } = await import("../src/db/index.js");
initTestDb();
const applicationDb = await import("../src/db/application.js");
const companyDb = await import("../src/db/company.js");
const jobDb = await import("../src/db/job.js");
const resumeDb = await import("../src/db/resume.js");

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log("  ✓ " + msg);
  } else {
    failed++;
    console.error("  ✗ " + msg);
  }
}

const { buildGreeting } = await import("../src/greeting.js");
const chatState = await import("../src/chatState.js");
const { isReplyVerified, isResumeSentEvidence, isResumeAttachmentSentEvidence, hasPendingChipHint, isPendingChipText, PENDING_CHIP_HINTS } = await import("../src/replyVerification.js");
const { AutoApplyBot, RESUME_SENT_MARKERS, RESUME_APPLIED_MARKERS, RESUME_SEND_BUTTON_TEXTS, isResumeSendUnavailable, isResumeSendInEffect, isResumeFileLastText, isSelectedResumeFallbackAllowed, isResumeDialogSignal, isResumeDialogConfirmAvailable, isResumePdfItem, shouldUseResumeVueFallback, isFatalBrowserError, isGenerationCurrent, isResumeFileAccept, resolveRedirectUrl, isStartChatApiSuccess, resolveChatStartPlan, isJobDetailReady, resolveResumeUploadState, resolveResumeUploadPoll, isChatPageReady, isChatActionReady, isChatActionEvidence, isUsableChatInput, resolveChatStartState, CHAT_READY_AREA_SELECTORS, CHAT_INPUT_SELECTORS, CHAT_NOT_READY } = await import("../src/chatApply.js");

const job = { title: "C++开发工程师", companyName: "某某科技", technologies: "C++,Qt" };
const profile = { name: "张三", skills: "C++,Qt,Linux", targetRole: "C++开发工程师" };

console.log("[buildGreeting] 占位符替换");
const out1 = buildGreeting(
  job,
  profile,
  "您好，我是{name}，有{skills}相关经验，对贵司的{job}岗位很感兴趣，方便沟通一下吗？"
);
assert(out1.includes("张三"), "替换 {name} -> 张三");
assert(out1.includes("C++,Qt,Linux"), "替换 {skills}");
assert(out1.includes("C++开发工程师"), "替换 {job} -> 职位标题");
assert(!out1.includes("{"), "无残留占位符");

const outCompany = buildGreeting(job, profile, "您好，我是{name}，来自{company}，应聘{job}岗位。");
assert(outCompany.includes("某某科技"), "替换 {company} -> 公司名");
assert(outCompany.includes("C++开发工程师"), "替换 {job}");
assert(!outCompany.includes("{"), "company 模板无残留占位符");

console.log("[buildGreeting] raw 未提及职位时自动补职位表达");
const out2 = buildGreeting(job, profile, "您好，我是{name}，很高兴认识您！");
assert(out2.includes("张三"), "仍替换 {name}");
assert(out2.includes("C++开发工程师"), "自动补职位标题");
assert(out2.includes("岗位很感兴趣"), "自动补职位相关表达");

console.log("[buildGreeting] raw 已提及职位时不重复补");
const out3 = buildGreeting(job, profile, "您好，我对C++开发工程师岗位很感兴趣。");
assert(out3.includes("岗位很感兴趣"), "保留原句");
assert((out3.match(/C\+\+开发工程师/g) || []).length === 1, "职位标题只出现一次，未重复补充");

console.log("[chatState] shouldReply / markReplied 去重");
const c1 = { name: "李经理", company: "A公司", msg: "你好，方便聊聊吗？", rowId: "row-1", href: "/c/1" };
assert(chatState.shouldReply(c1) === true, "首次消息应回复");
chatState.markReplied(c1, "好的", { ok: true });
assert(chatState.shouldReply(c1) === false, "回复后不应再回复");

console.log("[chatState] manual-pending 与 replied 区分");
const cManual = { name: "赵经理", company: "M公司", msg: "明天方便面试吗？", rowId: "row-manual" };
assert(chatState.shouldReply(cManual) === true, "manual 消息首次可进入处理");
chatState.markManualPending(cManual, "面试/Offer需人工确认");
assert(chatState.shouldReply(cManual) === false, "manual-pending 后不应自动发送");
const manualState = JSON.parse(fs.readFileSync(tmpState, "utf8"));
const manualKey = chatState.chatKey(cManual);
assert(manualState[manualKey]?.manualPending === true, "manual-pending 状态标记存在");
assert(manualState[manualKey]?.replied !== true, "manual-pending 不等于 replied");
assert(manualState[manualKey]?.ok !== true, "manual-pending 不等于 ok");
assert(manualState[manualKey]?.markedAt, "manual-pending 记录标记时间");

console.log("[chatState] chatKey 会话身份优先级");
const kRow = chatState.chatKey({ rowId: "r1", name: "甲", company: "X公司", msg: "hi" });
const kSession = chatState.chatKey({ sessionKey: "r1", name: "乙", company: "Y公司", msg: "hi" });
assert(kRow === kSession, "rowId 与 sessionKey 视为同一会话身份");

const kHref1 = chatState.chatKey({ href: "/c/100", name: "甲", company: "X公司", msg: "hi" });
const kHref2 = chatState.chatKey({ href: "/c/200", name: "甲", company: "X公司", msg: "hi" });
assert(kHref1 !== kHref2, "同名同公司同消息但 href 不同 -> key 不同");

const kHrefOnly = chatState.chatKey({ href: "/c/100", name: "甲", company: "X公司", msg: "hi" });
const kNameOnly = chatState.chatKey({ name: "甲", company: "X公司", msg: "hi" });
assert(kHrefOnly !== kNameOnly, "href 优先于 name|company，不撞 key");

const kSameName1 = chatState.chatKey({ name: "甲", company: "X公司", msg: "hi" });
const kSameName2 = chatState.chatKey({ name: "甲", company: "X公司", msg: "hi" });
assert(kSameName1 === kSameName2, "无 rowId/href 时回退 name|company 身份");

console.log("[chatState] shouldTryResume / markResumeAttempted 限流");
const resumeChat = { name: "王经理", company: "B公司", msg: "有空吗", rowId: "row-r" };
assert(chatState.shouldTryResume(resumeChat, 1000) === true, "简历未尝试过 -> 允许补发");
chatState.markResumeAttempted(resumeChat, { ok: false, reason: "resume_unavailable" }, 1000);
assert(chatState.shouldTryResume(resumeChat, 1000) === false, "resume_unavailable 后 90 秒内不重试");
assert(chatState.shouldTryResume(resumeChat, 1000 + 89999) === false, "resume_unavailable 未满 90 秒仍不重试");
assert(chatState.shouldTryResume(resumeChat, 1000 + 90000) === true, "resume_unavailable 满 90 秒后允许重试");
const resumeChatOtherMsg = { name: "王经理", company: "B公司", msg: "其他消息", rowId: "row-r" };
assert(chatState.shouldTryResume(resumeChatOtherMsg, 1000 + 90000) === true, "resume 限流不包含 msg，按会话身份复用");
chatState.markResumeAttempted({ name: "刘经理", company: "C公司", rowId: "row-ok" }, { ok: true }, 2000);
assert(chatState.shouldTryResume({ name: "刘经理", company: "C公司", rowId: "row-ok", msg: "不同" }, 999999) === false, "简历已发送后不再重试");
chatState.markResumeAttempted({ name: "陈经理", company: "D公司", rowId: "row-f" }, { ok: false, reason: "no_dialog" }, 5000);
assert(chatState.shouldTryResume({ name: "陈经理", company: "D公司", rowId: "row-f" }, 5000 + 59999) === false, "其他失败 60 秒内不重试");
assert(chatState.shouldTryResume({ name: "陈经理", company: "D公司", rowId: "row-f" }, 5000 + 60000) === true, "其他失败满 60 秒后允许重试");

console.log("[replyVerification] 发送成功判定");
assert(isReplyVerified({ inputExists: true, inputCleared: true, replyInArea: true }) === true, "inputExists 且 inputCleared 且 replyInArea -> 成功");
// sentMarker 不能独立成功：历史“已发送/送达”标记会残留，须有 grew 佐证本次发送新增了内容
assert(isReplyVerified({ inputExists: true, inputCleared: true, sentMarker: true, grew: false }) === false, "inputExists+inputCleared+sentMarker 但没有 grew -> 不成功");
assert(isReplyVerified({ inputExists: true, inputCleared: true, replyInArea: true, sentMarker: false, grew: false }) === true, "有 replyInArea -> 成功");
assert(isReplyVerified({ inputExists: true, inputCleared: true, sentMarker: true, grew: true }) === true, "sentMarker 且 grew -> 成功");
assert(isReplyVerified({ inputExists: true, inputCleared: true, grew: true }) === false, "仅 grew 增长、无 replyInArea/sentMarker -> 不成功");
assert(isReplyVerified({ inputExists: true, inputCleared: false, replyInArea: true, sentMarker: true }) === false, "inputCleared=false 即使有标记 -> 不成功");
assert(isReplyVerified({ inputExists: true, inputCleared: true, replyInArea: false, sentMarker: false, grew: true }) === false, "grew 只是辅助信息不能单独成功");
assert(isReplyVerified({ inputExists: true, inputCleared: true, replyInArea: false, sentMarker: false, grew: false }) === false, "inputExists+inputCleared 但无任何发送证据 -> 不成功");
// 输入框缺失 / 未确认相关边界
assert(isReplyVerified({ inputCleared: false, sentMarker: true }) === false, "inputCleared=false 且只有 sentMarker -> 不成功");
assert(isReplyVerified({ inputCleared: false, replyInArea: true, sentMarker: true }) === false, "inputCleared=false 且片段+历史标记齐备 -> 仍不成功");
assert(isReplyVerified() === false, "空参数 -> 不成功");
assert(isReplyVerified({}) === false, "全缺省 -> 不成功");
assert(isReplyVerified({ inputCleared: true, replyInArea: true }) === false, "未提供 inputExists（输入框可能不存在）-> 不成功");

console.log("[resumeEvidence] 简历已发送强特征判定");
// 只有通用“已发送”（不在强特征列表中，故 hasStrongResumeMarker=false）且无文件名 -> 未发送
assert(isResumeSentEvidence({ hasFileName: false, hasStrongResumeMarker: false, pendingFile: false }) === false, "只有通用已发送/无文件名/无强特征 -> 未发送");
assert(isResumeSentEvidence({ hasFileName: true, hasStrongResumeMarker: false, pendingFile: false }) === true, "有文件名 -> 已发送");
assert(isResumeSentEvidence({ hasFileName: false, hasStrongResumeMarker: true, pendingFile: false }) === true, "有强特征（如简历已发送）-> 已发送");
assert(isResumeSentEvidence({ hasFileName: true, hasStrongResumeMarker: true, pendingFile: false }) === true, "文件名+强特征齐备 -> 已发送");
assert(isResumeSentEvidence({ hasFileName: true, hasStrongResumeMarker: true, pendingFile: true }) === false, "有 pendingFile 待确认文件 -> 未发送");
assert(isResumeSentEvidence({ hasFileName: false, hasStrongResumeMarker: false, pendingFile: true }) === false, "仅 pendingFile 无其它证据 -> 未发送");
assert(isResumeSentEvidence() === false, "空参数 -> 未发送");

console.log("[resumeEvidence] allowFileName 门槛");
// allowFileName=false（预检/发送按钮未确认被点击）：hasFileName 单独成立不能判已发送。
// chatApply.js 中 resumeOpenedBySubmit=true 的两处 resumeResult 判定同样传 { allowFileName: false }，
// 避免“待发送文件 chip/历史同名文件”被误判为已发送。
assert(isResumeSentEvidence({ hasFileName: true, hasStrongResumeMarker: false, pendingFile: false }, { allowFileName: false }) === false, "allowFileName=false 且仅文件名 -> 未发送");
assert(isResumeSentEvidence({ hasFileName: true, hasStrongResumeMarker: true, pendingFile: false }, { allowFileName: false }) === true, "allowFileName=false 但强特征成立 -> 已发送");
assert(isResumeSentEvidence({ hasFileName: false, hasStrongResumeMarker: true, pendingFile: false }, { allowFileName: false }) === true, "allowFileName=false 仅强特征 -> 已发送");
// allowFileName=true（默认/发送按钮已确认被点击）：hasFileName 单独成立即可
assert(isResumeSentEvidence({ hasFileName: true, hasStrongResumeMarker: false, pendingFile: false }, { allowFileName: true }) === true, "allowFileName=true 仅文件名 -> 已发送");
// 未开启 allowResidualInput 时，pendingFile 在任意 allowFileName 下都一律视为未发送
assert(isResumeSentEvidence({ hasFileName: true, hasStrongResumeMarker: false, pendingFile: true }, { allowFileName: true }) === false, "allowFileName=true 但 pendingFile -> 未发送");
assert(isResumeSentEvidence({ hasFileName: true, hasStrongResumeMarker: true, pendingFile: true }, { allowFileName: false }) === false, "allowFileName=false 且强特征+文件名 但 pendingFile -> 仍未发送");

console.log("[resumeEvidence] 确认后残留 input 文件判定");
assert(
  isResumeSentEvidence(
    { hasFileName: true, hasStrongResumeMarker: false, pendingFile: true, pendingChip: false },
    { allowFileName: true, allowResidualInput: true }
  ) === true,
  "确认已关闭且聊天区出现附件气泡，残留 input 文件不再判失败"
);
assert(
  isResumeSentEvidence(
    { hasFileName: true, hasStrongResumeMarker: false, pendingFile: true, pendingChip: false },
    { allowFileName: true, allowResidualInput: false }
  ) === false,
  "未确认路径残留 input 文件仍保守判未发送"
);
assert(
  isResumeSentEvidence(
    { hasFileName: true, hasStrongResumeMarker: true, pendingFile: true, pendingChip: true },
    { allowFileName: false, allowResidualInput: true }
  ) === false,
  "pending chip 残留时即使允许残留文件也仍判未发送"
);
assert(
  isResumeSentEvidence(
    { hasFileName: true, hasStrongResumeMarker: true, pendingFile: true, pendingChip: false },
    { allowFileName: false, allowResidualInput: true }
  ) === true,
  "确认关闭且强特征成立时，仅残留文件不再阻止已发送判定"
);

console.log("[resumeEvidence] 待发送 chip 残留判定");
// pendingChip：聊天区存在可见的待发送文件 chip（含文件名或未完成提示）时一律视为未发送，
// 即使发送按钮已确认点击（allowFileName=true）且文件名/强特征齐备——点击发送成功不证明上传成功
assert(isResumeSentEvidence({ hasFileName: true, hasStrongResumeMarker: false, pendingFile: false, pendingChip: true }, { allowFileName: true }) === false, "allowFileName=true 但 pendingChip 残留 -> 未发送");
assert(isResumeSentEvidence({ hasFileName: true, hasStrongResumeMarker: true, pendingFile: false, pendingChip: true }, { allowFileName: false }) === false, "强特征+文件名齐备但 pendingChip 残留 -> 仍未发送");
assert(isResumeSentEvidence({ hasFileName: true, hasStrongResumeMarker: false, pendingFile: true, pendingChip: true }) === false, "pendingFile 与 pendingChip 同时成立 -> 未发送");
assert(isResumeSentEvidence({ hasFileName: true, hasStrongResumeMarker: true, pendingFile: false, pendingChip: false }) === true, "无 pending 残留且证据齐备 -> 已发送");
assert(isResumeSentEvidence({ hasFileName: false, hasStrongResumeMarker: true, pendingFile: false, pendingChip: false }, { allowFileName: false }) === true, "无 chip 残留时 allowFileName=false 仅强特征 -> 已发送");

console.log("[resumeEvidence] 待发送 chip 未完成提示判定");
assert(hasPendingChipHint("待发送") === true, "「待发送」视为未完成");
assert(hasPendingChipHint("简历.pdf 等待发送") === true, "「等待发送」视为未完成");
assert(hasPendingChipHint("上传中 23%") === true, "「上传中」视为未完成");
assert(hasPendingChipHint("发送失败，点击重试") === true, "「发送失败」视为未完成");
assert(hasPendingChipHint("简历.pdf") === false, "纯文件名不含未完成提示");
assert(hasPendingChipHint("简历已发送") === false, "「已发送」成功文案不算未完成提示");
assert(hasPendingChipHint("") === false, "空文本 -> 非未完成");
assert(PENDING_CHIP_HINTS.length >= 5, "未完成提示列表保留核心文案");

console.log("[resumeEvidence] isPendingChipText 未完成 chip 判定");
// 真实已发送的附件气泡也包含文件名，不能仅凭文件名/命中成功文案置为 chip
assert(isPendingChipText("简历已发送 resume.pdf", "resume.pdf") === false, "真实已发送附件气泡含文件名 -> 非 chip");
assert(isPendingChipText("resume.pdf 已发送", "resume.pdf") === false, "已发送成功文案 + 文件名 -> 非 chip");
// 未完成提示 + 文件名齐备 -> chip
assert(isPendingChipText("待发送 resume.pdf", "resume.pdf") === true, "待发送提示 + 文件名 -> chip");
assert(isPendingChipText("上传中 resume.pdf", "resume.pdf") === true, "上传中提示 + 文件名 -> chip");
// 未传 fileName 时，只要有未完成提示即 chip
assert(isPendingChipText("上传中") === true, "上传中且未传文件名 -> chip");
assert(isPendingChipText("等待发送") === true, "等待发送且未传文件名 -> chip");
// 有 fileName 但文本不含文件名时，未完成提示单独不能触发（chip 元素必须同时带文件名才与本次附件相关）
assert(isPendingChipText("取消", "resume.pdf") === false, "有 fileName 但文本不含文件名 -> 非 chip");
assert(isPendingChipText("发送失败", "resume.pdf") === false, "未完成提示但文本不含文件名 -> 非 chip");
// 纯文件名无未完成提示，绝不触发
assert(isPendingChipText("resume.pdf", "resume.pdf") === false, "纯文件名无未完成提示 -> 非 chip");
assert(isPendingChipText("", "resume.pdf") === false, "空文本 -> 非 chip");

console.log("[resumeEvidence] RESUME_SENT_MARKERS 已收紧");
assert(!RESUME_SENT_MARKERS.includes("已发送"), "通用标记「已发送」已移除");
assert(!RESUME_SENT_MARKERS.includes("发送成功"), "通用标记「发送成功」已移除");
assert(RESUME_SENT_MARKERS.includes("附件简历请求已发送"), "强特征包含「附件简历请求已发送」");
assert(RESUME_SENT_MARKERS.includes("点击预览附件简历"), "强特征包含「点击预览附件简历」");
assert(RESUME_SENT_MARKERS.length >= 8, "强特征列表保留 8 个简历/附件专属标记");
assert(RESUME_SENT_MARKERS.every((m) => /简历|附件/.test(m)), "全部标记均与简历/附件相关");

console.log("[resumeEvidence] RESUME_APPLIED_MARKERS 在线投递强特征");
assert(RESUME_APPLIED_MARKERS.includes("你与该职位竞争者PK情况"), "在线投递强特征：竞争者 PK 情况");
assert(RESUME_APPLIED_MARKERS.includes("查看详细分析"), "在线投递强特征：查看详细分析");
assert(RESUME_APPLIED_MARKERS.includes("共人投递，你超过竞争者"), "在线投递强特征：超过竞争者");
assert(
  isResumeSentEvidence(
    { hasFileName: false, hasStrongResumeMarker: false, hasAppliedResumeMarker: true, pendingFile: false, pendingChip: false }
  ) === false,
  "仅竞争者PK/共人投递/查看详细分析不能作为简历已发送证据"
);

console.log("[resumeEvidence] 选择简历弹窗发送成功强特征");
assert(
  isResumeAttachmentSentEvidence({
    hasFileName: true,
    hasStrongResumeMarker: true,
    hasRequestMarker: true,
    pendingFile: false,
    pendingChip: false,
  }) === true,
  "「附件简历请求已发送」且文件名出现 -> 已发送"
);
assert(
  isResumeAttachmentSentEvidence({
    hasFileName: false,
    hasStrongResumeMarker: true,
    hasRequestMarker: true,
    pendingFile: false,
    pendingChip: false,
  }) === false,
  "「附件简历请求已发送」但无文件名 -> 未确认"
);
assert(
  isResumeAttachmentSentEvidence({
    hasFileName: true,
    hasStrongResumeMarker: false,
    hasRequestMarker: true,
    pendingFile: false,
    pendingChip: false,
  }) === false,
  "仅文件名/无附件强特征 -> 未发送"
);
assert(
  isResumeAttachmentSentEvidence({
    hasFileName: true,
    hasStrongResumeMarker: true,
    hasRequestMarker: true,
    pendingFile: false,
    pendingChip: true,
  }) === false,
  "pending chip 残留 -> 未发送"
);
assert(
  isResumeAttachmentSentEvidence({
    hasFileName: true,
    hasStrongResumeMarker: true,
    hasRequestMarker: true,
    pendingFile: false,
    pendingChip: false,
    confirmVisible: true,
  }, { allowResidualInput: true, ignoreConfirmVisible: true }) === true,
  "弹窗仍打开但附件请求成功证据已出现 -> 跳过 Vue 兜底"
);
assert(
  isResumeAttachmentSentEvidence({
    hasFileName: true,
    hasStrongResumeMarker: true,
    hasRequestMarker: true,
    pendingFile: false,
    pendingChip: false,
    confirmVisible: true,
  }, { allowResidualInput: true }) === false,
  "默认弹窗打开时仍不判定成功，避免误判"
);

console.log("[resumeDialog] 发简历弹窗状态判定");
assert(isResumeDialogSignal({ hasDialog: true, hasResumeList: true }) === true, "active 弹窗含 .resume-list -> 发简历弹窗");
assert(isResumeDialogSignal({ hasDialog: true, hasConfirmButton: true }) === true, "active 弹窗含 .btn-confirm -> 发简历弹窗");
assert(isResumeDialogSignal({ hasDialog: true, hasHint: true }) === true, "active 弹窗含文案 -> 发简历弹窗");
assert(isResumeDialogSignal({ hasDialog: true }) === false, "active 弹窗无列表/确认/文案 -> 不是发简历弹窗");
assert(isResumeDialogSignal({ hasDialog: false, hasResumeList: true }) === false, "无 active 弹窗 -> 不是发简历弹窗");
assert(isResumeDialogConfirmAvailable({ hasDialog: false, hasConfirmButton: true }) === false, "无弹窗时不能点击确认按钮");
assert(isResumeDialogConfirmAvailable({ hasDialog: true, hasConfirmButton: true, confirmDisabled: false }) === true, "弹窗内确认按钮可用 -> 可点击");
assert(isResumeDialogConfirmAvailable({ hasDialog: true, hasConfirmButton: true, confirmDisabled: true }) === false, "弹窗内确认按钮 disabled -> 不可点击");

console.log("[resumeDialog] PDF 简历项判定");
assert(isResumePdfItem({ text: "周礼洋简历.pdf" }) === true, "文本含 .pdf -> PDF");
assert(isResumePdfItem({ className: "icon-pdf" }) === true, "class 含 icon-pdf -> PDF");
assert(isResumePdfItem({ text: "个人简历.docx" }) === false, "docx 不是 PDF");
assert(isResumePdfItem({ text: "头像.png" }) === false, "png 不是 PDF");

console.log("[resumeEvidence] 当前选中会话最后一条简历文件判定");
assert(isResumeFileLastText("周礼洋简历.pdf", ["周礼洋简历.pdf", "周礼洋简历"]) === true, "选中行 lastText=周礼洋简历.pdf -> 视为简历文件");
assert(isResumeFileLastText("周礼洋简历.docx", ["周礼洋简历.docx"]) === true, "选中行 lastText 精确匹配 .docx -> 视为简历文件");
assert(isResumeFileLastText("你好，方便聊一下吗", ["周礼洋简历.pdf"]) === false, "普通打招呼消息不是简历文件");
assert(isResumeFileLastText(["普通消息", "周礼洋简历.pdf"], ["周礼洋简历.pdf"]) === true, "选中行候选列表命中简历文件");
assert(isResumeFileLastText("请发送周礼洋简历.pdf", ["周礼洋简历.pdf"]) === false, "HR 请求文本不是简历文件");

console.log("[resumeEvidence] 选中行兜底启用条件");
assert(isSelectedResumeFallbackAllowed({ hasChatArea: false }) === true, "聊天区为空 -> 允许选中行兜底");
assert(isSelectedResumeFallbackAllowed({ hasChatArea: true, chatAreaText: "" }) === true, "聊天区加载中但无文本 -> 允许选中行兜底");
assert(isSelectedResumeFallbackAllowed({ hasChatArea: true, chatAreaText: "加载中..." }) === true, "聊天区加载文案 -> 允许选中行兜底");
assert(isSelectedResumeFallbackAllowed({ hasChatArea: true, chatAreaText: "周礼洋简历.pdf" }) === false, "聊天区已有消息 -> 不以选中行兜底");
assert(isSelectedResumeFallbackAllowed({ hasChatArea: false, pendingChip: true }) === false, "pending chip 残留 -> 不判已发送");
assert(isSelectedResumeFallbackAllowed({ hasChatArea: false, pendingFile: true }) === false, "待发送文件残留 -> 不判已发送");

console.log("[resumeDialog] 发简历入口按钮文本集合");
assert(RESUME_SEND_BUTTON_TEXTS.includes("发简历"), "发简历入口文本包含「发简历」");
assert(RESUME_SEND_BUTTON_TEXTS.includes("求简历"), "发简历入口文本包含「求简历」");

console.log("[resumeDialog] Vue 兜底前置判定");
assert(shouldUseResumeVueFallback({ sent: false, dialogOpen: true }) === true, "未发送且弹窗仍打开 -> 可执行 Vue 兜底");
assert(shouldUseResumeVueFallback({ sent: true, dialogOpen: true }) === false, "已发送成功 -> 不再执行 Vue 兜底");
assert(shouldUseResumeVueFallback({ sent: false, dialogOpen: false }) === false, "弹窗已关闭 -> 不再执行 Vue 兜底");
assert(shouldUseResumeVueFallback({ sent: true, dialogOpen: false }) === false, "已发送且弹窗关闭 -> 不再执行 Vue 兜底");
assert(shouldUseResumeVueFallback({ sent: false, dialogOpen: true, sendInEffect: true }) === false, "发送请求已生效 -> 不再执行 Vue 兜底");
assert(shouldUseResumeVueFallback({ sent: false, dialogOpen: true, sendInEffect: false }) === true, "无发送生效状态且弹窗仍打开 -> 才执行 Vue 兜底");

console.log("[resumeEvidence] isResumeSendUnavailable 发简历入口禁用判定");
assert(
  isResumeSendUnavailable({
    hasVisibleResumeSend: true,
    resumeSendDisabled: true,
    resumeSendAriaLabel: "求简历：双方回复后可用",
    resumeSendText: "发简历",
  }) === true,
  "可见发简历入口 disabled 且 aria 提示双方回复后可用 -> 不可用"
);
assert(
  isResumeSendUnavailable({
    hasVisibleResumeSend: true,
    resumeSendDisabled: true,
    resumeSendAriaLabel: "正在请求中，等待对方回复",
    resumeSendText: "发简历",
  }) === true,
  "aria「正在请求中，等待对方回复」-> 不可用"
);
assert(
  isResumeSendUnavailable({
    hasVisibleResumeSend: true,
    resumeSendDisabled: false,
    resumeSendAriaLabel: "发简历",
    resumeSendText: "发简历",
  }) === false,
  "可见且可用的发简历入口 -> 可用"
);
assert(
  isResumeSendUnavailable({
    hasVisibleResumeSend: true,
    resumeSendDisabled: false,
    resumeSendAriaLabel: "求简历",
    resumeSendText: "求简历",
  }) === false,
  "单独出现「求简历」不是禁用提示 -> 可用"
);
assert(
  isResumeSendUnavailable({
    hasVisibleResumeSend: false,
    resumeSendDisabled: true,
    resumeSendAriaLabel: "求简历：双方回复后可用",
    resumeSendText: "发简历",
  }) === false,
  "入口不可见时不判定为禁用状态"
);

console.log("[resumeEvidence] isResumeSendInEffect 发送已生效判定");
assert(
  isResumeSendInEffect({
    hasVisibleResumeSend: true,
    resumeSendDisabled: false,
    resumeSendAriaLabel: "正在请求中，等待对方回复",
    resumeSendText: "求简历",
  }) === true,
  "aria「正在请求中，等待对方回复」-> 发送已生效"
);
assert(
  isResumeSendInEffect({
    hasVisibleResumeSend: true,
    resumeSendDisabled: false,
    resumeSendAriaLabel: "求简历",
    resumeSendText: "求简历",
  }) === false,
  "可用「求简历」按钮 -> 发送未生效"
);

console.log("[chatApply] 发简历弹窗 fake-page 最小流程");
let confirmCalls = 0;
const resumeDialogBot = new AutoApplyBot({});
const confirmEnabled = await resumeDialogBot._waitForResumeConfirmEnabled({
  evaluate: async () => {
    confirmCalls++;
    return true;
  },
}, 50);
assert(confirmEnabled === true, "_waitForResumeConfirmEnabled 可用时返回 true，不抛 ReferenceError");
assert(confirmCalls >= 1, "_waitForResumeConfirmEnabled 至少轮询一次");

let dialogOpenChecks = 0;
const dialogOpenAtOnce = await resumeDialogBot._waitForResumeDialog({
  evaluate: async () => {
    dialogOpenChecks++;
    return { hasDialog: true, hasResumeList: true, hasConfirmButton: false, hasHint: false };
  },
}, 0);
assert(dialogOpenAtOnce === true, "_waitForResumeDialog timeout=0 立即返回弹窗真实打开状态");
assert(dialogOpenChecks === 1, "_waitForResumeDialog timeout=0 至少立即执行一次 page.evaluate");

let dialogClosedChecks = 0;
const dialogClosedAtOnce = await resumeDialogBot._waitForResumeDialog({
  evaluate: async () => {
    dialogClosedChecks++;
    return { hasDialog: false, hasResumeList: false, hasConfirmButton: false, hasHint: false };
  },
}, 0);
assert(dialogClosedAtOnce === false, "_waitForResumeDialog timeout=0 弹窗关闭时立即返回 false");
assert(dialogClosedChecks === 1, "_waitForResumeDialog timeout=0 弹窗关闭也至少执行一次 page.evaluate");

let sentWhileDialogOpenChecks = 0;
const sentWhileDialogOpen = await resumeDialogBot._waitForResumeDialogSendDone({
  evaluate: async () => {
    sentWhileDialogOpenChecks++;
    return {
      hasFileName: true,
      hasStrongResumeMarker: true,
      hasRequestMarker: true,
      pendingFile: false,
      pendingChip: false,
      confirmVisible: true,
    };
  },
}, "周礼洋简历.pdf", [], 0);
assert(sentWhileDialogOpen.ok === true, "弹窗仍打开但强成功证据已出现 -> 确认流程直接成功");
assert(sentWhileDialogOpenChecks >= 1, "强成功证据等待至少检查一次");

const dialogClosedAfterClick = await resumeDialogBot._waitForResumeDialogSendDone({
  evaluate: async (fn, ...args) => {
    if (typeof args[0] === "string") {
      return {
        hasFileName: false,
        hasStrongResumeMarker: false,
        hasRequestMarker: false,
        pendingFile: false,
        pendingChip: false,
        confirmVisible: false,
      };
    }
    if (typeof args[1] === "string") {
      return { hasDialog: false, hasResumeList: false, hasConfirmButton: false, hasHint: false };
    }
    return {
      hasVisibleResumeSend: true,
      resumeSendDisabled: false,
      resumeSendAriaLabel: "求简历",
      resumeSendText: "求简历",
    };
  },
}, "周礼洋简历.pdf", [], 0);
assert(dialogClosedAfterClick.ok === false, "DOM 点击后弹窗已关闭但无强成功证据 -> 不能判定成功");
assert(dialogClosedAfterClick.reason === "unverified", "弹窗关闭但无强成功证据 -> 返回 unverified");
assert(dialogClosedAfterClick.dialogOpen === false, "弹窗关闭作为辅助状态返回");

const dialogStillPending = await resumeDialogBot._waitForResumeDialogSendDone({
  evaluate: async (fn, ...args) => {
    if (typeof args[0] === "string") {
      return {
        hasFileName: false,
        hasStrongResumeMarker: false,
        hasRequestMarker: false,
        pendingFile: false,
        pendingChip: false,
        confirmVisible: true,
      };
    }
    if (typeof args[1] === "string") {
      return { hasDialog: true, hasResumeList: true, hasConfirmButton: false, hasHint: false };
    }
    return {
      hasVisibleResumeSend: true,
      resumeSendDisabled: false,
      resumeSendAriaLabel: "求简历",
      resumeSendText: "求简历",
    };
  },
}, "周礼洋简历.pdf", [], 0);
assert(dialogStillPending.ok === false, "弹窗仍打开且无成功证据 -> 不判定成功，允许进入 Vue 兜底");
assert(dialogStillPending.sendInEffect === false, "按钮仍可用且无发送生效 -> 允许进入 Vue 兜底");

const sendInEffectDetected = await resumeDialogBot._waitForResumeDialogSendDone({
  evaluate: async (fn, ...args) => {
    if (typeof args[0] === "string") {
      return {
        hasFileName: false,
        hasStrongResumeMarker: false,
        hasRequestMarker: false,
        pendingFile: false,
        pendingChip: false,
        confirmVisible: true,
      };
    }
    if (typeof args[1] === "string") {
      return { hasDialog: true, hasResumeList: true, hasConfirmButton: false, hasHint: false };
    }
    return {
      hasVisibleResumeSend: true,
      resumeSendDisabled: false,
      resumeSendAriaLabel: "正在请求中，等待对方回复",
      resumeSendText: "求简历",
    };
  },
}, "周礼洋简历.pdf", [], 0);
assert(sendInEffectDetected.sendInEffect === true, "按钮进入「正在请求中」状态 -> 发送请求已生效");
assert(sendInEffectDetected.ok === false, "发送请求已生效但尚无强证据 -> 返回未确认");

console.log("[chatApply] _confirmResumeDialog 成功判定与 Vue 兜底触发");
let noClickVueCalls = 0;
const noClickBot = new AutoApplyBot({});
noClickBot._resumeSentMarker = async () => false;
noClickBot._invokeVueMethod = async () => {
  noClickVueCalls++;
  return { called: true };
};
const noClickResult = await noClickBot._confirmResumeDialog(
  { evaluate: async () => false },
  "周礼洋简历.pdf",
  []
);
assert(noClickResult === false, "未点击发送且无强成功证据 -> false");
assert(noClickVueCalls === 0, "未点击发送时不调用 Vue 兜底");

let closedNoEvidenceVueCalls = 0;
const closedNoEvidenceBot = new AutoApplyBot({});
closedNoEvidenceBot._waitForResumeDialogSendDone = async () => ({
  ok: false,
  reason: "unverified",
  sendInEffect: false,
  dialogOpen: false,
});
closedNoEvidenceBot._resumeSentMarker = async () => false;
closedNoEvidenceBot._resumeSendInEffect = async () => false;
closedNoEvidenceBot._waitForResumeDialog = async () => false;
closedNoEvidenceBot._invokeVueMethod = async () => {
  closedNoEvidenceVueCalls++;
  return { called: true };
};
const closedNoEvidenceResult = await closedNoEvidenceBot._confirmResumeDialog(
  { evaluate: async () => true },
  "周礼洋简历.pdf",
  []
);
assert(closedNoEvidenceResult === false, "点击发送但弹窗关闭且无强成功证据 -> false");
assert(closedNoEvidenceVueCalls === 0, "弹窗关闭且无证据时不调用 Vue 兜底");

let strongEvidenceVueCalls = 0;
const strongEvidenceBot = new AutoApplyBot({});
strongEvidenceBot._waitForResumeDialogSendDone = async () => ({
  ok: true,
  reason: "sent",
  sendInEffect: false,
  dialogOpen: true,
});
strongEvidenceBot._invokeVueMethod = async () => {
  strongEvidenceVueCalls++;
  return { called: true };
};
const strongEvidenceResult = await strongEvidenceBot._confirmResumeDialog(
  { evaluate: async () => true },
  "周礼洋简历.pdf",
  []
);
assert(strongEvidenceResult === true, "点击发送且弹窗仍打开但强成功证据已出现 -> true");
assert(strongEvidenceVueCalls === 0, "强成功证据已出现时不调用 Vue 兜底");

let pendingSendVueCalls = 0;
const pendingSendBot = new AutoApplyBot({});
pendingSendBot._waitForResumeDialogSendDone = async () => ({
  ok: false,
  reason: "send_in_effect_unverified",
  sendInEffect: true,
  dialogOpen: true,
});
pendingSendBot._resumeSentMarker = async () => false;
pendingSendBot._resumeSendInEffect = async () => true;
pendingSendBot._waitForResumeDialog = async () => true;
pendingSendBot._waitForResumeSent = async () => false;
pendingSendBot._invokeVueMethod = async () => {
  pendingSendVueCalls++;
  return { called: true };
};
const pendingSendResult = await pendingSendBot._confirmResumeDialog(
  { evaluate: async () => true },
  "周礼洋简历.pdf",
  []
);
assert(pendingSendResult === false, "发送请求已生效但无强证据 -> 返回未确认");
assert(pendingSendVueCalls === 0, "发送请求已生效时不调用 Vue 兜底");

const selectedRowFakePage = {
  evaluate: async (fn, ...args) => {
    if (args.length > 0 && typeof args[0] === "string") {
      return { hasChatArea: false, chatAreaText: "", pendingChip: false, pendingFile: false };
    }
    return ["周礼洋简历.pdf"];
  },
};
const selectedRowFake = await resumeDialogBot._selectedResumeSent(
  selectedRowFakePage,
  "resume.pdf",
  ["周礼洋简历.pdf"]
);
assert(selectedRowFake === true, "_selectedResumeSent 能识别当前选中会话最后一条简历文件");

const chatNonEmptyPage = {
  evaluate: async (fn, ...args) => {
    if (args.length > 0 && typeof args[0] === "string") {
      return { hasChatArea: true, chatAreaText: "你好，方便聊一下吗", pendingChip: false, pendingFile: false };
    }
    return ["周礼洋简历.pdf"];
  },
};
const chatNonEmptySelected = await resumeDialogBot._selectedResumeSent(
  chatNonEmptyPage,
  "resume.pdf",
  ["周礼洋简历.pdf"]
);
assert(chatNonEmptySelected === false, "聊天区非空但选中行是简历文件 -> 不以选中行判 already_sent");

const pendingChipPage = {
  evaluate: async (fn, ...args) => {
    if (args.length > 0 && typeof args[0] === "string") {
      return { hasChatArea: false, chatAreaText: "", pendingChip: true, pendingFile: false };
    }
    return ["周礼洋简历.pdf"];
  },
};
const pendingChipSelected = await resumeDialogBot._selectedResumeSent(
  pendingChipPage,
  "resume.pdf",
  ["周礼洋简历.pdf"]
);
assert(pendingChipSelected === false, "pending chip 残留时不使用选中行兜底");

const outsideSelected = {
  getClientRects: () => [{}],
  querySelector: () => null,
  querySelectorAll: () => [],
  innerText: "周礼洋简历.pdf",
  __vue__: null,
  __vueParentComponent: null,
  parentElement: null,
};
const listContainer = {
  getClientRects: () => [{}],
  querySelector: () => null,
  querySelectorAll: () => [],
  innerText: "",
  __vue__: null,
  __vueParentComponent: null,
  parentElement: null,
};
const fakeDoc = {
  querySelectorAll: (sel) => {
    if (
      sel === ".user-list-content" ||
      sel === "[class*='user-list']" ||
      sel === "[class*='session-list']" ||
      sel === "[class*='chat-list']" ||
      sel === "[class*='conversation-list']" ||
      sel === "[class*='friend-list']" ||
      sel === "[class*='contact-list']"
    ) {
      return [listContainer];
    }
    if (sel.includes(".selected")) return [outsideSelected];
    return [];
  },
};
const scopePage = {
  evaluate: async (fn) => {
    const prev = global.document;
    global.document = fakeDoc;
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete global.document;
      else global.document = prev;
    }
  },
};
const scopedTexts = await resumeDialogBot._collectSelectedResumeLastText(scopePage);
assert(!scopedTexts.includes("周礼洋简历.pdf"), "非会话容器残留 .selected 不参与判断");

console.log("[chatApply] _sendResumeForChat 发送与重试");
const sendResumeChatBot = new AutoApplyBot({});
sendResumeChatBot.running = true;
sendResumeChatBot.generation = 9;
sendResumeChatBot._getPage = async () => ({});
sendResumeChatBot._navigateToChat = async () => {};
sendResumeChatBot._selectChatRow = async () => true;
let sendResumeChatCalls = 0;
sendResumeChatBot._sendResume = async () => {
  sendResumeChatCalls++;
  return { ok: true, reason: "already_sent", fileName: "周礼洋简历.pdf" };
};
const sendResumeChatResult = await sendResumeChatBot._sendResumeForChat(
  { name: "HR", company: "A公司" },
  { filePath: "fake.pdf", name: "周礼洋简历.pdf" },
  { generation: 9, sendResumeScreenshot: false }
);
assert(sendResumeChatResult?.ok === true && sendResumeChatResult?.reason === "already_sent", "已发送时 _sendResumeForChat 返回 already_sent");
assert(sendResumeChatCalls === 1, "已发送时不重复调用 _sendResume");

const retryResumeBot = new AutoApplyBot({});
retryResumeBot.running = true;
retryResumeBot.generation = 10;
retryResumeBot._getPage = async () => ({});
retryResumeBot._navigateToChat = async () => {};
retryResumeBot._selectChatRow = async () => true;
let retryResumeCalls = 0;
retryResumeBot._sendResume = async () => {
  retryResumeCalls++;
  return { ok: false, reason: "resume_unavailable", fileName: "周礼洋简历.pdf" };
};
const retryResumeResult = await retryResumeBot._sendResumeForChat(
  { name: "HR", company: "A公司" },
  { filePath: "fake.pdf", name: "周礼洋简历.pdf" },
  { generation: 10, sendResumeScreenshot: false, retryDelayMin: 1, retryDelayMax: 2 }
);
assert(retryResumeResult?.ok === false && retryResumeResult?.reason === "resume_unavailable", "resume_unavailable 重试一次后仍返回原状态");
assert(retryResumeCalls === 2, "resume_unavailable 会重试一次");

const stoppedResumeBot = new AutoApplyBot({});
stoppedResumeBot.running = false;
stoppedResumeBot.generation = 11;
stoppedResumeBot._getPage = async () => ({});
stoppedResumeBot._navigateToChat = async () => {};
stoppedResumeBot._selectChatRow = async () => true;
let stoppedResumeCalls = 0;
stoppedResumeBot._sendResume = async () => {
  stoppedResumeCalls++;
  return { ok: true, reason: "already_sent" };
};
const stoppedResumeResult = await stoppedResumeBot._sendResumeForChat(
  { name: "HR", company: "A公司" },
  { filePath: "fake.pdf", name: "周礼洋简历.pdf" },
  { generation: 11, sendResumeScreenshot: false }
);
assert(stoppedResumeResult?.ok === false && stoppedResumeResult?.reason === "stopped", "停止时不继续发送简历");
assert(stoppedResumeCalls === 0, "停止时不调用 _sendResume");

const persistCompany = companyDb.create({ name: "持久化公司" });
const persistJob = jobDb.create({
  title: "持久化职位",
  url: `https://persist-${Date.now()}.example/job`,
  companyId: persistCompany.id,
});
const persistApp = applicationDb.create({
  jobId: persistJob.id,
  status: "pending",
  notes: "打招呼-复核通过",
});
const persistResumeBot = new AutoApplyBot({});
persistResumeBot.running = true;
persistResumeBot.generation = 12;
persistResumeBot._getPage = async () => ({});
persistResumeBot._navigateToChat = async () => {};
persistResumeBot._selectChatRow = async () => true;
let persistResumeCalls = 0;
persistResumeBot._sendResume = async () => {
  persistResumeCalls++;
  return { ok: true, reason: "sent", fileName: "周礼洋简历.pdf" };
};
const persistChat = { name: persistCompany.name, rowId: "persist-row" };
const persistResult = await persistResumeBot._sendResumeForChat(
  persistChat,
  { filePath: "fake.pdf", name: "周礼洋简历.pdf" },
  { generation: 12, sendResumeScreenshot: false }
);
const persistedApp = applicationDb.findById(persistApp.id);
assert(persistResult?.ok === true, "_sendResumeForChat 成功发送后返回 ok");
assert(persistedApp.notes.includes("简历-已发送"), "_sendResumeForChat 成功会把 Application notes 追加简历-已发送");
assert(chatState.shouldTryResume(persistChat) === false, "_sendResumeForChat 成功后 chatState 不再允许重试");
assert(persistResumeCalls === 1, "持久化成功后只发送一次");

let emptySelectCalls = 0;
const emptyChatBot = new AutoApplyBot({});
emptyChatBot.running = true;
emptyChatBot.generation = 13;
emptyChatBot._getPage = async () => ({});
emptyChatBot._navigateToChat = async () => {};
emptyChatBot._collectCurrentChatIdentity = async () => null;
emptyChatBot._selectChatRow = async () => {
  emptySelectCalls++;
  return true;
};
emptyChatBot._sendResume = async () => ({ ok: false, reason: "no_file" });
const emptyChatResult = await emptyChatBot._sendResumeForChat(
  {},
  { filePath: "fake.pdf", name: "周礼洋简历.pdf" },
  { generation: 13, sendResumeScreenshot: false }
);
assert(emptySelectCalls === 0, "manual-hr 为空时 _sendResumeForChat 不选择行，使用当前会话");
assert(emptyChatResult?.ok === false && emptyChatResult?.reason === "no_file", "空会话身份仍继续调用发送逻辑");

console.log("[chatApply] _findApplicationForChat 同公司多 Application 精确匹配");
const multiCompany = companyDb.create({ name: `精确公司-${Date.now()}` });
const multiBoss1 = `BOSS_MULTI_1_${Date.now()}`;
const multiBoss2 = `BOSS_MULTI_2_${Date.now()}`;
const multiJob1 = jobDb.create({
  title: "同公司职位1",
  url: `https://www.zhipin.com/job_detail/${multiBoss1}.html`,
  companyId: multiCompany.id,
});
const multiJob2 = jobDb.create({
  title: "同公司职位2",
  url: `https://www.zhipin.com/job_detail/${multiBoss2}.html`,
  companyId: multiCompany.id,
});
const multiApp1 = applicationDb.create({
  jobId: multiJob1.id,
  status: "pending",
  notes: "应用1",
});
const multiApp2 = applicationDb.create({
  jobId: multiJob2.id,
  status: "pending",
  notes: "应用2",
});
const findApplicationBot = new AutoApplyBot({});
const exactByHref = findApplicationBot._findApplicationForChat({
  href: `/web/geek/chat?id=1&jobId=${multiBoss2}`,
  name: multiCompany.name,
});
const exactByRowId = findApplicationBot._findApplicationForChat({
  rowId: String(multiJob2.id),
});
const exactByTitle = findApplicationBot._findApplicationForChat({
  name: multiCompany.name,
  jobTitle: "同公司职位2",
});
assert(exactByHref?.id === multiApp2.id, "chat.href 的 jobId 优先精确匹配 Application");
assert(exactByRowId?.id === multiApp2.id, "chat.rowId 为数字时按 jobId 精确匹配 Application");
assert(exactByTitle?.id === multiApp2.id, "同公司下 chat.jobTitle 优先匹配对应职位 Application");
findApplicationBot._persistResumeSentForChat(
  { href: `/web/geek/chat?id=1&jobId=${multiBoss2}` },
  { ok: true }
);
const multiApp1After = applicationDb.findById(multiApp1.id);
const multiApp2After = applicationDb.findById(multiApp2.id);
assert(!String(multiApp1After.notes || "").includes("简历-已发送"), "同公司另一个 Application 不串写");
assert(String(multiApp2After.notes || "").includes("简历-已发送"), "按 jobId 精确匹配的 Application 才写简历-已发送");

console.log("[chatApply] _findApplicationForChat 无公司信息不跨公司匹配");
const crossCompanyA = companyDb.create({ name: `跨公司A-${Date.now()}` });
const crossCompanyB = companyDb.create({ name: `跨公司B-${Date.now()}` });
const crossJobA = jobDb.create({
  title: "软件工程师",
  url: `https://www.zhipin.com/job_detail/BOSS_CROSS_A_${Date.now()}.html`,
  companyId: crossCompanyA.id,
});
const crossJobB = jobDb.create({
  title: "软件工程师",
  url: `https://www.zhipin.com/job_detail/BOSS_CROSS_B_${Date.now()}.html`,
  companyId: crossCompanyB.id,
});
applicationDb.create({ jobId: crossJobA.id, status: "pending", notes: "跨公司A" });
applicationDb.create({ jobId: crossJobB.id, status: "pending", notes: "跨公司B" });
const crossCompanyBot = new AutoApplyBot({});
const noCompanyTitleMatch = crossCompanyBot._findApplicationForChat({ jobTitle: "软件工程师" });
assert(noCompanyTitleMatch == null, "只有 jobTitle、没有公司/姓名时不跨公司串写");

console.log("[chatApply] _findApplicationForChat 数字 rowId 优先本地 jobId");
const numericCompany = companyDb.create({ name: `数字rowId公司-${Date.now()}` });
const numericLocalJob = jobDb.create({
  title: "数字本地职位",
  url: `https://www.zhipin.com/job_detail/BOSS_NUMERIC_LOCAL_${Date.now()}.html`,
  companyId: numericCompany.id,
});
const numericLocalApp = applicationDb.create({
  jobId: numericLocalJob.id,
  status: "pending",
  notes: "数字本地应用",
});
const numericCollisionJob = jobDb.create({
  title: "数字碰撞职位",
  url: `https://www.zhipin.com/job_detail/${numericLocalJob.id}.html`,
  companyId: numericCompany.id,
});
const numericCollisionApp = applicationDb.create({
  jobId: numericCollisionJob.id,
  status: "pending",
  notes: "数字碰撞应用",
});
const numericMatch = crossCompanyBot._findApplicationForChat({ rowId: String(numericLocalJob.id) });
assert(numericMatch?.id === numericLocalApp.id, "数字 rowId 优先本地 Application.jobId，不串到 URL 碰撞应用");

console.log("[chatApply] _scanChatSessions 排除当前聊天面板");
const scanLeftRow = {
  offsetParent: {},
  getClientRects: () => [{}],
  className: "left-session-row",
  innerText: "王经理 扫描公司 你好",
  getAttribute: (attr) => (attr === "data-id" ? "row-scan-1" : null),
  querySelector: (sel) => {
    if (sel === ".name-text") return { textContent: "王经理" };
    if (sel === ".name-box") return { children: [{}, { textContent: "扫描公司" }] };
    if (sel === ".last-msg-text" || sel === "[class*='last-msg']") return { textContent: "你好" };
    if (sel === "[class*='badge'], [class*='num']") return { textContent: "2" };
    if (sel === "a[href]") return { getAttribute: () => "/web/geek/chat?id=scan" };
    return null;
  },
  closest: () => null,
};
const scanConversationPanel = {
  offsetParent: {},
  getClientRects: () => [{}],
  className: "chat-conversation",
  innerText: "王经理 扫描公司 这是一整段聊天内容，不能被当成会话扫描",
  getAttribute: () => null,
  querySelector: (sel) => {
    if (sel === ".name-text") return { textContent: "王经理" };
    if (sel === ".name-box") return { children: [{}, { textContent: "扫描公司" }] };
    if (sel === ".last-msg-text" || sel === "[class*='message']") return { textContent: "这是一整段聊天内容" };
    return null;
  },
  closest: () => null,
};
const scanDoc = {
  querySelectorAll: () => [scanLeftRow, scanConversationPanel],
};
const scanPage = {
  url: () => "/web/geek/chat",
  evaluate: async (fn) => {
    const prev = global.document;
    global.document = scanDoc;
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete global.document;
      else global.document = prev;
    }
  },
};
const scanBot = new AutoApplyBot({});
scanBot._getPage = async () => scanPage;
scanBot._navigateToChat = async () => {};
scanBot._humanWait = async () => {};
const scanRows = await scanBot._scanChatSessions(true);
assert(scanRows.length === 1 && scanRows[0]?.rowId === "row-scan-1", "同时存在左侧会话和当前聊天面板时只扫描左侧会话");
assert(!scanRows.some((r) => String(r.text || "").includes("一整段")), "当前聊天面板内容不会被当作会话消息");

console.log("[chatApply] _scanChatSessions 保留 conversation-item 排除当前聊天面板");
const scanConversationItem = {
  offsetParent: {},
  getClientRects: () => [{}],
  className: "conversation-item",
  innerText: "李经理 会话公司 你好",
  getAttribute: (attr) => (attr === "data-id" ? "row-conv-1" : null),
  querySelector: (sel) => {
    if (sel === ".name-text") return { textContent: "李经理" };
    if (sel === ".name-box") return { children: [{}, { textContent: "会话公司" }] };
    if (sel === ".last-msg-text" || sel === "[class*='last-msg']") return { textContent: "你好" };
    if (sel === "[class*='badge'], [class*='num']") return { textContent: "1" };
    if (sel === "a[href]") return { getAttribute: () => "/web/geek/chat?id=conv" };
    return null;
  },
  closest: () => null,
};
const scanCurrentConversation = {
  offsetParent: {},
  getClientRects: () => [{}],
  className: "chat-conversation",
  innerText: "李经理 会话公司 当前聊天内容不能扫描",
  getAttribute: () => null,
  querySelector: (sel) => {
    if (sel === ".name-text") return { textContent: "李经理" };
    if (sel === ".name-box") return { children: [{}, { textContent: "会话公司" }] };
    if (sel === ".last-msg-text" || sel === "[class*='message']") return { textContent: "当前聊天内容不能扫描" };
    return null;
  },
  closest: () => null,
};
const scanConversationList = {
  offsetParent: {},
  getClientRects: () => [{}],
  className: "conversation-list",
  innerText: "李经理 会话公司 列表容器不能扫描",
  getAttribute: () => null,
  querySelector: (sel) => {
    if (sel === ".name-text") return { textContent: "李经理" };
    if (sel === ".name-box") return { children: [{}, { textContent: "会话公司" }] };
    if (sel === ".last-msg-text" || sel === "[class*='message']") return { textContent: "列表容器不能扫描" };
    return null;
  },
  closest: () => null,
};
const scanConversationDoc = {
  querySelectorAll: () => [scanConversationList, scanConversationItem, scanCurrentConversation],
};
const scanConversationPage = {
  url: () => "/web/geek/chat",
  evaluate: async (fn) => {
    const prev = global.document;
    global.document = scanConversationDoc;
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete global.document;
      else global.document = prev;
    }
  },
};
const scanConversationBot = new AutoApplyBot({});
scanConversationBot._getPage = async () => scanConversationPage;
scanConversationBot._navigateToChat = async () => {};
scanConversationBot._humanWait = async () => {};
const scanConversationRows = await scanConversationBot._scanChatSessions(true);
assert(scanConversationRows.length === 1 && scanConversationRows[0]?.rowId === "row-conv-1", "div.conversation-item 会被扫描");
assert(!scanConversationRows.some((r) => String(r.text || "").includes("当前聊天内容")), "当前 .chat-conversation 不被扫描");
assert(!scanConversationRows.some((r) => String(r.text || "").includes("列表容器")), "conversation-list 容器不被扫描");

console.log("[chatApply] _confirmResumeUpload 中途 stop");
const uploadStopBot = new AutoApplyBot({});
uploadStopBot.running = true;
uploadStopBot.generation = 20;
let uploadCollectCalls = 0;
let uploadClickCalls = 0;
uploadStopBot._collectResumeState = async () => {
  uploadCollectCalls++;
  uploadStopBot.running = false;
  return { confirmVisible: true, confirmDisabled: false };
};
uploadStopBot._clickResumeConfirm = async () => {
  uploadClickCalls++;
  return true;
};
const uploadStopResult = await uploadStopBot._confirmResumeUpload(
  {},
  "周礼洋简历.pdf",
  { generation: 20 }
);
assert(uploadStopResult?.stopped === true && uploadStopResult?.reason === "stopped", "旧附件上传路径中途 stop 返回 stopped");
assert(uploadClickCalls === 0, "旧附件上传路径 stop 后不再点击确认/发送");
assert(uploadCollectCalls === 1, "旧附件上传路径轮询开始后至少检查一次");

console.log("[chatApply] _selectChatRow 点击内部会话内容");
let friendClicks = 0;
let chatLiClicks = 0;
const friendContent = {
  offsetParent: {},
  getClientRects: () => [{}],
  click: () => { friendClicks++; },
};
const chatLi = {
  offsetParent: {},
  getClientRects: () => [{}],
  getAttribute: () => null,
  innerText: "HR 某公司 你好",
  querySelector: (sel) => (sel === "a[href]" ? null : null),
  querySelectorAll: (sel) => {
    if (sel.includes("friend-content") || sel.includes("d-c")) return [friendContent];
    return [];
  },
  click: () => { chatLiClicks++; },
};
const selectDoc = {
  querySelectorAll: (sel) => (sel.includes("listitem") ? [chatLi] : []),
};
const selectPage = {
  evaluate: async (fn, ...args) => {
    const prev = global.document;
    global.document = selectDoc;
    try {
      return await fn(...args);
    } finally {
      if (prev === undefined) delete global.document;
      else global.document = prev;
    }
  },
};
const selectRowBot = new AutoApplyBot({});
const selectRowResult = await selectRowBot._selectChatRow(selectPage, { name: "HR" });
assert(selectRowResult === true, "_selectChatRow 能找到匹配会话");
assert(friendClicks === 1 && chatLiClicks === 0, "存在 .friend-content 时点击内部元素而不是 li");

console.log("[chatApply] _selectChatRow 支持 conversation-item");
let convFriendClicks = 0;
let convItemClicks = 0;
let listFriendClicks = 0;
let listContainerClicks = 0;
const convFriendContent = {
  offsetParent: {},
  getClientRects: () => [{}],
  click: () => { convFriendClicks++; },
};
const listFriendContent = {
  offsetParent: {},
  getClientRects: () => [{}],
  click: () => { listFriendClicks++; },
};
const conversationItem = {
  offsetParent: {},
  getClientRects: () => [{}],
  className: "conversation-item",
  innerText: "李经理 会话公司 你好",
  getAttribute: () => null,
  querySelector: (sel) => (sel === "a[href]" ? { getAttribute: () => "/web/geek/chat?id=conv" } : null),
  querySelectorAll: (sel) => {
    if (sel.includes("friend-content") || sel.includes("d-c")) return [convFriendContent];
    return [];
  },
  closest: () => null,
  click: () => { convItemClicks++; },
};
const conversationListContainer = {
  offsetParent: {},
  getClientRects: () => [{}],
  className: "conversation-list",
  innerText: "李经理 会话公司 列表容器",
  getAttribute: () => null,
  querySelector: (sel) => (sel === "a[href]" ? { getAttribute: () => "/web/geek/chat?id=conv-list" } : null),
  querySelectorAll: (sel) => {
    if (sel.includes("friend-content") || sel.includes("d-c")) return [listFriendContent];
    return [];
  },
  closest: () => null,
  click: () => { listContainerClicks++; },
};
const convSelectDoc = {
  querySelectorAll: (sel) => (sel.includes("conversation") ? [conversationListContainer, conversationItem] : []),
};
const convSelectPage = {
  evaluate: async (fn, ...args) => {
    const prev = global.document;
    global.document = convSelectDoc;
    try {
      return await fn(...args);
    } finally {
      if (prev === undefined) delete global.document;
      else global.document = prev;
    }
  },
};
const convSelectBot = new AutoApplyBot({});
const convSelectResult = await convSelectBot._selectChatRow(convSelectPage, { name: "李经理" });
assert(convSelectResult === true, "_selectChatRow 能通过 conversation-item 找到会话");
assert(convFriendClicks === 1 && convItemClicks === 0 && listFriendClicks === 0 && listContainerClicks === 0, "conversation-item 存在内部 .friend-content 时点击内部元素，不点击容器");

console.log("[chatApply] _selectChatRow 跳过当前聊天面板");
let panelFriendClicks = 0;
let panelClicks = 0;
const panelFriendContent = {
  offsetParent: {},
  getClientRects: () => [{}],
  click: () => { panelFriendClicks++; },
};
const currentPanelRow = {
  offsetParent: {},
  getClientRects: () => [{}],
  className: "chat-conversation",
  innerText: "王经理 面板公司 面板聊天",
  getAttribute: () => null,
  querySelector: (sel) => (sel === "a[href]" ? { getAttribute: () => "/web/geek/chat?id=panel" } : null),
  querySelectorAll: (sel) => {
    if (sel.includes("friend-content") || sel.includes("d-c")) return [panelFriendContent];
    return [];
  },
  closest: () => null,
  click: () => { panelClicks++; },
};
const panelDoc = {
  querySelectorAll: () => [currentPanelRow],
};
const panelPage = {
  evaluate: async (fn, ...args) => {
    const prev = global.document;
    global.document = panelDoc;
    try {
      return await fn(...args);
    } finally {
      if (prev === undefined) delete global.document;
      else global.document = prev;
    }
  },
};
const panelBot = new AutoApplyBot({});
const panelResult = await panelBot._selectChatRow(panelPage, { name: "王经理" });
assert(panelResult === false, "_selectChatRow 不把当前 .chat-conversation 当会话");
assert(panelFriendClicks === 0 && panelClicks === 0, "当前聊天面板不会被点击");

console.log("[chatApply] _collectCurrentChatIdentity 当前会话身份采集");
const identityConversation = {
  getClientRects: () => [{}],
  querySelector: (sel) => {
    if (sel === ".name-text") return { textContent: "李经理" };
    if (sel === ".user-info") return { textContent: "某公司" };
    if (sel === ".position-name") return { textContent: "Java开发" };
    return null;
  },
};
const identityDoc = {
  querySelector: (sel) => (sel === ".chat-conversation" ? identityConversation : null),
};
const identityPage = {
  evaluate: async (fn) => {
    const prev = global.document;
    global.document = identityDoc;
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete global.document;
      else global.document = prev;
    }
  },
};
const identityBot = new AutoApplyBot({});
const currentIdentity = await identityBot._collectCurrentChatIdentity(identityPage);
assert(currentIdentity?.name === "李经理" && currentIdentity?.company === "某公司" && currentIdentity?.jobTitle === "Java开发", "能从 chat-conversation 提取 name/company/jobTitle");

const jobTitleOnlyConversation = {
  getClientRects: () => [{}],
  querySelector: (sel) => {
    if (sel === ".name-text") return { textContent: "" };
    if (sel === ".user-info") return { textContent: "" };
    if (sel === ".position-name") return { textContent: "Java开发" };
    return null;
  },
};
const jobTitleOnlyDoc = {
  querySelector: (sel) => (sel === ".chat-conversation" ? jobTitleOnlyConversation : null),
};
const jobTitleOnlyPage = {
  evaluate: async (fn) => {
    const prev = global.document;
    global.document = jobTitleOnlyDoc;
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete global.document;
      else global.document = prev;
    }
  },
};
const jobTitleOnlyIdentity = await identityBot._collectCurrentChatIdentity(jobTitleOnlyPage);
assert(jobTitleOnlyIdentity === null, "只有 jobTitle、没有 name/company 时返回 null");

const currentCompany = companyDb.create({ name: `当前会话公司-${Date.now()}` });
const currentJob = jobDb.create({
  title: "当前会话职位",
  url: `https://www.zhipin.com/job_detail/BOSS_CURRENT_${Date.now()}.html`,
  companyId: currentCompany.id,
});
const currentApp = applicationDb.create({
  jobId: currentJob.id,
  status: "pending",
  notes: "当前会话",
});
const currentIdentityBot = new AutoApplyBot({});
currentIdentityBot.running = true;
currentIdentityBot.generation = 30;
currentIdentityBot._getPage = async () => ({});
currentIdentityBot._navigateToChat = async () => {};
let currentSelectCalls = 0;
currentIdentityBot._selectChatRow = async () => {
  currentSelectCalls++;
  return true;
};
currentIdentityBot._collectCurrentChatIdentity = async () => ({
  name: `当前HR-${Date.now()}`,
  company: currentCompany.name,
  jobTitle: currentJob.title,
});
let currentResumeCalls = 0;
currentIdentityBot._sendResume = async () => {
  currentResumeCalls++;
  return { ok: true, reason: "sent", fileName: "周礼洋简历.pdf" };
};
const currentEmptyChat = {};
const currentResult = await currentIdentityBot._sendResumeForChat(
  currentEmptyChat,
  { filePath: "fake.pdf", name: "周礼洋简历.pdf" },
  { generation: 30, sendResumeScreenshot: false }
);
const currentAppAfter = applicationDb.findById(currentApp.id);
assert(currentResult?.ok === true, "空 chat 读取当前会话身份后仍能发送成功");
assert(currentSelectCalls === 0, "空 chat 不重复选择行，直接使用当前会话");
assert(String(currentAppAfter.notes || "").includes("简历-已发送"), "空 chat 发送成功会持久化到正确 Application");
assert(currentResumeCalls === 1, "空 chat 当前会话发送只执行一次");

console.log("[chatApply] _sendResume 当前选中会话兜底");
const fakeResumePath = path.join(os.tmpdir(), `job-agent-fake-resume-${process.pid}-${Date.now()}.pdf`);
fs.writeFileSync(fakeResumePath, "fake-pdf");
try {
  const alreadySentBot = new AutoApplyBot({});
  alreadySentBot.running = true;
  alreadySentBot._resumeSentMarker = async () => false;
  alreadySentBot._selectedResumeSent = async () => true;
  alreadySentBot._isResumeSendUnavailable = async () => true;
  alreadySentBot._isOnChatPage = async () => true;
  const alreadySentResult = await alreadySentBot._sendResume(
    {},
    { filePath: fakeResumePath, name: "周礼洋简历.pdf" }
  );
  assert(
    alreadySentResult?.ok === true && alreadySentResult?.reason === "already_sent",
    "聊天区空但当前选中行 lastText=周礼洋简历.pdf -> already_sent"
  );

  const unavailableBot = new AutoApplyBot({});
  unavailableBot.running = true;
  unavailableBot._resumeSentMarker = async () => false;
  unavailableBot._selectedResumeSent = async () => false;
  unavailableBot._isResumeSendUnavailable = async () => true;
  unavailableBot._isOnChatPage = async () => true;
  const unavailableResult = await unavailableBot._sendResume(
    {},
    { filePath: fakeResumePath, name: "周礼洋简历.pdf" }
  );
  assert(
    unavailableResult?.ok === false && unavailableResult?.reason === "resume_unavailable",
    "聊天区空且当前选中行是普通消息 -> resume_unavailable"
  );

  const stopMidBot = new AutoApplyBot({});
  stopMidBot.running = true;
  stopMidBot._resumeSentMarker = async () => false;
  stopMidBot._selectedResumeSent = async () => false;
  stopMidBot._isResumeSendUnavailable = async () => false;
  stopMidBot._isOnChatPage = async () => true;
  stopMidBot._openResumeSendDialog = async () => {
    stopMidBot.running = false;
    return false;
  };
  const stopMidResult = await stopMidBot._sendResume(
    {},
    { filePath: fakeResumePath, name: "周礼洋简历.pdf" }
  );
  assert(stopMidResult?.ok === false && stopMidResult?.reason === "stopped", "发送中途 stop/restart 后 _sendResume 返回 stopped");
} finally {
  try { fs.unlinkSync(fakeResumePath); } catch (e) {}
}

let ignoreWaitChecks = 0;
const ignoreWaitSent = await resumeDialogBot._waitForResumeSent({
  evaluate: async () => {
    ignoreWaitChecks++;
    return {
      hasFileName: true,
      hasStrongResumeMarker: true,
      hasRequestMarker: true,
      pendingFile: false,
      pendingChip: false,
      confirmVisible: true,
    };
  },
}, "周礼洋简历.pdf", 1000, [], { ignoreConfirmVisible: true });
assert(ignoreWaitSent === true, "_waitForResumeSent 支持 ignoreConfirmVisible，弹窗仍打开也可判强成功");
assert(ignoreWaitChecks >= 1, "_waitForResumeSent ignoreConfirmVisible 至少检查一次");

const defaultWaitBlocked = await resumeDialogBot._waitForResumeSent({
  evaluate: async () => ({
    hasFileName: true,
    hasStrongResumeMarker: true,
    hasRequestMarker: true,
    pendingFile: false,
    pendingChip: false,
    confirmVisible: true,
  }),
}, "周礼洋简历.pdf", 50, []);
assert(defaultWaitBlocked === false, "默认等待仍要求弹窗关闭，避免误判");

const noDialog = await resumeDialogBot._sendResumeViaDialog(
  { evaluate: async () => false },
  null,
  "周礼洋简历.pdf"
);
assert(noDialog?.ok === false && noDialog?.reason === "no_dialog", "发简历弹窗未打开时返回 no_dialog，不进入普通发送");

let selectArgs = null;
const noPdf = await resumeDialogBot._selectResumeFromDialog(
  {
    evaluate: async (...args) => {
      selectArgs = args;
      return { found: false, noPdf: true };
    },
  },
  null,
  "周礼洋简历.pdf"
);
assert(noPdf?.ok === false && noPdf?.reason === "no_pdf", "无 PDF 简历项时返回 no_pdf，不回退第一个简历项");
assert(Array.isArray(selectArgs[1]) && selectArgs[1].some((s) => s === ".choose-resume-dialog"), "选择 PDF 时传入 active 弹窗根选择器");
assert(selectArgs[2] === ".resume-list li.list-item", "PDF 查询限定在弹窗内 .resume-list li.list-item");

console.log("[chatApply] isFatalBrowserError 致命错误判定");
// 致命：浏览器/CDP 连接断开、页面或目标关闭，之后任何页面操作都不可能成功，应终止监控
assert(isFatalBrowserError({ message: "浏览器未连接" }) === true, "浏览器未连接 -> 致命");
assert(isFatalBrowserError("页面已关闭") === true, "页面已关闭 -> 致命");
assert(isFatalBrowserError("目标已关闭") === true, "目标已关闭 -> 致命");
assert(isFatalBrowserError({ message: "Page closed" }) === true, "Page closed -> 致命");
assert(isFatalBrowserError("target closed") === true, "target closed -> 致命");
assert(isFatalBrowserError("browser has been disconnected") === true, "browser disconnected -> 致命");
assert(isFatalBrowserError({ message: "Error: browser has been disconnected" }) === true, "对象 message 携带 disconnected -> 致命");
assert(isFatalBrowserError("connection closed") === true, "connection closed -> 致命");
assert(isFatalBrowserError("Target page, context or browser has been closed") === true, "has been closed -> 致命");
assert(isFatalBrowserError("Page closed while navigating") === true, "page closed 变体 -> 致命");
// 非致命：普通 DOM/渲染抖动错误仍可恢复，不应终止监控
// "Execution context was destroyed" 是页面导航导致的上下文销毁，属正常页面转换，
// 页面本身仍可用，不能当作致命错误终止监控。
assert(isFatalBrowserError("element not found") === false, "element not found -> 非致命");
assert(isFatalBrowserError("Execution context was destroyed, most likely because of a navigation.") === false, "context destroyed（页面导航）-> 非致命");
assert(isFatalBrowserError("timeout waiting for selector") === false, "选择器超时 -> 非致命");
assert(isFatalBrowserError() === false, "空参数 -> 非致命");
assert(isFatalBrowserError(null) === false, "null -> 非致命");
assert(isFatalBrowserError("") === false, "空字符串 -> 非致命");

console.log("[chatApply] isGenerationCurrent 代际有效性判定");
// 手动回复（/api/chat/send 不传 generation）不受代际约束：即使 stop 后旧 sendReply 仍在执行，
// 新手动回复只要通过 busy 锁（含 b._checking）即可放行，无需代际校验。
assert(isGenerationCurrent(false, undefined, 3) === true, "expected=undefined -> 恒为 true（手动回复）");
assert(isGenerationCurrent(false, null, 3) === true, "expected=null -> 恒为 true（手动回复）");
// 自动回复（传入 generation）：必须 running 且 expected === current 才算当前代有效
assert(isGenerationCurrent(false, 2, 2) === false, "running=false -> false");
assert(isGenerationCurrent(true, 1, 2) === false, "expected !== current -> false");
assert(isGenerationCurrent(true, 2, 2) === true, "running=true 且代际相等 -> true");

console.log("[chatApply] isResumeFileAccept 简历输入框 accept 判定");
// 真实 BOSS 聊天页第一个可见文件输入框是图片（accept 只含 image），必须按 accept 区分简历输入框
assert(isResumeFileAccept("image/*") === false, "图片输入框（image/*）-> 非简历");
assert(isResumeFileAccept("image/jpeg,image/png") === false, "图片输入框（jpeg/png）-> 非简历");
assert(isResumeFileAccept("application/pdf") === true, "pdf -> 简历");
assert(isResumeFileAccept(".pdf,.doc,.docx") === true, ".pdf/.doc/.docx -> 简历");
assert(isResumeFileAccept("application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document") === true, "msword/document -> 简历");
assert(isResumeFileAccept("") === false, "空 accept -> 非简历（避免误选）");
assert(isResumeFileAccept(null) === false, "null accept -> 非简历");
assert(isResumeFileAccept("PDF, DOC") === true, "大写 accept 归一化后仍识别");

console.log("[chatApply] resolveRedirectUrl redirect-url 绝对化");
assert(resolveRedirectUrl("/web/geek/chat?id=123", "https://www.zhipin.com/web/geek/job/123.html") === "https://www.zhipin.com/web/geek/chat?id=123", "相对路径基于职位页 URL 绝对化");
assert(resolveRedirectUrl("https://www.zhipin.com/web/geek/chat?id=456", "https://www.zhipin.com/") === "https://www.zhipin.com/web/geek/chat?id=456", "绝对 URL 原样保留");
assert(resolveRedirectUrl("", "https://www.zhipin.com/") === "", "空 redirect-url -> 空串");
assert(resolveRedirectUrl("/chat?x=1", "https://www.zhipin.com/web/geek/jobs/") === "https://www.zhipin.com/chat?x=1", "相对路径按目录规则解析");

console.log("[chatApply] isStartChatApiSuccess startchat 接口成功判定");
// 真实环境 GET data-url 返回 code=0；非 JSON 响应（登录页 HTML）不能误判成功
assert(isStartChatApiSuccess({ code: 0 }) === true, "code=0 -> 成功");
assert(isStartChatApiSuccess({ code: "0" }) === true, "code='0' -> 成功");
assert(isStartChatApiSuccess({ code: 1001 }) === false, "code 非 0 -> 失败");
assert(isStartChatApiSuccess({}) === false, "无 code -> 失败");
assert(isStartChatApiSuccess(null) === false, "null（非 JSON 响应）-> 失败");
assert(isStartChatApiSuccess(undefined) === false, "undefined -> 失败");

console.log("[chatApply] resolveChatStartPlan 开启会话路径");
assert(resolveChatStartPlan({ hasRedirectUrl: true, hasDataUrl: true }) === "api_first", "有 data-url 时优先 API，不直接 goto");
assert(resolveChatStartPlan({ hasRedirectUrl: false, hasDataUrl: true }) === "api_first", "仅有 data-url -> 走 API");
assert(resolveChatStartPlan({ hasRedirectUrl: true, hasDataUrl: false }) === "direct_goto", "无 data-url 有 redirect-url -> 才直接 goto");
assert(resolveChatStartPlan({ hasRedirectUrl: false, hasDataUrl: false }) === CHAT_NOT_READY, "两者都无 -> chat_not_ready");

console.log("[chatApply] isJobDetailReady 职位详情兜底判断");
assert(isJobDetailReady({ isJobDetail: false, hasStartChat: true }) === false, "城市首页出现 startchat 但不能单独通过");
assert(isJobDetailReady({ isJobDetail: true, hasStartChat: false }) === true, "职位详情且有立即沟通 -> 可继续");
assert(isJobDetailReady(null) === false, "空详情状态 -> 不可继续");

const homePageBot = new AutoApplyBot({});
homePageBot.running = true;
homePageBot._getPage = async () => ({
  goto: async () => {},
  waitForSelector: async () => {},
  screenshot: async () => ({}),
});
homePageBot._humanWait = async () => {};
homePageBot._collectJobDetailState = async () => ({ isJobDetail: false, hasStartChat: true });
const homePageResult = await homePageBot.autoApply(
  [{ title: "城市首页误判职位", url: "https://www.zhipin.com/web/geek/jobs" }],
  { delayMin: 1, delayMax: 2 }
);
assert(homePageResult.failed === 1 && homePageResult.results[0].status === "page_not_ready", "城市首页有 startchat 按钮但 URL 非职位详情 -> autoApply 记为 page_not_ready");

console.log("[chatApply] startchat API 失败后重试");
const startRetryBot = new AutoApplyBot({});
let startApiCalls = 0;
const startRetryPage = {
  url: () => "https://www.zhipin.com/web/geek/job/123.html",
  goto: async () => {},
  evaluate: async (fn, ...args) => {
    if (args[0] && Array.isArray(args[0])) {
      return { txt: "立即沟通", dataUrl: "/wapi/start.json", redirectUrl: "/web/geek/chat?id=1", href: "" };
    }
    if (typeof args[0] === "string") {
      startApiCalls++;
      return startApiCalls > 1 ? { code: 0 } : false;
    }
    return false;
  },
};
startRetryBot._waitForChatReadyOrReload = async () => true;
startRetryBot._waitForChatAction = async () => false;
const startRetryResult = await startRetryBot._startChatWithJob(startRetryPage);
assert(startRetryResult === true, "startchat API 首次失败后重试成功");
assert(startApiCalls === 2, "startchat API 只重试一次后成功");

console.log("[chatApply] API+redirect 真实流程");
assert(resolveChatStartPlan({ hasDataUrl: true, hasRedirectUrl: true }) === "api_first", "API 成功后才会 goto redirect-url");
assert(isChatPageReady({ urlHasChat: true, hasChatArea: true, hasChatInput: false }) === true, "API+redirect 后出现具体消息区 -> 聊天页就绪");
assert(isChatActionEvidence({ hasChatArea: true, hasAppliedResumeMarker: true }) === true, "API+redirect 后出现在线投递动作证据");

console.log("[chatApply] isChatPageReady 空壳聊天页判定");
assert(isChatPageReady({ urlHasChat: true, hasChatArea: false, hasChatInput: false }) === false, "仅 URL 含 /chat 且 DOM 空壳 -> 未就绪");
assert(isChatPageReady({ urlHasChat: true, hasChatArea: true, hasChatInput: false }) === true, "URL 含 /chat 且出现消息区 -> 就绪");
assert(isChatPageReady({ urlHasChat: true, hasChatArea: false, hasChatInput: true }) === true, "URL 含 /chat 且出现聊天输入框 -> 就绪");
assert(isChatPageReady({ urlHasChat: false, hasChatArea: true, hasChatInput: true }) === false, "无 /chat URL 即使有聊天元素 -> 未就绪");
assert(isChatPageReady({ urlHasChat: false, hasChatArea: false, hasChatInput: false }) === false, "无 URL 且无 DOM -> 未就绪");

console.log("[chatApply] 空聊天列表占位与搜索输入框排除");
assert(CHAT_READY_AREA_SELECTORS.includes(".chat-conversation") === false, "空 .chat-conversation 占位不算具体消息区");
assert(isUsableChatInput({ className: "boss-search-input", type: "text" }) === false, ".boss-search-input 不是聊天输入框");
assert(isUsableChatInput({ className: "search-input", type: "search" }) === false, "搜索类型输入框不是聊天输入框");
assert(isUsableChatInput({ className: "chat-input", type: "text" }) === true, ".chat-input 是聊天输入框");
assert(isUsableChatInput({ className: "chat-editor", isContentEditable: true }) === true, ".chat-editor contenteditable 是聊天输入框");
assert(CHAT_INPUT_SELECTORS.every((s) => s.includes(":not([class*='search'])")), "聊天输入选择器均排除 search 输入框");

console.log("[chatApply] isChatActionReady 沟通动作证据判定");
assert(isChatActionReady({ hasDelivered: true }) === true, "送达证据 -> 动作已发生");
assert(isChatActionReady({ hasGreeted: true }) === true, "已沟通证据 -> 动作已发生");
assert(isChatActionReady({ hasAppliedResumeMarker: true }) === true, "在线简历投递证据 -> 动作已发生");
assert(isChatActionReady({ hasDelivered: false, hasGreeted: false, hasAppliedResumeMarker: false }) === false, "无任何动作证据 -> 未发生");
assert(isChatActionReady() === false, "空参数 -> 未发生");

console.log("[chatApply] isChatActionEvidence 仅当前会话具体消息区");
assert(isChatActionEvidence({ hasChatArea: true, hasDelivered: true }) === true, "具体消息区有送达证据 -> 动作已发生");
assert(isChatActionEvidence({ hasChatArea: true, hasGreeted: true }) === true, "具体消息区有已沟通证据 -> 动作已发生");
assert(isChatActionEvidence({ hasChatArea: true, hasAppliedResumeMarker: true }) === true, "具体消息区有在线投递证据 -> 动作已发生");
assert(isChatActionEvidence({ hasChatArea: false, hasDelivered: true }) === false, "左侧列表/无具体消息区的送达不能算当前会话动作");
assert(isChatActionEvidence({ hasChatArea: false, hasGreeted: true, hasAppliedResumeMarker: true }) === false, "无具体消息区时其它证据也不能算当前会话动作");
assert(isChatActionEvidence() === false, "空参数 -> 未发生");

console.log("[chatApply] 聊天页 ready 但无动作证据仍走手动流程");
assert(
  isChatActionEvidence({ hasChatArea: true }) === false &&
    resolveChatStartState(true).action === "proceed" &&
    resolveChatStartState(true).fallback === false,
  "chat ready 且无动作证据 -> 不返回 CHAT_NOT_READY，继续手动流程"
);

assert(CHAT_READY_AREA_SELECTORS.includes(".chat-record") === true, "就绪选择器包含 .chat-record");
assert(CHAT_READY_AREA_SELECTORS.includes(".chat-message") === true, "就绪选择器包含 .chat-message");
assert(CHAT_READY_AREA_SELECTORS.includes(".chat-conversation") === false, "就绪选择器不包含空占位 .chat-conversation");
assert(CHAT_READY_AREA_SELECTORS.includes(".chat-container") === false, "就绪选择器不包含 .chat-container");
assert(CHAT_READY_AREA_SELECTORS.includes("[class*='chat']") === false, "就绪选择器不包含 [class*='chat']");
assert(CHAT_NOT_READY === "chat_not_ready", "startchat 未就绪返回固定字符串");
assert(resolveChatStartState(CHAT_NOT_READY).action === "skip_job", "chat_not_ready -> autoApply 跳过职位页兜底");
assert(resolveChatStartState(false).fallback === true, "startchat false -> 保留人工点击兜底");
assert(resolveChatStartState(true).fallback === false, "startchat true -> 不执行职位页兜底");

// 清理临时文件
try { fs.unlinkSync(tmpState); } catch (e) {}

console.log("[resumeUploadConfirm] 附件确认弹窗判定");
const modalReady = resolveResumeUploadState({
  confirmVisible: true,
  confirmDisabled: false,
  hasFileName: true,
  hasStrongResumeMarker: false,
  pendingFile: true,
});
assert(modalReady.step === "click_confirm" && !modalReady.sent, "弹窗可用时先点击确定添加，不判已发送");

const modalDisabled = resolveResumeUploadState({
  confirmVisible: true,
  confirmDisabled: true,
  hasFileName: true,
  hasStrongResumeMarker: true,
  pendingFile: true,
});
assert(modalDisabled.step === "wait_confirm" && !modalDisabled.sent, "确认按钮 disabled 时等待，不点击普通发送");

const modalOpenStrongMarker = resolveResumeUploadState({
  confirmVisible: true,
  confirmDisabled: false,
  hasFileName: true,
  hasStrongResumeMarker: true,
  pendingFile: false,
});
assert(modalOpenStrongMarker.step !== "sent" && !modalOpenStrongMarker.sent, "确认弹窗未关闭，即使有强特征也不能判已发送");

const confirmDone = resolveResumeUploadState({
  confirmVisible: false,
  hasFileName: true,
  hasStrongResumeMarker: false,
  pendingFile: false,
  pendingChip: false,
}, { allowFileName: true });
assert(confirmDone.step === "sent" && confirmDone.sent, "确认后弹窗关闭且聊天区出现附件 -> 已发送");

const pendingAfterClose = resolveResumeUploadState({
  confirmVisible: false,
  hasFileName: true,
  hasStrongResumeMarker: true,
  pendingFile: true,
  pendingChip: true,
});
assert(pendingAfterClose.step === "wait_sent" && !pendingAfterClose.sent, "弹窗关闭但文件/pending chip 残留 -> 未发送");

const noModal = resolveResumeUploadState({
  confirmVisible: false,
  hasFileName: false,
  hasStrongResumeMarker: false,
  pendingFile: false,
  pendingChip: false,
});
assert(noModal.step === "unsent" && !noModal.sent, "无确认弹窗且无发送证据 -> 走普通发送判定");

const residualAfterConfirm = resolveResumeUploadState({
  confirmVisible: false,
  hasFileName: true,
  hasStrongResumeMarker: false,
  pendingFile: true,
  pendingChip: false,
}, { allowFileName: true, allowResidualInput: true });
assert(residualAfterConfirm.step === "sent" && residualAfterConfirm.sent, "确认关闭后残留 input 文件+附件气泡 -> 已发送");

const fallbackSendClicked = isResumeSentEvidence(
  { hasFileName: true, hasStrongResumeMarker: false, pendingFile: true, pendingChip: false },
  { allowFileName: true, allowResidualInput: true }
);
assert(fallbackSendClicked === true, "普通发送按钮已点击后残留 input 文件+附件气泡 -> 已发送");
const fallbackSendConservative = isResumeSentEvidence(
  { hasFileName: true, hasStrongResumeMarker: false, pendingFile: true, pendingChip: false },
  { allowFileName: true, allowResidualInput: false }
);
assert(fallbackSendConservative === false, "普通发送按钮未确认允许残留时仍保守判未发送");

const autoSentPoll = resolveResumeUploadPoll({
  confirmVisible: false,
  hasFileName: false,
  hasStrongResumeMarker: true,
  pendingFile: true,
  pendingChip: false,
}, { allowFileName: false, allowResidualInput: true, allowFallback: false });
assert(autoSentPoll.poll === "return_sent" && autoSentPoll.sent, "弹窗未出现但附件已自动发送 -> 返回 sent，不走普通发送");

const fallbackPoll = resolveResumeUploadPoll({
  confirmVisible: false,
  hasFileName: false,
  hasStrongResumeMarker: false,
  pendingFile: false,
  pendingChip: false,
}, { allowFallback: true });
assert(fallbackPoll.poll === "fallback_send" && !fallbackPoll.sent, "无弹窗且无发送证据 -> 回退普通发送");

const disabledPoll = resolveResumeUploadPoll({
  confirmVisible: true,
  confirmDisabled: true,
  hasFileName: true,
  pendingFile: true,
});
assert(disabledPoll.poll === "wait" && !disabledPoll.sent, "确认按钮 disabled -> 轮询等待，不点击普通发送");

console.log("[routes] chat-start provider warning");
const providerEnvKeys = [
  "LLM_PROVIDER",
  "ZHIPU_API_KEY",
  "ZHIPU_BASE_URL",
  "ZHIPU_MODEL",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
  "DEEPSEEK_MODEL",
];
const savedProviderEnv = {};
for (const key of providerEnvKeys) {
  savedProviderEnv[key] = process.env[key];
}
try {
  process.env.LLM_PROVIDER = "zhipu";
  delete process.env.ZHIPU_API_KEY;
  process.env.DEEPSEEK_API_KEY = "";
  const routes = await import("../src/routes.mjs");
  const warnings = [];
  const warning = routes.logProviderWarning({
    add: (msg) => warnings.push(msg),
  });
  assert(!!warning && warning.includes("ZHIPU_API_KEY"), "provider warning exists at chat start");
  assert(warnings.length === 1 && warnings[0].includes("ZHIPU_API_KEY"), "provider warning is added immediately");
} finally {
  for (const key of providerEnvKeys) {
    if (savedProviderEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedProviderEnv[key];
  }
}

try { getTestDb().close(); } catch (e) {}
try { fs.unlinkSync(tmpDb); } catch (e) {}
try { fs.unlinkSync(tmpDb + "-journal"); } catch (e) {}
try { fs.unlinkSync(tmpDb + "-wal"); } catch (e) {}
try { fs.unlinkSync(tmpDb + "-shm"); } catch (e) {}
try { fs.unlinkSync(tmpState); } catch (e) {}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
