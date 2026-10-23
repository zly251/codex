// M2 value 模块 — ValueCard 契约适配器
// 职责：将 calculator.js 产出的内部含金量卡（含完整明细）转换为 payloadContract 的 VALUE_CARD_SCHEMA 格式
// 纯函数，无 DB、无网络、无 LLM 依赖
// 架构层：L2 业务层，依赖方向 L2 → L1（契约）

import {
  computeValueCard,
  SOCIAL_RATES,
  FUND_RATE,
} from "./calculator.js";
import { SCHEMA_VERSION } from "./types.js";
import { validateValueCard } from "../../core/contracts/payloadContract.js";

/**
 * 将内部含金量卡转换为 VALUE_CARD_SCHEMA 契约格式
 * @param {object} rawCard - computeValueCard() 的返回值
 * @param {string} jobId - 关联岗位 ID
 * @returns {object} 符合 VALUE_CARD_SCHEMA 的 ValueCard（或带 _validationErrors 的错误卡）
 */
export function toValueCard(rawCard, jobId) {
  // 处理计算失败的情况
  if (!rawCard || !rawCard.ok) {
    return {
      schemaVersion: SCHEMA_VERSION,
      jobId: String(jobId || "unknown"),
      grossMonthlyK: 0,
      grossAnnualK: 0,
      insuranceMonthly: 0,
      taxMonthly: 0,
      netMonthly: 0,
      netAnnual: 0,
      sources: {
        base: "计算失败",
        socialRates: "N/A",
        fundRate: "N/A",
        tax: "N/A",
        commute: "N/A",
        warning: rawCard?.reason || "计算失败",
      },
      _error: rawCard?.reason || "计算失败",
    };
  }

  const gross = rawCard.gross;
  const monthsSalary = rawCard.annual?.monthsSalary || 12;
  const grossAnnual = gross * monthsSalary;

  // 构建符合 VALUE_CARD_SCHEMA 的扁平结构
  const card = {
    schemaVersion: SCHEMA_VERSION,
    jobId: String(jobId || "unknown"),
    grossMonthlyK: round2(gross / 1000),
    grossAnnualK: round2(grossAnnual / 1000),
    insuranceMonthly: rawCard.insurance?.total ?? 0,
    taxMonthly: rawCard.tax?.tax ?? 0,
    netMonthly: rawCard.net ?? 0,
    netAnnual: rawCard.annual?.annualNet ?? 0,
    sources: {
      base: rawCard.sources?.insuranceBase || "估算(基数=月薪)",
      socialRates: `env默认值(养老${pct(SOCIAL_RATES.pension)}医疗${pct(SOCIAL_RATES.medical)}失业${pct(SOCIAL_RATES.unemployment)})`,
      fundRate: rawCard.sources?.fundRate || "估算(默认8%)",
      tax: rawCard.sources?.tax || "估算(月度累进,忽略部分专项附加)",
      commute: rawCard.sources?.commute || "待确认",
      warning: buildWarning(rawCard),
    },
  };

  // 可选字段（只在有值时填）
  if (rawCard.grossRange) {
    card.salaryMinK = round2(rawCard.grossRange[0] / 1000);
    card.salaryMaxK = round2(rawCard.grossRange[1] / 1000);
  }
  if (monthsSalary !== 12) {
    card.salaryMonths = monthsSalary;
  }
  if (rawCard.commute?.known && rawCard.commute.monthly != null) {
    card.commuteCostMonthly = rawCard.commute.monthly;
  }
  if (rawCard.disposable != null) {
    card.disposableMonthly = rawCard.disposable;
  }
  if (rawCard.commute?.mode) {
    card.commuteMode = rawCard.commute.mode;
  }
  if (rawCard.commute?.modeLabel) {
    card.commuteModeLabel = rawCard.commute.modeLabel;
  }
  if (rawCard.distanceKm != null) {
    card.distanceKm = rawCard.distanceKm;
  }

  // 自验证（防御性：确保输出结构始终合法）
  const validation = validateValueCard(card);
  if (!validation.valid) {
    card._validationErrors = validation.errors;
  }

  return card;
}

/**
 * 便捷函数：从 JobDraft-like 对象直接计算并输出 VALUE_CARD_SCHEMA 格式的 ValueCard
 * @param {object} job - 岗位数据（兼容 JobDraft 字段命名）
 * @returns {object} 符合 VALUE_CARD_SCHEMA 的 ValueCard
 */
export function computeValueCardFromJob(job) {
  const jobId = job?.jobId || job?.id || "unknown";

  // 从 JobDraft 薪资字段推导输入
  const minK = Number(job?.salaryMinK);
  const maxK = Number(job?.salaryMaxK);
  const hasRange = Number.isFinite(minK) && Number.isFinite(maxK) && minK > 0 && maxK > 0;
  const midK = hasRange ? (minK + maxK) / 2 : (Number.isFinite(Number(job?.salaryK)) ? Number(job?.salaryK) : null);

  // 如果有 grossMonthly 直接用，否则从 K 换算
  const grossMonthly = job?.grossMonthly != null ? Number(job?.grossMonthly) : null;

  const input = {
    grossMonthly,
    salaryK: grossMonthly == null ? midK : undefined,
    lowK: hasRange ? minK : undefined,
    highK: hasRange ? maxK : undefined,
    monthsSalary: job?.salaryMonths,
    commuteMode: job?.commuteMode,
    // 0 km 是合法距离（宿舍/住得近），|| 会把它误吞成「缺单程距离」；必须用 ??
    oneWayKm: job?.distanceKm ?? job?.oneWayKm,
    socialBase: job?.socialBase,
    fundRate: job?.fundRate,
    specialDeduct: job?.specialDeduct,
    workdays: job?.workdays,
  };

  const rawCard = computeValueCard(input);
  return toValueCard(rawCard, jobId);
}

// —— 内部工具 ——
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function pct(r) {
  return `${Math.round(r * 10000) / 100}%`;
}

// 社保比例标签直接取自 calculator 的 SOCIAL_RATES（env 可覆盖）；
// 原先另立 SOCIAL_RATES_PCT 硬编码副本，env 改比例后标签会与真实计算口径说谎不一致，已删。

/**
 * 根据卡片状态生成风险警告
 */
function buildWarning(rawCard) {
  const warnings = [];
  if (!rawCard.commute?.known) {
    warnings.push("通勤方式未确认");
  }
  if (rawCard.sources?.specialDeduct?.includes("未计")) {
    warnings.push("未计入专项附加扣除(估算偏保守)");
  }
  if (rawCard.grossRange) {
    warnings.push("薪资为区间,显示中值算式");
  }
  return warnings.length > 0 ? warnings.join("; ") : undefined;
}
