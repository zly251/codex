// M3 copilot 模块 — 聊天话术建议核心逻辑
// 纯函数：无 DB、无网络、无 LLM 调用。
//
// 架构红线（docs/06_TARGET_ARCHITECTURE.md §5 M3）——本文件是"编排层"，
// 真正的守卫在 ./guard.js，三态判定在 ./intent.js。所有对外输出的 text
// 必须先过 guardSuggestions 再返回，绝不外发未过守卫的文本。
//
//   1. 输出守卫：① 隐私词拦截 ② 技能只能在底细卡 14 词白名单内 ③ ≤160 字截断
//   2. 三态判定：OK（出建议）/ needManual（承诺类只提示人工）/ noChat（无内容）

import {
  SCHEMA_VERSION,
  STATUS,
  MAX_TEXT_LEN,
  GUARD_RESULT,
  validateCopilotResult,
} from "./types.js";
import { decide, detectSuggestionType } from "./intent.js";
import { guardSuggestions, loadWhitelistTerms } from "./guard.js";

// 候选话术模板（兜底来源）。模板只是"候选生成器"，产出的每条 text
// 一律要过守卫，所以这里即便写了越界词也会在 guardSuggestions 阶段被拦下。
const TEMPLATES = {
  greeting: [
    "您好，我对贵公司的{jobTitle}职位很感兴趣，方便聊聊吗？",
    "您好，看到{companyName}在招{jobTitle}，我想了解一下岗位详情。",
  ],
  followup: [
    "请问这个岗位的具体工作内容是什么？",
    "请问这个岗位的团队规模和汇报关系是怎样的？",
    "这个岗位目前最希望解决的核心问题是什么？",
  ],
  salary: [
    "请问这个岗位的薪资范围和五险一金是怎么缴纳的？",
    "方便说下这个岗位的薪资结构和考核方式吗？",
  ],
  interview: [
    "好的，我这边时间比较灵活，方便确认下具体的面试时间和地点吗？",
    "请问面试大概需要多长时间？需要提前准备什么材料吗？",
  ],
  contact: [
    "我的联系方式和教育、项目经历都在简历里，方便您查看一下吗？",
    "简历里有我的电话和邮箱，您看方便安排下一步吗？",
  ],
};

const PRIORITY = { greeting: 5, salary: 4, interview: 4, followup: 3, contact: 3 };

// 填充模板里的 {var} 占位符
function fillTemplate(template, vars) {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, "g"), value || "");
  }
  return result.trim();
}

/**
 * 组装候选话术：外部草稿（如 LLM/其它生产者产出的 text）优先，模板兜底。
 * 两者都只产出"候选"，真正的放行/拦截/截断由守卫决定。
 */
function buildCandidates(input, type, drafts) {
  const vars = {
    jobTitle: String(input?.jobTitle || ""),
    companyName: String(input?.companyName || ""),
  };
  const candidates = [];

  // 1) 外部草稿：必须先声明来源字段，才会被当作候选（默认没有草稿）
  for (const d of drafts) {
    const text = typeof d === "string" ? d : String(d?.text || "");
    if (!text.trim()) continue;
    candidates.push({
      type: (typeof d === "object" && d?.type) || type,
      text,
      priority: typeof d === "object" && Number.isFinite(d?.priority) ? d.priority : PRIORITY[type] ?? 3,
    });
  }

  // 2) 模板兜底候选
  const templates = TEMPLATES[type] || TEMPLATES.followup;
  for (const tpl of templates) {
    candidates.push({ type, text: fillTemplate(tpl, vars), priority: PRIORITY[type] ?? 3 });
  }

  return candidates;
}

// 汇总整体守卫结果标记
function overallResult(kept, blockedCount, truncatedCount) {
  if (kept.length === 0) return GUARD_RESULT.BLOCKED;
  return truncatedCount > 0 ? GUARD_RESULT.TRUNCATED : GUARD_RESULT.PASS;
}

/**
 * 生成建议话术（全量过守卫 + 三态判定）。
 * @param {object} input — {jobTitle, companyName, pageText, hrMsg, chatHistory[]}
 * @param {{whitelist?: string[], drafts?: Array<string|{type,text,priority}>}} [opts]
 * @returns {CopilotResult}
 */
export function generateSuggestions(input = {}, opts = {}) {
  // 白名单真源来自底细卡；调用方可显式注入（测试用），否则读盘。
  const whitelist = opts.whitelist || loadWhitelistTerms();
  const drafts = Array.isArray(opts.drafts) ? opts.drafts : (Array.isArray(input?.drafts) ? input.drafts : []);

  // ── 三态判定（真实触发条件，不是永远同一态）──
  const decision = decide(input);
  const base = {
    schemaVersion: SCHEMA_VERSION,
    status: decision.status,
    decisionReason: decision.reason,
    decision,
    llmFailed: false,
  };

  if (decision.status === STATUS.NO_CHAT) {
    return finalize({
      ...base,
      ok: false,
      suggestions: [],
      blocked: [],
      guard: { result: GUARD_RESULT.BLOCKED, blockedCount: 0, truncatedCount: 0, reasons: [decision.reason] },
      reason: decision.reason,
    });
  }

  if (decision.status === STATUS.NEED_MANUAL) {
    return finalize({
      ...base,
      ok: false,
      suggestions: [],
      blocked: [],
      guard: { result: GUARD_RESULT.BLOCKED, blockedCount: 0, truncatedCount: 0, reasons: [decision.reason] },
      reason: decision.reason,
    });
  }

  // ── OK：生成候选 → 全部过守卫 → 只外发放行项 ──
  const type = detectSuggestionType(input);
  const candidates = buildCandidates(input, type, drafts);
  const { kept, blocked, stats } = guardSuggestions(candidates, { whitelist, maxLen: MAX_TEXT_LEN });

  const reasons = [];
  for (const b of blocked) if (b.reason) reasons.push(b.reason);

  return finalize({
    ...base,
    ok: kept.length > 0,
    suggestions: kept.map((k) => ({ type: k.type, text: k.text, priority: k.priority, guard: k.guard })),
    blocked,
    guard: {
      result: overallResult(kept, blocked.length, stats.truncated),
      blockedCount: blocked.length,
      truncatedCount: stats.truncated,
      reasons,
    },
    reason:
      kept.length > 0
        ? `基于聊天上下文生成 ${kept.length} 条建议（类型：${type}；已过滤 ${blocked.length} 条越界/重复）`
        : `候选话术全部被守卫拦截（${reasons.join("；") || "无候选"}）`,
  });
}

function finalize(result) {
  const errors = validateCopilotResult(result);
  if (errors.length > 0) result._validationErrors = errors;
  return result;
}
