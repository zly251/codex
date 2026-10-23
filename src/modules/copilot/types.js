// M3 copilot 模块 — 类型定义与 schema
// 纯函数，无 DB、无网络、无 LLM 依赖

export const SCHEMA_VERSION = "copilot-v1";

// 三态判定（docs/06_TARGET_ARCHITECTURE.md §5 M3 契约）：
//   OK          — 正常出建议
//   needManual  — offer/合同/外包类，不出建议，只提示人工
//   noChat      — 空 pageText（且无聊天历史），不出建议
export const STATUS = {
  OK: "OK",
  NEED_MANUAL: "needManual",
  NO_CHAT: "noChat",
};

// 建议正文上限（红线：≤160 字）
export const MAX_TEXT_LEN = 160;

// 守卫结果（与 payloadContract.LOOK_RESPONSE_SCHEMA.guardResult 同枚举）
export const GUARD_RESULT = {
  PASS: "PASS",
  TRUNCATED: "TRUNCATED",
  BLOCKED: "BLOCKED",
};

export const SuggestionSchema = {
  type: "string",       // greeting | followup | salary | interview | contact
  text: "string",       // 建议话术（≤160 字符，已过守卫）
  priority: "number",   // 1-5，越高越优先
  guard: "object",      // { result: PASS|TRUNCATED|BLOCKED, reason }
};

export const CopilotResultSchema = {
  schemaVersion: "string",
  ok: "boolean",            // LLM 挂了仍为 true（兜底模板 + llmFailed:true）
  status: "string",         // OK | needManual | noChat
  decisionReason: "string", // 三态判定依据（人可读）
  decision: "object",       // { status, reason, matched[], signals{} }
  suggestions: "array",
  blocked: "array",         // 被守卫拦下的候选（留痕，不外发）
  guard: "object",          // { result, blockedCount, truncatedCount, reasons[] }
  llmFailed: "boolean",
  reason: "string",
};

export function validateCopilotResult(result) {
  const errors = [];
  if (!result || typeof result !== "object") return ["result must be an object"];
  if (result.schemaVersion !== SCHEMA_VERSION) errors.push(`schemaVersion mismatch`);
  if (typeof result.ok !== "boolean") errors.push("ok must be boolean");
  if (typeof result.reason !== "string") errors.push("reason must be string");
  if (!Array.isArray(result.suggestions)) errors.push("suggestions must be array");
  else {
    for (const s of result.suggestions) {
      if (typeof s.type !== "string") errors.push("suggestion.type must be string");
      if (typeof s.text !== "string") errors.push("suggestion.text must be string");
      if (s.text && s.text.length > MAX_TEXT_LEN) errors.push(`suggestion.text exceeds ${MAX_TEXT_LEN} chars: ${s.text.length}`);
      if (typeof s.priority !== "number") errors.push("suggestion.priority must be number");
      if (s.guard && !Object.values(GUARD_RESULT).includes(s.guard.result)) {
        errors.push(`suggestion.guard.result invalid: ${s.guard.result}`);
      }
    }
  }
  // status 为可选（旧形状兼容），出现时必须是三态之一
  if (result.status !== undefined && !Object.values(STATUS).includes(result.status)) {
    errors.push(`status invalid: ${result.status}`);
  }
  if (result.status !== undefined && typeof result.decisionReason !== "string") {
    errors.push("decisionReason must be string when status present");
  }
  return errors;
}
