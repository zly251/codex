// M3 copilot 模块 — 三态判定（意图分类 + 能否给建议）
// 纯函数，无 DB、无网络、无 LLM 依赖
//
// 三态契约（docs/06_TARGET_ARCHITECTURE.md §5 M3）：
//   正常建议 / needManual（offer·社保·薪资谈判类不出建议只提示人工）/ noChat（空 pageText）
//
// 口径继承 src/llmProvider.js:845 classifyIntent()（用户 2026-09-19 授权范围内 changelog），
// 在模块内重新实现是因为 G4 守卫禁止 L2 模块 import src/ 根目录旧链文件。

import { STATUS } from "./types.js";

// offer/合同/社保类 → 需要人工（承诺类内容，宁可过拦不可漏放）
const OFFER_RE =
  /\boffer\b|录用|入职确认|确认入职|入职日期|入职时间|签合同|签协议|劳动合同|试用期|转正|社保|公积金|五险一金|工资卡|背调|体检|押金|违约金|竞业/;
// 外包/驻场/派遣 → 需要人工（卡内红线）
const OUTSOURCING_RE = /外包|驻场|派遣|中介|代招/;
const INTERVIEW_MENTION_RE = /面试|面谈|复试|初试|视频面试|线下面试|到面|到店|hr面|试岗/;
const INTERVIEW_SCHEDULING_RE = /时间|地点|地址|日期|安排|约|预约|通知|确认|几点|什么时候|在哪|哪里|方便面试/;
// 裸邀约兜底："明天上午10点来面试吧"这类不带"时间/地点"字样
const INTERVIEW_INVITE_SIGNALS_RE =
  /(明天|后天|今天|本周|下周|周[一二三四五六日天]|\d+点|\d+号|上午|下午|来|到|参加|安排|约|定)/;
const SALARY_RE = /薪资|工资|待遇|薪酬|多少钱|期望薪|底薪|提成|涨薪|加薪|13薪|14薪|年终奖/;
const CONTACT_RE = /微信|wechat|手机号|手机号码|电话|联系方式|怎么联系|加个微信/;

function lastUserText(input) {
  const history = Array.isArray(input?.chatHistory) ? input.chatHistory : [];
  for (let i = history.length - 1; i >= 0; i--) {
    const t = String(history[i]?.text || "");
    if (t.trim()) return t;
  }
  return String(input?.hrMsg || "");
}

function contextText(input) {
  return [
    String(input?.pageText || ""),
    String(input?.hrMsg || ""),
    Array.isArray(input?.chatHistory)
      ? input.chatHistory.map((m) => String(m?.text || "")).join("\n")
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * 三态判定。
 * 优先级：noChat（无文本） > needManual（承诺类） > OK。
 * @param {object} input — {pageText, hrMsg, chatHistory[]}
 * @returns {{status: string, reason: string, matched: string[], signals: object, intents: string[]}}
 */
export function decide(input = {}) {
  const pageText = String(input?.pageText || "");
  const history = Array.isArray(input?.chatHistory) ? input.chatHistory : [];
  const hasText = pageText.trim().length > 0 || String(input?.hrMsg || "").trim().length > 0
    || history.some((m) => String(m?.text || "").trim());

  if (!hasText) {
    return {
      status: STATUS.NO_CHAT,
      reason: "未识别到聊天内容（pageText/hrMsg/chatHistory 均为空）",
      matched: [],
      signals: { hasText: false },
      intents: [],
    };
  }

  const text = contextText(input);
  const last = lastUserText(input);
  const matched = [];
  const push = (arr) => arr.forEach((x) => matched.includes(x) || matched.push(x));

  const offer = OFFER_RE.exec(text);
  if (offer) {
    push([offer[0]]);
    return {
      status: STATUS.NEED_MANUAL,
      reason: `Offer/合同/试用期/社保类需人工确认（命中「${offer[0]}」；用户 2026-09-19 授权范围内不含这类承诺）`,
      matched: [offer[0]],
      signals: { offer: true },
      intents: ["offer"],
    };
  }

  const outsourcing = OUTSOURCING_RE.exec(text);
  if (outsourcing) {
    return {
      status: STATUS.NEED_MANUAL,
      reason: `外包/驻场/派遣类需人工确认（命中「${outsourcing[0]}」；卡内红线）`,
      matched: [outsourcing[0]],
      signals: { outsourcing: true },
      intents: ["outsourcing"],
    };
  }

  // 以下为可代答意图（2026-09-19 授权范围）
  const mention = INTERVIEW_MENTION_RE.test(text);
  const invite = mention && INTERVIEW_INVITE_SIGNALS_RE.test(text);
  const schedule = mention && INTERVIEW_SCHEDULING_RE.test(text);
  if (invite || schedule) {
    return {
      status: STATUS.OK,
      reason: "面试邀约：可代答（应下 + 问清时间地点），要点转摘要",
      matched: [],
      signals: { interview: true, invite, schedule },
      intents: ["interview"],
    };
  }
  const salary = SALARY_RE.exec(last) || SALARY_RE.exec(text);
  if (salary) {
    return {
      status: STATUS.OK,
      reason: "薪资询问：可按卡内口径代答（先讲可以聊、底线 4000，转看岗位内容）",
      matched: [salary[0]],
      signals: { salary: true },
      intents: ["salary"],
    };
  }
  const contact = CONTACT_RE.exec(text);
  if (contact) {
    return {
      status: STATUS.OK,
      reason: "联系方式询问：引导查看简历，不报号码",
      matched: [contact[0]],
      signals: { contact: true },
      intents: ["contact"],
    };
  }
  return {
    status: STATUS.OK,
    reason: "一般性沟通：可代答",
    matched: [],
    signals: { general: true },
    intents: ["general"],
  };
}

/**
 * 建议类型（模板选择用）。对话进行中优先看最后一条对方消息。
 */
export function detectSuggestionType(input) {
  const last = lastUserText(input);
  const intents = decide({ ...input, _noDecision: true }).intents;
  if (intents.includes("interview")) return "interview";
  if (intents.includes("salary")) return "salary";
  if (intents.includes("contact")) return "contact";
  const history = Array.isArray(input?.chatHistory) ? input.chatHistory : [];
  if (!history.length && !String(input?.hrMsg || "").trim() && String(input?.pageText || "").trim()) {
    return "greeting";
  }
  if (!last.trim()) return "greeting";
  return "followup";
}
