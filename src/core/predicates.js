// 平台无关内核：纯判据（M5 步骤 1 抽叶，来源 chatApply.js 138–346 子集）
// 铁律（docs/05_MODULARIZATION_PLAN.md §5.2）：src/core/** 不得 import src/platforms/** 与 chatApply.js。
// 这些函数全部是不依赖浏览器/实例状态的纯函数，供 chatApply 与单元测试共用。

import { isResumeSentEvidence } from "../replyVerification.js";

// startChat 协议的哨兵返回值：表示"无法安全进入聊天页，调用方应失败跳过，不回退职位页人工点击"。
// （原 chatApply.js:59。本质是 adapter.startChat 的返回协议值，故归 core；boss 侧按蓝图步骤 2 re-export 回来。）
export const CHAT_NOT_READY = "chat_not_ready";

// 代际有效性判定纯函数（供 sendReply 与单元测试共用，不依赖浏览器/实例状态）。
// 语义：expectedGeneration 为 null/undefined 时恒为 true（手动回复不受代际约束）；
// 否则必须 running 且 expectedGeneration === currentGeneration 才算当前代有效——
// stop()/重启会使 running=false 或 generation 递增，旧轮据此识别自己已失效。
export function isGenerationCurrent(running, expectedGeneration, currentGeneration) {
  if (expectedGeneration == null) return true;
  return running && expectedGeneration === currentGeneration;
}

// 简历文件输入框 accept 判定纯函数：accept 含 pdf/doc/msword/document 的 input[type=file]
// 才是简历输入框（真实 BOSS 聊天页第一个可见文件输入框是图片，accept 只含 image）。
// 供 _sendResume 与单元测试共用。
export function isResumeFileAccept(accept) {
  return /pdf|doc|msword|document/.test(String(accept || "").toLowerCase());
}

export function isResumeSendUnavailable(
  {
    hasVisibleResumeSend = false,
    resumeSendDisabled = false,
    resumeSendAriaLabel = "",
    resumeSendText = "",
  } = {}
) {
  if (!hasVisibleResumeSend) return false;
  const labelText = `${resumeSendAriaLabel || ""} ${resumeSendText || ""}`;
  const unavailableHint = /双方回复后可用|正在请求中|等待对方回复|不可用|unable/i.test(labelText);
  return !!resumeSendDisabled || unavailableHint;
}

export function isResumeSendInEffect(state = {}) {
  if (!state) return false;
  return isResumeSendUnavailable(state);
}

// Upload confirm dialog state resolver. The page only collects a DOM snapshot;
// this pure function decides whether to click confirm, wait for it, or mark sent.
export function resolveResumeUploadState(snapshot = {}, options = {}) {
  const confirmVisible = !!snapshot.confirmVisible;
  if (confirmVisible) {
    const confirmDisabled = !!snapshot.confirmDisabled;
    return {
      confirmVisible: true,
      step: confirmDisabled ? "wait_confirm" : "click_confirm",
      sent: false,
    };
  }
  const sent = isResumeSentEvidence(snapshot, options);
  const pending = !!snapshot.pendingChip || (!!snapshot.pendingFile && !options.allowResidualInput);
  return {
    confirmVisible: false,
    step: sent ? "sent" : pending ? "wait_sent" : "unsent",
    sent,
  };
}

export function resolveResumeUploadPoll(snapshot = {}, options = {}) {
  const action = resolveResumeUploadState(snapshot, options);
  if (action.confirmVisible) {
    return {
      ...action,
      poll: action.step === "wait_confirm" ? "wait" : "click_confirm",
    };
  }
  if (action.sent) return { ...action, poll: "return_sent" };
  if (action.step === "wait_sent") return { ...action, poll: "wait" };
  return {
    ...action,
    poll: options.allowFallback ? "fallback_send" : "wait",
  };
}

