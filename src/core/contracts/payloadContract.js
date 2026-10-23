/**
 * L1 契约层 - Payload 数据结构契约
 * 冻结：并行开发期间任何改动必须双方同步
 *
 * 职责：定义 JobDraft / ValueCard / LookResponse / EvidenceReceipt 的 JSON 结构版本化
 * 红线：所有 payload 必须带 schemaVersion，过期结果直接丢弃
 */

// ══════════════════════════════════════════════════════════════════
// 1. Schema 版本常量
// ══════════════════════════════════════════════════════════════════

export const SCHEMA_VERSION = "1.0.0";
export const SCHEMA_DATE = "2026-10-08";

/**
 * 版本兼容性检查
 * @param {string} version - 实际版本号
 * @returns {{compatible: boolean, reason: string}}
 */
export function checkSchemaVersion(version) {
  if (!version) {
    return { compatible: false, reason: "Missing schemaVersion" };
  }
  const major = version.split(".")[0];
  const currentMajor = SCHEMA_VERSION.split(".")[0];
  if (major !== currentMajor) {
    return { compatible: false, reason: `Schema major version mismatch: expected ${currentMajor}, got ${major}` };
  }
  return { compatible: true, reason: "OK" };
}

// ══════════════════════════════════════════════════════════════════
// 2. JobDraft（岗位发现与详情增补产出）
// ══════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} JobDraft
 * @property {string} schemaVersion - 必填，格式 "x.y.z"
 * @property {string} jobId - 岗位唯一标识
 * @property {string} title - 岗位名称
 * @property {string} [salary] - 原始薪资文本（如 "6-10K"）
 * @property {number} [salaryMinK] - 薪资下限（K）
 * @property {number} [salaryMaxK] - 薪资上限（K）
 * @property {number} [salaryMonths] - 几薪（12-16）
 * @property {string} [city] - 城市
 * @property {string} [district] - 区县
 * @property {string} [address] - 详细地址
 * @property {string} [experience] - 经验要求
 * @property {string} [education] - 学历要求
 * @property {string} [description] - 职位描述
 * @property {string[]} [tags] - 标签列表
 * @property {string} [companyName] - 公司名称
 * @property {string} [companySize] - 公司规模
 * @property {string} [industry] - 行业
 * @property {string} [hrName] - HR 姓名
 * @property {string} [hrTitle] - HR 职位
 * @property {number} [distanceKm] - 距离公里数
 * @property {string} [distanceTier] - 距离档位：CORE(≤5km) | NEAR(≤15km) | FAR(>15km) | UNKNOWN | OUT_OF_CITY
 * @property {boolean} [hasDormitory] - 是否有宿舍
 * @property {string} [source] - 数据来源（如 "boss_search", "manual_input"）
 * @property {number} [listedAt] - 列表时间戳
 * @property {number} [enrichedAt] - 增补时间戳
 * @property {string} [status] - 状态：DRAFT | ENRICHED | REVIEWED | IGNORED
 */

export const JOB_DRAFT_SCHEMA = {
  schemaVersion: "string!",
  jobId: "string!",
  title: "string!",
  salary: "string",
  salaryMinK: "number",
  salaryMaxK: "number",
  salaryMonths: "number",
  city: "string",
  district: "string",
  address: "string",
  experience: "string",
  education: "string",
  description: "string",
  tags: "string[]",
  companyName: "string",
  companySize: "string",
  industry: "string",
  hrName: "string",
  hrTitle: "string",
  distanceKm: "number",
  distanceTier: "string(enum:CORE,NEAR,FAR,UNKNOWN,OUT_OF_CITY)",
  hasDormitory: "boolean",
  source: "string",
  listedAt: "number",
  enrichedAt: "number",
  status: "string(enum:DRAFT,ENRICHED,REVIEWED,IGNORED)",
};

