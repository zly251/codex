// M5 console 模块 — 类型定义与 schema
// 纯函数，无 DB、无网络、无 LLM 依赖

export const SCHEMA_VERSION = "console-v1";

export const SummarySchema = {
  totalJobs: "number",
  avgSalary: "number",
  highRiskCount: "number",
  pendingReviewCount: "number",
};

export const DetailItemSchema = {
  jobTitle: "string",
  companyName: "string",
  salary: "object",
  valueScore: "number",
  evidenceOk: "boolean",
  suggestionCount: "number",
};

export const ConsoleResultSchema = {
  schemaVersion: "string",
  ok: "boolean",
  summary: "object",
  detail: "array",
};

export function validateConsoleResult(result) {
  const errors = [];
  if (!result || typeof result !== "object") return ["result must be an object"];
  if (result.schemaVersion !== SCHEMA_VERSION) errors.push("schemaVersion mismatch");
  if (typeof result.ok !== "boolean") errors.push("ok must be boolean");
  if (!result.summary || typeof result.summary !== "object") errors.push("summary must be object");
  if (!Array.isArray(result.detail)) errors.push("detail must be array");
  return errors;
}
