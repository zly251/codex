// M3 copilot 模块 — 输出守卫（A5 红线）
// 纯函数：无 DB、无网络、无 LLM 调用。所有对外话术必须先过这里。
//
// 三条红线（docs/06_TARGET_ARCHITECTURE.md §5 M3）：
//   1. 建议条数截断 ≤160 字、正文去重
//   2. 技能只能在底细卡 14 词白名单内
//   3. LLM 吐手机号/邮箱/身份证/具体住址/精确生日必被隐藏（这里实现为"整条拦截"）
//
// 白名单真源 = prompts/candidate-card.md 的 <!-- WHITELIST-BEGIN/END --> 标记区。
// 本文件只做解析，不复制词条（复制会随卡片签字漂移）。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MAX_TEXT_LEN, GUARD_RESULT } from "./types.js";

export const WHITELIST_BEGIN = "<!-- WHITELIST-BEGIN -->";
export const WHITELIST_END = "<!-- WHITELIST-END -->";

// 模块自身位置 → 仓库根 → prompts/candidate-card.md
// src/modules/copilot/guard.js → ../../../ = 仓库根
const DEFAULT_CARD_URL = new URL("../../../prompts/candidate-card.md", import.meta.url);
export const DEFAULT_CARD_PATH = fileURLToPath(DEFAULT_CARD_URL);

