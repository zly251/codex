// 浏览器扩展 /api/extension/look 的纯逻辑（V0 · 任务卡步骤 2）
// 原则：
//  - 钱的数字全部走 src/value.mjs 代码计算，LLM 不参与（防幻觉）。
//  - 话术建议走既有 llmProvider 兜底链；输出前逐条 sanitizePromptText 打码红线。
//  - needManual（offer/合同/外包类）拦截沿用 classifyIntent，与自动化聊天同一政策。
// 本模块不发网络、不碰 DB：server 注入 profile/resumeEditor，LLM 可注入替身（测试用）。

import {
  buildSafeResumeText,
  classifyIntent,
  generateText,
  sanitizePromptText,
  templateReply,
} from "./llmProvider.js";
import { computeValueCard } from "./value.mjs";

const MAX_PAGE_CHARS = 4000; // content.js 已截 4000，这里再钳一次防直连调用方
const TAIL_CHARS = 220; // 取对话尾部做"HR 最近的意思"，太长会把陈旧话题带进意图判断

// —— 页面尾部 → 意图判断输入 ——
// BOSS 聊天页把职位卡渲染成一行行碎片文本（「职位名 / 6-10K / 北京 / 经验不限」），
// 且职位卡上常印「五险一金」等词——若按物理行取尾部，职位卡/系统卡碎片会混进意图判断，
// 把 offer 词表误触发成 needManual（2026-09-25 真机验收踩到的坑）。
// 对策：①丢超短碎片行；②从最后一条含句末标点的行起截，职位卡头部不带标点自然被排除。
const FRAG_MAX = 12; // ≤12 字且无标点的行视为卡片碎片
const SENT_END_RE = /[？?！!。；;，,：:~…】）)"'’”]$/;

export function tailOfPageText(pageText) {
  const lines = String(pageText || "")
    .slice(-MAX_PAGE_CHARS)
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !(l.length <= FRAG_MAX && !/[？?！!。；;，,：:]/.test(l))); // 去卡片碎片行
  let start = Math.max(0, lines.length - 8);
  for (let i = lines.length - 1; i >= start; i--) {
    if (SENT_END_RE.test(lines[i])) {
      start = i; // 最后一条真实消息句起截
      break;
    }
  }
  if (!lines.length) {
    // 全被碎片过滤吃掉：退回原始最后 8 行（宁可带点噪音，也不能空→触发不了建议）
    const raw = String(pageText || "").split(/\n+/).map((l) => l.trim()).filter(Boolean);
    return raw.slice(-8).join(" ").slice(-TAIL_CHARS);
  }
  return lines.slice(start).join(" ").slice(-TAIL_CHARS);
}