// ══════════════════════════════════════════════════════════════════
// 3. ValueCard（含金量卡）
// ══════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} ValueCard
 * @property {string} schemaVersion - 必填
 * @property {string} jobId - 关联岗位 ID
 * @property {number} grossMonthlyK - 名义月薪（K）
 * @property {number} [salaryMinK] - 薪资下限
 * @property {number} [salaryMaxK] - 薪资上限
 * @property {number} [salaryMonths] - 几薪
 * @property {number} grossAnnualK - 年税前收入（K）
 * @property {number} insuranceMonthly - 五险一金个人月扣（元）
 * @property {number} taxMonthly - 个税月扣（元）
 * @property {number} netMonthly - 月到手（元）
 * @property {number} netAnnual - 年到手（元）
 * @property {number} [commuteCostMonthly] - 月通勤费用（元）
 * @property {number} [disposableMonthly] - 扣通勤后月可支配（元）
 * @property {string} [commuteMode] - 通勤方式标签
 * @property {string} [commuteModeLabel] - 通勤方式中文
 * @property {number} [distanceKm] - 距离公里数
 * @property {Object} sources - 来源标签
 *   @property {string} base - 基数来源（如 "HR明说", "估算(基数=月薪)", "估算(取基数下限)"）
 *   @property {string} socialRates - 社保比例来源（如 "env默认值"）
 *   @property {string} fundRate - 公积金比例来源
 *   @property {string} tax - 个税来源（如 "月度换算税率表"）
 *   @property {string} commute - 通勤来源（如 "env默认值", "用户指定"）
 *   @property {string} warning - 风险警告（如有）
 */

export const VALUE_CARD_SCHEMA = {
  schemaVersion: "string!",
  jobId: "string!",
  grossMonthlyK: "number!",
  salaryMinK: "number",
  salaryMaxK: "number",
  salaryMonths: "number",
  grossAnnualK: "number!",
  insuranceMonthly: "number!",
  taxMonthly: "number!",
  netMonthly: "number!",
  netAnnual: "number!",
  commuteCostMonthly: "number",
  disposableMonthly: "number",
  commuteMode: "string",
  commuteModeLabel: "string",
  distanceKm: "number",
  sources: "object!",
};

// ══════════════════════════════════════════════════════════════════
// 4. LookResponse（扩展只读看 / 聊天话术建议）
// ══════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} LookResponse
 * @property {string} schemaVersion - 必填
 * @property {string} jobId - 关联岗位 ID
 * @property {string} status - 状态：OK | needManual | noChat | error
 * @property {string} [intent] - 意图分类（当 status=OK 时）
 * @property {string} [suggestion] - 话术建议（当 status=OK 时）
 * @property {string} [explanation] - 建议解释（为什么这样建议）
 * @property {string[]} [relevantSkills] - 相关技能词（底细卡白名单）
 * @property {string} [guardResult] - 守卫结果：PASS | BLOCKED | TRUNCATED
 * @property {string} [guardReason] - 守卫拦截原因（当 guardResult≠PASS）
 * @property {Object} [valueCard] - 含金量卡快照（可选）
 * @property {string} [manualReason] - 需要人工介入的原因（当 status=needManual）
 * @property {string} [errorMessage] - 错误信息（当 status=error）
 * @property {number} [latencyMs] - 处理耗时（毫秒）
 * @property {string} [llmProvider] - 使用的 LLM 提供商（如 "qwen3.8-flash", "template"）
 */

export const LOOK_RESPONSE_SCHEMA = {
  schemaVersion: "string!",
  jobId: "string!",
  status: "string(enum:OK,needManual,noChat,error)!",
  intent: "string",
  suggestion: "string",
  explanation: "string",
  relevantSkills: "string[]",
  guardResult: "string(enum:PASS,BLOCKED,TRUNCATED)",
  guardReason: "string",
  valueCard: "object",
  manualReason: "string",
  errorMessage: "string",
  latencyMs: "number",
  llmProvider: "string",
};

