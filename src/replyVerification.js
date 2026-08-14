// 回复发送成功判定纯函数。
// 成功必须同时满足：
//   - inputExists: 聊天输入框存在（找不到输入框时不能视为“已清空”，必须视为未确认）
//   - inputCleared: 聊天输入框已清空（内容确实发出去了）
//   - replyInArea 为 true 可直接成功；否则 sentMarker 必须与 grew 同时成立才能成功。
// grew（聊天区长度明显增长）只能作为辅助证据，不能单独判定成功。
// 本模块不依赖浏览器/DOM，可被单元测试直接引用。
export function isReplyVerified({ inputExists = false, inputCleared = false, replyInArea = false, sentMarker = false, grew = false } = {}) {
  if (!inputExists || !inputCleared) return false;
  if (replyInArea) return true;
  return !!(sentMarker && grew);
}

// 待发送/未完成附件 chip 的未完成提示文案。页面采集到可见的文件/附件/上传/预览类元素
// 包含这些文案之一时，视为附件上传/发送尚未完成（chip 残留），不能判已发送。
export const PENDING_CHIP_HINTS = ["待发送", "等待发送", "上传中", "发送失败", "取消"];

// 选择简历弹窗发送后，聊天区出现的附件请求强特征。
// “附件简历请求已发送”必须同时出现文件名才算真实附件已发送。
export const RESUME_REQUEST_MARKERS = ["附件简历请求已发送"];

// chip 文本是否包含未完成提示。纯函数，可被单元测试直接引用，
// 与 chatApply.js 页面采集端（用 PENDING_CHIP_HINTS 数组在浏览器内做同样判断）保持一致。
export function hasPendingChipHint(text) {
  return PENDING_CHIP_HINTS.some((h) => String(text || "").includes(h));
}

// 单个文件/附件类元素文本是否代表“未完成上传/发送”的待发送 chip。
// 语义：必须命中 PENDING_CHIP_HINTS 未完成提示才可能是 chip；文件名只是辅助条件——
// 传了 fileName 时，文本还必须包含 fileName 才算 chip；未传 fileName 时，只要有未完成提示即 true。
// 关键：文件名不能单独触发 pendingChip，真实已发送的附件气泡同样包含文件名，
// 只凭文件名会把“已发送”误判为“待发送”，导致预检失效与误报未确认。
// 纯函数，可被单元测试直接引用；chatApply.js 页面采集端在浏览器内使用与本函数完全等价的
// 逻辑（内联 hints 命中 && (!fileName || 文本含 fileName)，避免页面 CSP 禁用 eval/new Function），
// 保证采集端与测试端语义一致。
export function isPendingChipText(text, fileName) {
  if (!hasPendingChipHint(text)) return false;
  if (fileName) return String(text || "").includes(fileName);
  return true;
}

// 简历附件“已发送”强特征判定纯函数。
// 语义：
//   - pendingFile 为 true（文件输入框仍有待确认文件）时一律视为未发送；
//     确认弹窗已关闭且调用方显式传 allowResidualInput=true 时，可忽略同一输入框的残留 files，
//     但 confirmVisible/pendingChip 仍会阻止已发送判定；
//   - pendingChip 为 true（聊天区存在可见的待发送文件 chip：文本同时含未完成提示文案与当前文件名，
//     或仅含未完成提示文案而无文件名参数——见 isPendingChipText）时一律视为未发送——点击发送按钮
//     成功不证明上传成功，上传失败后文件名仍会以 chip 形式出现在聊天输入区，属假阳性；
//     注意：真实已发送的附件气泡也包含文件名，仅凭文件名不能判定为 chip；
//   - allowFileName=false（预检、或发送按钮未确认被点击）时，hasFileName 单独成立不能判已发送，
//     必须有 hasStrongResumeMarker——“待发送文件 chip/历史同名文件”也会让聊天区出现文件名，属假阳性；
//   - 否则 hasFileName（聊天区出现文件名）或 hasStrongResumeMarker（出现简历/附件发送强特征）
//     至少一个成立才视为已发送。
// 注意：通用的“已发送/发送成功”标记也会出现在普通打招呼消息上，不能作为简历附件的发送证据，
// 因此强特征列表只保留简历/附件专属文案，通用标记不会被采集为 hasStrongResumeMarker。
export function isResumeSentEvidence(
  {
    hasFileName = false,
    hasStrongResumeMarker = false,
    hasAppliedResumeMarker = false,
    pendingFile = false,
    pendingChip = false,
    confirmVisible = false,
  } = {},
  { allowFileName = true, allowResidualInput = false } = {}
) {
  if (confirmVisible || pendingChip) return false;
  if (pendingFile && !allowResidualInput) return false;
  if (!allowFileName) return !!hasStrongResumeMarker;
  return !!(hasFileName || hasStrongResumeMarker);
}

// BOSS 选择简历弹窗路径的“真实附件已发送”强特征判定。
// 与普通 isResumeSentEvidence 不同，这里不允许“聊天区只有文件名”判成功；
// 必须命中简历/附件强特征。若强特征是“附件简历请求已发送”，还必须同时出现文件名。
export function isResumeAttachmentSentEvidence(
  {
    hasFileName = false,
    hasStrongResumeMarker = false,
    hasRequestMarker = false,
    pendingFile = false,
    pendingChip = false,
    confirmVisible = false,
  } = {},
  { allowResidualInput = false, ignoreConfirmVisible = false } = {}
) {
  if ((confirmVisible && !ignoreConfirmVisible) || pendingChip) return false;
  if (pendingFile && !allowResidualInput) return false;
  if (!hasStrongResumeMarker) return false;
  if (hasRequestMarker && !hasFileName) return false;
  return true;
}