// 归一化：去空白/括号注释，ASCII 转小写（与既有 candidateCardWhitelistTerms 口径一致）
export function normalizeTerm(term) {
  return String(term || "")
    .replace(/（[^）]*）/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/^\s*[-*+·]\s*/, "")
    .replace(/`/g, "")
    .trim()
    .toLowerCase();
}

/**
 * 解析底细卡文本中的技能白名单（真源）。
 * 有 WHITELIST 标记区 → 区内一行一词；无标记区 → 返回空数组（不猜）。
 * @param {string} cardText
 * @returns {string[]} 归一化后的白名单词
 */
export function parseWhitelistTerms(cardText) {
  const text = String(cardText || "");
  const b = text.indexOf(WHITELIST_BEGIN);
  const e = text.indexOf(WHITELIST_END);
  if (b === -1 || e === -1 || e <= b) return [];
  const scope = text.slice(b + WHITELIST_BEGIN.length, e);
  const terms = new Set();
  for (const rawLine of scope.split(/\r?\n/)) {
    // 标记区内一行一词；同一行若用顿号/逗号连写也逐条拆（既有实现的解析口径）
    for (const rawEntry of rawLine.split(/[、，,;；]+/)) {
      const t = normalizeTerm(rawEntry);
      if (t.length >= 1) terms.add(t);
    }
  }
  return Array.from(terms);
}

/**
 * 从底细卡文件读白名单。读不到 → 空数组（调用方须按"无白名单则不敢放行技能"处理）。
 * @param {string} [cardPath]
 * @returns {string[]}
 */
export function loadWhitelistTerms(cardPath = DEFAULT_CARD_PATH) {
  try {
    return parseWhitelistTerms(readFileSync(cardPath, "utf8"));
  } catch {
    return [];
  }
}

// ── 隐私词（命中即拦截，不许外发）────────────────────────────────
// 每条给一个稳定的 id，便于测试断言与留痕。
export const PRIVACY_PATTERNS = [
  { id: "phone", label: "手机号", re: /(?<!\d)1[3-9]\d{9}(?!\d)/ },
  { id: "idCard", label: "身份证号", re: /(?<!\d)\d{17}[\dXx](?!\d)/ },
  { id: "bankCard", label: "银行卡号", re: /(?<!\d)\d{16,19}(?!\d)/ },
  { id: "wechat", label: "微信号", re: /微信|wechat|wxid/i },
  {
    id: "address",
    label: "具体住址",
    re: /住址|家庭地址|居住地址|详细地址|地址\s*[:：]|[\u4e00-\u9fa5]{2,8}(?:省|市)[\u4e00-\u9fa5]{2,8}(?:区|县)[\u4e00-\u9fa5]{2,12}(?:路|街|道|小区)\s*\d*\s*号?/,
  },
  { id: "email", label: "邮箱", re: /[\w.+-]+@[\w-]+\.[\w.]+/ },
  { id: "birthday", label: "精确生日", re: /(?<!\d)\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?(?!\d)/ },
];

/**
 * 扫描隐私词。命中即返回（不脱敏替换——A5 口径是"必被隐藏"，整条不下发）。
 * @returns {null | {id, label, matched}}
 */
export function scanPrivacy(text) {
  const s = String(text || "");
  for (const p of PRIVACY_PATTERNS) {
    const m = p.re.exec(s);
    if (m) return { id: p.id, label: p.label, matched: m[0] };
  }
  return null;
}

// ── 技能白名单 ──────────────────────────────────────────────────
// 技术专有名词表：白名单词 + 已知禁区词。只有"出现在这张表里的词"才被当成技能认领，
// 避免把 offer / 随便一个英文单词误判成技能。
export const KNOWN_TECH_TERMS = [
  "qt", "c++", "c#", "python", "java", "javascript", "typescript", "go", "golang", "rust",
  "solidworks", "autocad", "cad", "cuda", "gguf", "mcp", "docker", "ffmpeg", "playwright",
  "flask", "github", "vue", "react", "node", "linux", "mysql", "opencv", "pytorch",
];

// 泛词：底细卡明确"刻意避开"的认领词；只在第一人称认领语境下算违规，
// 避免把岗位名里的"Qt桌面开发工程师"误判成候选人自我认领。
const GENERIC_CLAIM_RE =
  /(?:我会|我能|我做过|我熟悉|我精通|我负责|擅长|熟悉|精通|用过)?\s*(?:独立)?(开发|编程|写代码|底层代码|项目经验)/;

/**
 * 抽取话术里的技能认领，并按白名单分流。
 * @param {string} text
 * @param {string[]} whitelist 已归一化的白名单词
 * @returns {{allowed: string[], offenders: string[]}}
 */
export function extractSkillMentions(text, whitelist = []) {
  const s = String(text || "");
  const wl = new Set((whitelist || []).map(normalizeTerm).filter(Boolean));
  const allowed = [];
  const offenders = [];
  const seen = new Set();

  const note = (term, ok) => {
    const key = `${ok ? "a" : "o"}:${term}`;
    if (seen.has(key)) return;
    seen.add(key);
    (ok ? allowed : offenders).push(term);
  };

  // 1) ASCII / 专有名词：只有当词出现在 KNOWN_TECH_TERMS 或白名单时才判定
  const vocab = new Set([...KNOWN_TECH_TERMS, ...wl]);
  for (const term of vocab) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // 词边界：中文语境下前后允许非字母数字
    const re = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "i");
    if (re.test(s)) note(term, wl.has(term));
  }

  // 2) 中文白名单词（如"需求分析"）出现即放行记录
  for (const term of wl) {
    if (/[a-z]/i.test(term)) continue; // ASCII 已处理
    if (s.includes(term)) note(term, true);
  }

  // 3) 泛词认领：命中且该泛词不在白名单 → 违规
  const g = GENERIC_CLAIM_RE.exec(s);
  if (g) {
    const word = g[1];
    if (!wl.has(word)) note(word, false);
  }

  return { allowed, offenders };
}

/**
 * 技能白名单守卫：话术里出现的技能词必须全部落在白名单内。
 * @returns {{ok: boolean, reason: string, offenders: string[]}}
 */
export function checkSkillWhitelist(text, whitelist = []) {
  const { offenders } = extractSkillMentions(text, whitelist);
  if (offenders.length === 0) return { ok: true, reason: "", offenders: [] };
  return {
    ok: false,
    reason: `技能词不在底细卡白名单内：${offenders.join("、")}`,
    offenders,
  };
}

// ── 160 字截断 ──────────────────────────────────────────────────
const SENTENCE_END = /[。！？；!?；]/;
const ELLIPSIS = "…";

/**
 * 截断到 ≤max 字符，且必须以完整句或省略号收尾。
 * @param {string} text
 * @param {number} [max]
 * @returns {{text: string, truncated: boolean}}
 */
export function truncateText(text, max = MAX_TEXT_LEN) {
  const s = String(text || "");
  if (s.length <= max) return { text: s, truncated: false };

  // 先按 max 切，再回退到最后一个句末标点
  const head = s.slice(0, max);
  let cut = -1;
  for (let i = head.length - 1; i >= Math.floor(max / 2); i--) {
    if (SENTENCE_END.test(head[i])) {
      cut = i + 1;
      break;
    }
  }
  if (cut > 0) return { text: head.slice(0, cut), truncated: true };
  // 没有可落脚的句末标点 → 砍到 max-1 再补省略号（总长 = max）
  return { text: s.slice(0, max - 1) + ELLIPSIS, truncated: true };
}

// ── 单条守卫 ────────────────────────────────────────────────────
/**
 * 对一条候选话术执行完整守卫。顺序：隐私 → 技能白名单 → 截断。
 * @param {string} text
 * @param {{whitelist?: string[], maxLen?: number}} [opts]
 * @returns {{ok, result: "PASS"|"TRUNCATED"|"BLOCKED", text, reason, guard: object}}
 */
export function guardText(text, opts = {}) {
  const whitelist = opts.whitelist || [];
  const maxLen = opts.maxLen || MAX_TEXT_LEN;
  const raw = String(text || "");

  if (!raw.trim()) {
    return {
      ok: false,
      result: GUARD_RESULT.BLOCKED,
      text: "",
      reason: "空话术",
      guard: { result: GUARD_RESULT.BLOCKED, reason: "空话术" },
    };
  }

  const privacy = scanPrivacy(raw);
  if (privacy) {
    return {
      ok: false,
      result: GUARD_RESULT.BLOCKED,
      text: "",
      reason: `隐私词拦截（${privacy.label}）`,
      guard: { result: GUARD_RESULT.BLOCKED, reason: `隐私词拦截（${privacy.label}）`, hit: privacy.id },
    };
  }

  const skill = checkSkillWhitelist(raw, whitelist);
  if (!skill.ok) {
    return {
      ok: false,
      result: GUARD_RESULT.BLOCKED,
      text: "",
      reason: skill.reason,
      guard: { result: GUARD_RESULT.BLOCKED, reason: skill.reason, hit: "skill_whitelist" },
    };
  }

  const { text: cut, truncated } = truncateText(raw, maxLen);
  return {
    ok: true,
    result: truncated ? GUARD_RESULT.TRUNCATED : GUARD_RESULT.PASS,
    text: cut,
    reason: truncated ? `超长已截断至 ${cut.length} 字` : "",
    guard: {
      result: truncated ? GUARD_RESULT.TRUNCATED : GUARD_RESULT.PASS,
      reason: truncated ? `超长已截断至 ${cut.length} 字` : "",
    },
  };
}

// ── 批量守卫 + 去重 ─────────────────────────────────────────────
export function normalizeForDedup(text) {
  return String(text || "")
    .replace(/[\s\u3000]/g, "")
    .replace(/[，。！？；：、“”‘’（）,.!?;:"'()]/g, "");
}

/**
 * 对候选列表过守卫并去重。
 * @param {Array<{type, text, priority}>} candidates
 * @param {{whitelist?: string[], maxLen?: number}} [opts]
 * @returns {{kept: Array, blocked: Array, stats: {total, kept, blocked, truncated}}}
 */
export function guardSuggestions(candidates = [], opts = {}) {
  const kept = [];
  const blocked = [];
  const seen = new Set();
  let truncated = 0;

  for (const c of candidates || []) {
    const text = typeof c === "string" ? c : c?.text;
    const g = guardText(text, opts);
    const base = typeof c === "string" ? { type: "followup", text, priority: 3 } : { ...c };

    if (!g.ok) {
      blocked.push({ ...base, text: String(text || ""), guard: g.guard, reason: g.reason });
      continue;
    }
    const dedupKey = normalizeForDedup(g.text);
    if (dedupKey && seen.has(dedupKey)) {
      blocked.push({ ...base, text: g.text, guard: { result: "BLOCKED", reason: "正文重复" } });
      continue;
    }
    if (dedupKey) seen.add(dedupKey);
    if (g.result === GUARD_RESULT.TRUNCATED) truncated++;
    kept.push({ ...base, text: g.text, guard: g.guard });
  }

  return {
    kept,
    blocked,
    stats: {
      total: (candidates || []).length,
      kept: kept.length,
      blocked: blocked.length,
      truncated,
    },
  };
}