// ══════════════════════════════════════════════════════════════════
// 5. EvidenceReceipt（证据判定）
// ══════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} EvidenceReceipt
 * @property {string} schemaVersion - 必填
 * @property {string} jobId - 关联岗位 ID
 * @property {boolean} ok - 证据是否完整
 * @property {string} [reason] - 判定原因
 * @property {Object[]} markers - 证据标记列表
 *   @property {string} marker.type - 类型：delivery | resumeAttachment | applyReceipt | manualCheck
 *   @property {boolean} marker.ok - 是否通过
 *   @property {string} marker.detail - 详情
 * @property {string[]} [missing] - 缺失的证据类型
 * @property {number} [verifiedAt] - 验证时间戳
 */

export const EVIDENCE_RECEIPT_SCHEMA = {
  schemaVersion: "string!",
  jobId: "string!",
  ok: "boolean!",
  reason: "string",
  markers: "array!",
  missing: "string[]",
  verifiedAt: "number",
};

// ══════════════════════════════════════════════════════════════════
// 6. 验证函数
// ══════════════════════════════════════════════════════════════════

/**
 * 浅验证对象是否匹配 schema（必填字段 + 类型检查）
 * @param {Object} obj - 待验证对象
 * @param {Object} schema - 字段类型定义（如 JOB_DRAFT_SCHEMA）
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validatePayload(obj, schema) {
  const errors = [];

  if (!obj || typeof obj !== "object") {
    return { valid: false, errors: ["Payload must be an object"] };
  }

  // 检查 schemaVersion
  const versionCheck = checkSchemaVersion(obj.schemaVersion);
  if (!versionCheck.compatible) {
    errors.push(versionCheck.reason);
  }

  for (const [field, typeDef] of Object.entries(schema)) {
    if (!typeDef) continue;

    const required = typeDef.endsWith("!");
    const type = required ? typeDef.slice(0, -1) : typeDef;
    const value = obj[field];

    // 必填检查
    if (required && (value === undefined || value === null)) {
      errors.push(`Missing required field: ${field}`);
      continue;
    }

    // 类型检查（只在有值时检查）
    if (value !== undefined && value !== null) {
      const isArray = Array.isArray(value);
      const isObject = !isArray && typeof value === "object";

      if (type === "string" && typeof value !== "string") {
        errors.push(`Field ${field} must be a string`);
      } else if (type === "number" && !Number.isFinite(value)) {
        errors.push(`Field ${field} must be a number`);
      } else if (type === "boolean" && typeof value !== "boolean") {
        errors.push(`Field ${field} must be a boolean`);
      } else if (type === "object" && !isObject) {
        errors.push(`Field ${field} must be an object`);
      } else if (type === "array" && !isArray) {
        errors.push(`Field ${field} must be an array`);
      } else if (type.startsWith("string[]") && (!isArray || !value.every(v => typeof v === "string"))) {
        errors.push(`Field ${field} must be an array of strings`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * 快捷验证函数
 */
export function validateJobDraft(draft) {
  return validatePayload(draft, JOB_DRAFT_SCHEMA);
}

export function validateValueCard(card) {
  return validatePayload(card, VALUE_CARD_SCHEMA);
}

export function validateLookResponse(response) {
  return validatePayload(response, LOOK_RESPONSE_SCHEMA);
}

export function validateEvidenceReceipt(receipt) {
  return validatePayload(receipt, EVIDENCE_RECEIPT_SCHEMA);
}

// ══════════════════════════════════════════════════════════════════
// 7. 契约变更日志
// ══════════════════════════════════════════════════════════════════

export const PAYLOAD_CONTRACT_CHANGELOG = [
  {
    version: "1.0.0",
    date: "2026-10-08",
    changes: [
      "初始版本：定义 JobDraft / ValueCard / LookResponse / EvidenceReceipt 结构",
      "红线：所有 payload 必须带 schemaVersion",
      "红线：过期结果直接丢弃",
    ],
  },
];
