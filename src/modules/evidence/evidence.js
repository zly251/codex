// M4 evidence 模块 — 证据判定核心逻辑
// 职责：岗位真实性、公司资质、薪资合理性等证据收集和判定
// 纯函数，无 DB、无网络、无 LLM 依赖，不依赖旧链
// 架构层：L2 业务层，依赖方向 L2 → L1（契约），不依赖其他 L2 模块

import { SCHEMA_VERSION, validateEvidenceReceipt } from "./types.js";

// —— 配置项（env 覆盖，默认台州经验值）——
function envNum(name, dflt) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : dflt;
}

// 最低月工资标准（台州 2024：2280 元/月，可 env 覆盖）
const MIN_MONTHLY_SALARY = envNum("JOB_EVIDENCE_MIN_SALARY", 2280);
// 薪资上限（超过则标记异常高，可能是欺诈）
const MAX_MONTHLY_SALARY = envNum("JOB_EVIDENCE_MAX_SALARY", 50000);
// 岗位标题最短长度（字符）
const MIN_TITLE_LEN = envNum("JOB_EVIDENCE_MIN_TITLE_LEN", 2);
// 岗位描述最短长度（字符）
const MIN_DESC_LEN = envNum("JOB_EVIDENCE_MIN_DESC_LEN", 10);
// 公司名称最短长度（字符）
const MIN_COMPANY_LEN = envNum("JOB_EVIDENCE_MIN_COMPANY_LEN", 4);

// 欺诈关键词模式（岗位描述中出现则标记风险）
const FRAUD_PATTERNS = [
  /无需经验.*高薪/,
  /日入.*千/,
  /月入.*万.*无需/,
  /押金|培训费|服装费/,
  /加.*微信.*了解/,
  /刷单|刷信誉/,
];

// 合法公司名称后缀
const COMPANY_SUFFIXES = [
  "有限公司",
  "股份有限公司",
  "有限责任公司",
  "合伙企业",
  "集团有限公司",
  "科技股份公司",
  "分公司",
];

/**
 * 1. 岗位真实性判定
 * @param {{jobTitle:string, jobDescription:string}} jobInfo
 * @returns {{ok:boolean, reason:string, markers:string[]}}
 */
export function checkJobAuthenticity(jobInfo) {
  const markers = [];
  const title = (jobInfo?.jobTitle || "").trim();
  const desc = (jobInfo?.jobDescription || "").trim();

  if (!title || title.length < MIN_TITLE_LEN) {
    markers.push("job_title_empty");
  }
  if (!desc || desc.length < MIN_DESC_LEN) {
    markers.push("job_desc_too_short");
  }
  // 欺诈模式检测
  for (const pattern of FRAUD_PATTERNS) {
    if (pattern.test(desc)) {
      markers.push("job_fraud_pattern");
      break;
    }
  }

  const ok = markers.length === 0;
  const reason = ok
    ? "岗位信息完整，未检测到欺诈特征"
    : `岗位存在风险：${markers.join(", ")}`;

  return { ok, reason, markers };
}

/**
 * 2. 公司资质判定
 * @param {{companyName:string, licenseNo?:string}} companyInfo
 * @returns {{ok:boolean, reason:string, markers:string[]}}
 */
export function checkCompanyQualification(companyInfo) {
  const markers = [];
  const name = (companyInfo?.companyName || "").trim();
  const licenseNo = (companyInfo?.licenseNo || "").trim();

  if (!name || name.length < MIN_COMPANY_LEN) {
    markers.push("company_name_empty");
  } else {
    // 检查公司名称是否包含合法后缀
    const hasValidSuffix = COMPANY_SUFFIXES.some((suffix) => name.includes(suffix));
    if (!hasValidSuffix) {
      markers.push("company_name_invalid");
    }
  }
  if (!licenseNo) {
    markers.push("company_no_license");
  }

  const ok = markers.length === 0;
  const reason = ok
    ? "公司名称合法，资质信息完整"
    : `公司资质存在风险：${markers.join(", ")}`;

  return { ok, reason, markers };
}