// redirect-url 绝对化纯函数：redirect-url 可能是相对路径（/web/geek/chat?id=...），
// 需要基于当前职位页 URL 解析成绝对地址供 page.goto 使用。
export function resolveRedirectUrl(redirectUrl, baseUrl) {
  const raw = String(redirectUrl || "");
  if (!raw) return "";
  try {
    return new URL(raw, baseUrl).toString();
  } catch (e) {
    return raw;
  }
}

// startchat 接口（/wapi/zpgeek/friend/add.json）成功判定纯函数：
// 真实环境返回 { code: 0 }；非 JSON 响应（如登录页 HTML）或 code 非 0 都不得算成功，
// 否则会误跳过人工点击兜底。供 _startChatWithJob 与单元测试共用。
export function isStartChatApiSuccess(data) {
  return !!data && (String(data.code) === "0" || data.code === 0);
}

export function isChatPageReady({ urlHasChat = false, hasChatArea = false, hasChatInput = false } = {}) {
  return !!urlHasChat && (hasChatArea || hasChatInput);
}

export function isChatActionReady({
  hasDelivered = false,
  hasGreeted = false,
  hasAppliedResumeMarker = false,
} = {}) {
  return !!hasDelivered || !!hasGreeted || !!hasAppliedResumeMarker;
}

export function isChatActionEvidence({
  hasChatArea = false,
  hasDelivered = false,
  hasGreeted = false,
  hasAppliedResumeMarker = false,
} = {}) {
  return !!hasChatArea && (!!hasDelivered || !!hasGreeted || !!hasAppliedResumeMarker);
}

export function resolveChatStartPlan({ hasRedirectUrl = false, hasDataUrl = false } = {}) {
  if (hasDataUrl) return "api_first";
  if (hasRedirectUrl) return "direct_goto";
  return CHAT_NOT_READY;
}

export function isJobDetailReady(detailState) {
  return !!detailState?.isJobDetail &&
    (detailState?.hasStartChat === false || detailState?.hasStartChat === true);
}

export function resolveChatStartState(result) {
  if (result === CHAT_NOT_READY) return { action: "skip_job", fallback: false };
  if (result === "skip" || result === true) return { action: "proceed", fallback: false };
  return { action: "fallback", fallback: true };
}

export function isUsableChatInput({
  className = "",
  ariaLabel = "",
  type = "",
  isContentEditable = false,
} = {}) {
  const cls = String(className || "").toLowerCase();
  const label = String(ariaLabel || "");
  const t = String(type || "").toLowerCase();
  return !(cls.includes("search") || label.includes("搜索") || t === "search");
}

export function isResumePdfItem({ text = "", className = "" } = {}) {
  return /\.pdf|icon-pdf/i.test(`${String(text || "")} ${String(className || "")}`);
}

export function isResumeFileLastText(text, names = []) {
  const values = Array.isArray(text) ? text : [text];
  const nameList = (names || []).map((n) => String(n || "").trim()).filter(Boolean);
  return values.some((value) => {
    const t = String(value || "").trim();
    if (!t) return false;
    return nameList.length > 0 && nameList.some((n) => t === n);
  });
}

export function isSelectedResumeFallbackAllowed(state = {}) {
  if (!state || typeof state !== "object") return false;
  const {
    hasChatArea = false,
    chatAreaText = "",
    pendingChip = false,
    pendingFile = false,
  } = state;
  if (pendingChip || pendingFile) return false;
  const text = String(chatAreaText || "").trim();
  if (!hasChatArea || !text) return true;
  return /加载中|正在加载|loading/i.test(text);
}

export function isResumeDialogSignal({
  hasDialog = false,
  hasResumeList = false,
  hasConfirmButton = false,
  hasHint = false,
} = {}) {
  return !!hasDialog && (hasResumeList || hasConfirmButton || hasHint);
}

export function isResumeDialogConfirmAvailable({
  hasDialog = false,
  hasConfirmButton = false,
  confirmDisabled = false,
} = {}) {
  return !!hasDialog && !!hasConfirmButton && !confirmDisabled;
}

export function shouldUseResumeVueFallback({ sent = false, dialogOpen = false, sendInEffect = false } = {}) {
  return !sent && dialogOpen && !sendInEffect;
}
