// M4 evidence 模块 — EvidenceReceipt 结构定义与验证
// 纯函数，无 DB、无网络、无 LLM 依赖
// 架构层：L2 业务层。此文件定义本模块输出的结构契约。
// 当 captain 创建 src/core/contracts/payloadContract.js 后，可迁移到此处的引用。

export const SCHEMA_VERSION = "evidence-v1";

/**
 * EvidenceReceipt 结构定义（文档/校验用）。
 * 核心产出：{ ok, reason, markers }
 *   ok      — 总体判定（所有检查通过为 true）
 *   reason  — 判定理由（人类可读）
 *   markers — 风险标记列表（机器可读，如 ["salary_too_low", "company_no_license"]）
 */
export const EvidenceReceiptShape = {
  schemaVersion: "evidence-v1",
  ok: "boolean",
  reason: "string",
  markers: "string[]",
  checks: {
    jobAuthenticity: { ok: "boolean", reason: "string", markers: "string[]" },
    companyQualification: { ok: "boolean", reason: "string", markers: "string[]" },
    salaryReasonableness: { ok: "boolean", reason: "string", markers: "string[]" },
  },
  meta: {
    jobTitle: "string",
    companyName: "string",
    salary: { min: "number", max: "number", unit: "string", months: "number" },
    source: "string",
    collectedAt: "string",
  },
};

/**
 * 验证 EvidenceReceipt 结构是否符合 schema。
 * 返回错误字符串数组；空数组表示通过。
 */
export function validateEvidenceReceipt(receipt) {
  const errors = [];
  if (!receipt || typeof receipt !== "object") {
    return ["receipt must be an object"];
  }
  if (receipt.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion must be "${SCHEMA_VERSION}", got "${receipt.schemaVersion}"`);
  }
  if (typeof receipt.ok !== "boolean") {
    errors.push("ok must be boolean");
  }
  if (typeof receipt.reason !== "string") {
    errors.push("reason must be string");
  }
  if (!Array.isArray(receipt.markers)) {
    errors.push("markers must be array");
  }
  if (!receipt.checks || typeof receipt.checks !== "object") {
    errors.push("checks must be object");
    return errors; // 后续检查依赖 checks 存在
  }
  for (const checkName of ["jobAuthenticity", "companyQualification", "salaryReasonableness"]) {
    const c = receipt.checks[checkName];
    if (!c || typeof c !== "object") {
      errors.push(`checks.${checkName} must be object`);
      continue;
    }
    if (typeof c.ok !== "boolean") errors.push(`checks.${checkName}.ok must be boolean`);
    if (typeof c.reason !== "string") errors.push(`checks.${checkName}.reason must be string`);
    if (!Array.isArray(c.markers)) errors.push(`checks.${checkName}.markers must be array`);
  }
  if (!receipt.meta || typeof receipt.meta !== "object") {
    errors.push("meta must be object");
  }
  return errors;
}