/**
 * 3. 薪资合理性判定
 * @param {{min:number, max:number, unit?:string, months?:number}} salaryInfo
 * @returns {{ok:boolean, reason:string, markers:string[]}}
 */
export function checkSalaryReasonableness(salaryInfo) {
  const markers = [];
  const min = Number(salaryInfo?.min) || 0;
  const max = Number(salaryInfo?.max) || 0;
  const unit = salaryInfo?.unit || "月";
  const months = Number(salaryInfo?.months) || 12;

  // 转换为月薪口径用于判定
  let monthlyMin = min;
  let monthlyMax = max;
  if (unit === "年") {
    monthlyMin = min / months;
    monthlyMax = max / months;
  }

  if (min <= 0 || max <= 0 || min > max) {
    markers.push("salary_range_invalid");
  }
  if (monthlyMin > 0 && monthlyMin < MIN_MONTHLY_SALARY) {
    markers.push("salary_too_low");
  }
  if (monthlyMax > MAX_MONTHLY_SALARY) {
    markers.push("salary_too_high");
  }

  const ok = markers.length === 0;
  const reason = ok
    ? `薪资范围合理（${min}-${max}${unit}，月薪口径 ${Math.round(monthlyMin)}-${Math.round(monthlyMax)}）`
    : `薪资存在风险：${markers.join(", ")}`;

  return { ok, reason, markers };
}

/**
 * 主入口：收集证据并生成 EvidenceReceipt
 * @param {object} jobData — 岗位数据（字段兼容多种命名）
 * @returns {EvidenceReceipt}
 */
export function evaluateEvidence(jobData) {
  const jobInfo = {
    jobTitle: jobData?.jobTitle || jobData?.title || "",
    jobDescription: jobData?.jobDescription || jobData?.description || "",
  };
  const companyInfo = {
    companyName: jobData?.companyName || jobData?.company || "",
    licenseNo: jobData?.licenseNo || jobData?.companyLicense || jobData?.unifiedSocialCreditCode || "",
  };
  const salaryInfo = {
    min: Number(jobData?.salaryMin || jobData?.salary?.min) || 0,
    max: Number(jobData?.salaryMax || jobData?.salary?.max) || 0,
    unit: jobData?.salaryUnit || jobData?.salary?.unit || "月",
    months: Number(jobData?.salaryMonths || jobData?.salary?.months) || 12,
  };

  const checks = {
    jobAuthenticity: checkJobAuthenticity(jobInfo),
    companyQualification: checkCompanyQualification(companyInfo),
    salaryReasonableness: checkSalaryReasonableness(salaryInfo),
  };

  // 汇总所有标记
  const allMarkers = [
    ...checks.jobAuthenticity.markers,
    ...checks.companyQualification.markers,
    ...checks.salaryReasonableness.markers,
  ];

  const ok =
    checks.jobAuthenticity.ok &&
    checks.companyQualification.ok &&
    checks.salaryReasonableness.ok;

  const reason = ok
    ? "所有证据检查通过"
    : `证据检查未通过：${allMarkers.join(", ")}`;

  const receipt = {
    schemaVersion: SCHEMA_VERSION,
    ok,
    reason,
    markers: allMarkers,
    checks,
    meta: {
      jobTitle: jobInfo.jobTitle,
      companyName: companyInfo.companyName,
      salary: {
        min: salaryInfo.min,
        max: salaryInfo.max,
        unit: salaryInfo.unit,
        months: salaryInfo.months,
      },
      source: jobData?.source || "unknown",
      collectedAt: jobData?.collectedAt || new Date().toISOString(),
    },
  };

  // 自验证（防御性：确保输出结构始终合法）
  const errors = validateEvidenceReceipt(receipt);
  if (errors.length > 0) {
    receipt._validationErrors = errors;
  }

  return receipt;
}