// —— 从页面文本抽薪资（K 口径，与 salary.js 一致）——
// 支持 "6-8K"、"6~8K·13薪"、"8K"；12..16 才认作几薪，防止把"15天薪"之类带偏。
const SALARY_RANGE_RE =
  /(\d+(?:\.\d+)?)\s*(?:[-~]|至|到)\s*(\d+(?:\.\d+)?)\s*(?:K|k|千)(?:\s*[·(（]\s*(\d{2})\s*薪)?/;
const SALARY_SINGLE_RE = /(\d+(?:\.\d+)?)\s*(?:K|k)(?:\s*[·(（]\s*(\d{2})\s*薪)?(?![\w.])/;
const MONTHS_SALARY_RE = /(\d{2})\s*薪/;

function monthsSalaryFrom(raw) {
  const m = String(raw || "").match(MONTHS_SALARY_RE);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 12 && n <= 16 ? n : null;
}

/** 返回 {salaryK, monthsSalary, matched} 或 null；salaryK 取区间中值 */
function parseSalaryFrom(s) {
  let min = null;
  let max = null;
  let matched = "";
  let months = null;

  const range = s.match(SALARY_RANGE_RE);
  if (range) {
    min = Number(range[1]);
    max = Number(range[2]);
    matched = range[0];
    months = monthsSalaryFrom(range[3] ? `${range[3]}薪` : s);
  } else {
    const single = s.match(SALARY_SINGLE_RE);
    if (single) {
      min = max = Number(single[1]);
      matched = single[0];
      months = monthsSalaryFrom(single[2] ? `${single[2]}薪` : s);
    }
  }
  if (min == null || !Number.isFinite(min) || min <= 0) return null;
  if (!Number.isFinite(max) || max <= 0) max = min;
  if (max < min) [min, max] = [max, min];
  return { salaryK: (min + max) / 2, lowK: min, highK: max, monthsSalary: months, matched };
}

/**
 * 聊天页优先从职位卡头部抽薪资：锚点「查看职位」前、逐行向上最多 6 行内第一个可解析薪资。
 * 真机踩坑（2026-09-25）：全文扫会先撞上左侧联系人列表里别的职位薪资（19K ≠ 当前职位 6-10K）。
 * 有锚点但卡头窗口无薪资 → 返回 null（该职位确实没标薪，绝不回退全文抽错职位）。
 */
export function extractSalaryFromText(pageText) {
  const s = String(pageText || "");
  const anchor = s.lastIndexOf("查看职位");
  if (anchor >= 0) {
    const head = s
      .slice(Math.max(0, anchor - 400), anchor)
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean);
    for (let i = head.length - 1, n = 0; i >= 0 && n < 6; i--, n++) {
      const hit = parseSalaryFrom(head[i]);
      if (hit) return hit;
    }
    return null;
  }
  return parseSalaryFrom(s);
}

// —— 岗位名抽取（侧栏顶部展示用）——
// 版式实证（2026-09-25 真机 debug 日志）：聊天页当前会话面板首行 = 「姓名 公司 HR」，
// 次行 = 职位卡标题；详情页标题在「查看职位」锚点之前。
// 真机另一坑：content.js 早期把整页压成一整行（\s+→空格），此时按行取会失败，
// 故对「单行糊版式」退化为按空格切 token 取最长者。薪资/城市/导航等噪音行一律跳过。
const HR_ROLE_RE = /HR|招聘者|人事|经理|主管|总监|CEO|创始人|顾问/i;
function isNoiseToken(l) {
  return (
    /^\d/.test(l) || // 薪资行：6-10K、8K、13000
    /^(?:薪资|月薪|年薪|经验|学历|兼职|全职|首页|搜索|更多|职位|公司|查看)/.test(l) ||
    !/[\u4e00-\u9fffA-Za-z]/.test(l) || // 纯符号/数字
    /^(?:[+＋\-－*·、，。！？【】]+)$/.test(l)
  );
}
// 城市/地点行：以行政区后缀结尾且很短（「北京」「北京市朝阳区」），不是职位标题
function isLocationToken(l) {
  return l.length <= 8 && /(?:区|县|市|省|镇|街道)$/.test(l);
}

function pickTitle(cands) {
  let best = null;
  for (const c of cands) {
    const l = String(c || "").trim();
    if (l.length < 4 || l.length > 60) continue;
    if (isNoiseToken(l) || isLocationToken(l) || HR_ROLE_RE.test(l)) continue;
    if (!best || l.length > best.length) best = l; // 标题通常是候选里最长的一条
  }
  return best;
}

export function extractJobTitleFromText(pageText, href = "") {
  const raw = String(pageText || "");
  const lines = raw.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const detail = /job_detail|\/job\/|jobid/i.test(String(href || ""));

  // 多行版式：只看「查看职位」之前的卡头区域（详情页）或前几行（聊天页）
  const ai = lines.findIndex((l) => l.includes("查看职位"));
  let region;
  if (detail) {
    region = ai >= 0 ? lines.slice(0, ai) : lines.slice(0, 8);
  } else {
    region = ai >= 0 ? lines.slice(0, ai) : lines.slice(0, 3);
    // 聊天页首行是 HR 姓名行，显式丢掉
    if (region.length && HR_ROLE_RE.test(region[0])) region = region.slice(1);
  }
  if (region.length > 1 || (region.length === 1 && region[0].split(/\s+/).length <= 2)) {
    const hit = pickTitle(region);
    if (hit) return hit;
  }
  // 单行糊版式兜底：按空格切 token，取锚点前最长非噪音 token
  const before = ai >= 0 ? raw.slice(0, raw.indexOf("查看职位")) : raw.slice(0, 200);
  return pickTitle(before.split(/[\s|｜]+/));
}

// —— LLM 建议输出解析：每行「标签|正文」——
const SUGGESTION_LINE_RE = /^\s*(?:[-*]\s*)?(?:\d+[.、]\s*)?([^|｜]{1,12})\s*[|｜]\s*(.+?)\s*$/;

export function parseSuggestionLines(text, max = 3) {
  const out = [];
  const seen = new Set();
  for (const rawLine of String(text || "").split(/\n+/)) {
    if (out.length >= max) break;
    const m = rawLine.match(SUGGESTION_LINE_RE);
    if (!m) continue;
    const label = m[1].replace(/[*_`]/g, "").trim();
    let body = m[2].trim().replace(/^["“「]|["”」]$/g, "");
    if (!label || !body) continue;
    body = sanitizePromptText(body).slice(0, 160);
    if (!body || seen.has(body)) continue;
    seen.add(body);
    out.push({ label: label.slice(0, 12), text: body });
  }
  return out;
}

function buildSuggestionPrompt({ chatTail, safeResume, hrMsg }) {
  const resumeBlock = safeResume ? `\n<候选人底细>\n${safeResume}\n</候选人底细>` : "";
  return [
    "你是求职者在 BOSS 直聘上的回复参谋。以下是聊天页最近内容（可能混杂双方消息）：",
    `<chat>\n${chatTail}\n</chat>${resumeBlock}`,
    `候选人要回给对方的上一句是：${hrMsg}`,
    "请给出 3 条回复候选，规则：",
    "1) 每条一行，格式「短标签|正文」，标签≤6字（如：追问薪资、约面试、表态意向）；",
    "2) 正文≤80字，口语化、礼貌，直接可以发给 HR；",
    "3) 只依据候选人底细，不许编造技能/经历；不写手机号、微信、地址等联系细节；",
    "4) 不做录用/合同/入职类承诺；",
    "5) 三条角度要不同。只输出这 3 行，不要其他内容。",
  ].join("\n");
}

/**
 * 组装 /api/extension/look 响应。
 * input: {pageText, href, commuteMode, oneWayKm, profile, resume, resumeEditor, expectedSalary}
 * deps:  {env, generateText}（测试注入 LLM 替身）
 */
export async function buildLookResponse(input = {}, deps = {}) {
  const env = deps.env || process.env;
  const gen = deps.generateText || generateText;
  const pageText = String(input.pageText || "").slice(0, MAX_PAGE_CHARS);
  const profile = input.profile || {};
  const name = profile.name || "用户";
  const skills = profile.skills || "";

  if (!pageText.trim()) {
    return {
      ok: true,
      noChat: true,
      jobTitle: null,
      needManual: false,
      suggestions: [],
      value: { ok: false, reason: "未识别到聊天内容" },
    };
  }

  const chatTail = tailOfPageText(pageText);
  const intent = classifyIntent(chatTail);
  const jobTitle = extractJobTitleFromText(pageText, input.href);

  // —— 含金量卡：代码算，先于 LLM，needManual 时也要出 ——
  const salary = extractSalaryFromText(pageText);
  const value = salary
    ? computeValueCard({
        salaryK: salary.salaryK,
        lowK: salary.lowK,
        highK: salary.highK,
        monthsSalary: salary.monthsSalary || undefined,
        commuteMode: input.commuteMode,
        oneWayKm: input.oneWayKm,
      })
    : { ok: false, reason: "页面未识别到薪资数字" };
  if (salary && value.ok) value.salaryMatched = salary.matched;

  if (intent.needManual) {
    return { ok: true, jobTitle, needManual: true, reason: intent.reason, suggestions: [], value };
  }

  // —— 话术建议 ——
  const safeResumeText =
    input.safeResumeText ||
    buildSafeResumeText({
      profile,
      resume: input.resume,
      resumeEditor: input.resumeEditor,
      expectedSalary: input.expectedSalary,
      env,
    });
  const prompt = buildSuggestionPrompt({ chatTail, safeResume: safeResumeText, hrMsg: chatTail });

  let suggestions = [];
  let llmFailed = false;
  try {
    const raw = await gen(prompt, { env, maxTokens: 400, temperature: 0.8 });
    suggestions = parseSuggestionLines(raw);
  } catch (e) {
    llmFailed = true;
  }
  if (!suggestions.length) {
    // 兜底：LLM 全链失败或输出不合格式 → 模板话术 1 条，明确标「兜底」
    const tpl = templateReply(chatTail, name, skills, { env });
    const text = sanitizePromptText(String(typeof tpl === "string" ? tpl : tpl?.reply || "")).slice(0, 160);
    if (text) suggestions = [{ label: "兜底模板", text }];
  }

  return {
    ok: true,
    jobTitle,
    needManual: false,
    intent: intent.kind,
    llmFailed,
    suggestions,
    value,
  };
}
