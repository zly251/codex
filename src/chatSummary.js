/**
 * chatSummary.js —— 聊天记录 → 结构化面试要点
 *
 * 定位：这是"自动求职助手"里唯一负责"把 HR 聊天记录变成一份能给用户看的要点"的模块。
 * 用户拿着这份要点自己去面试，所以这里的取舍是：**宁可少抽，不可抽错**。
 * 任何一条抽错的信息都会让用户带着错误时间/地址去面试，代价远大于漏抽。
 *
 * 设计原则：
 * 1. 纯函数优先：extractFacts / buildSummaryPrompt / parseSummaryJson / mergeSummary 都不碰网络、不碰文件、不碰模型。
 *    模型输出不可信 → 解析失败一律退回纯函数抽的骨架，保证"永远有一份可用的摘要"。
 * 2. 畸形输入安全：聊天记录来自页面抓取，字段随时可能缺失或是 null。
 *    所有导出函数对非数组 / null 元素 / text 不是字符串都当空处理，绝不抛异常（宿主在自动流程里调用，抛异常会打断整轮任务）。
 * 3. 隐私：面试摘要文件会留在用户磁盘上，**任何返回或落盘的内容都不允许出现完整 11 位手机号**。
 *    所有字符串出口统一过 maskPhones()，落盘时再对整段 JSON 兜一次底。
 *
 * 零依赖，纯 ESM。
 */

import fs from "node:fs";

/** 单条文本保留的最大长度：聊天句子可能是一整段，截断避免提示词/摘要文件被撑爆 */
const MAX_TEXT = 200;
/** needHuman 最多保留的句子数：只要够用户拍板即可，不做全量堆砌 */
const MAX_NEED_HUMAN = 20;

// ---------------------------------------------------------------------------
// 隐私：手机号打码
// ---------------------------------------------------------------------------

/**
 * 11 位手机号 → 138****1111。（前 3 + **** + 后 4）
 * 为什么是"打码"而不是"[已隐藏]"：摘要文件是给人看的，保留前 3 后 4 位，
 * 用户自己还能对上是谁的号，但泄露完整号码的风险没有了。
 * (?<!\d) / (?!\d) 是必需的：否则 12 位的订单号、18 位身份证会被截出一段假手机号。
 */
const PHONE_RE = /(?<!\d)(1[3-9]\d)(\d{4})(\d{4})(?!\d)/g;

function maskPhones(text) {
  const s = typeof text === "string" ? text : "";
  return s.replace(PHONE_RE, "$1****$3");
}

/** 统一出口：先转成字符串，再打码，再截断。所有对外文本都必须经过它 */
function safeText(value, max = MAX_TEXT) {
  const s = typeof value === "string" ? value : value == null ? "" : String(value);
  const masked = maskPhones(s).trim();
  return max > 0 && masked.length > max ? masked.slice(0, max) : masked;
}

// ---------------------------------------------------------------------------
// 关键词/正则：全部中文规则，注释里写清"为什么这么抽"
// ---------------------------------------------------------------------------

/** 时间词：只要能定位到"什么时候"就够，不解析成 Date（中文口语时间解析不可靠，抽错比不抽更糟） */
const TIME_RE =
  /(明天|后天|今天|周[一二三四五六日天]|星期[一二三四五六日天]|\d{1,2}[:：]\d{2}|\d{1,2}\s*点|上午|下午|晚上|早上|中午|几号|\d{1,2}月\d{1,2}日?|\d{1,2}号)/;

/** 面试相关动作词：只有句子里出现它，才认为这句话在聊面试 */
const INTERVIEW_RE = /面试|面谈|到店|试岗/;

/** 地点词：中文地址句一般靠这些字定位（"路""号""楼"是最短的最强特征） */
const PLACE_RE = /地址|地点|在哪|位置|公司|园区|大厦|路|号|地铁|楼/;

/** 强联系词：命中就等于"这句在留联系方式"，可以直接取 */
const CONTACT_STRONG_RE = /电话|手机|微信|加我|联系方式/;
/**
 * 弱联系词：HR|经理|老师。这些词几乎每句话都出现（"我是HR"），
 * 单靠它取整句会把"您好我是HR"当成联系人记录，属于"抽错"，所以只在句子同时像在留联系方式时才用。
 */
const CONTACT_WEAK_RE = /HR|hr|经理|老师/;
const CONTACT_HINT_RE = /联系|电话|手机|微信|联系方式|方便|加/;

/** 薪资词：薪/工资/底薪/提成/待遇 + 数字K 形式 */
const SALARY_RE = /薪|工资|底薪|提成|待遇|\d+\s*[Kk]|多少K/;

/**
 * 需要用户自己拍板的话题。
 * 为什么是这些：薪资、试用期、社保、合同、入职时间、外包/驻场 —— 这些都不是 AI 能替用户答应的，
 * 一句错答可能让用户丢掉 offer 或者踩进坑里，所以原文原样交给用户。
 */
const NEED_HUMAN_RE = /月薪|多少K|底薪|提成|试用期|社保|合同|offer|入职时间|签|报到|体检|外包|驻场/i;

// ---------------------------------------------------------------------------
// 输入清洗
// ---------------------------------------------------------------------------

function safeObj(value) {
  return value && typeof value === "object" ? value : {};
}

/**
 * 把任意 messages 清洗成 [{role, text, time}]。
 * 页面抓来的数据可能是 null 元素、缺 text、text 是数字，全部当空丢弃 —— 空数据只能少抽，不会抽错。
 */
function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const text = typeof m.text === "string" ? m.text : "";
    if (!text.trim()) continue;
    // role 只认 "hr" / "me"；认不出的角色留空，既不冒充 HR 也不冒充我
    const role = m.role === "hr" ? "hr" : m.role === "me" ? "me" : "";
    out.push({ role, text, time: typeof m.time === "string" ? m.time : "" });
  }
  return out;
}

/**
 * 切句：只按句末标点切，**不按逗号切**。
 * 原因：真实消息常写成"明天下午2点面试，地址在椒江区飞跃科创园81幢"，
 * 按逗号切会把"地址…"变成独立小句，而它本身不含"面试"二字，反而丢了地点。
 * 保留整句虽然啰嗦一点，但上下文完整，人看着也不会误解。
 */
function splitSentences(text) {
  if (typeof text !== "string" || !text) return [];
  return text
    .split(/[。！？!?\n\r；;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 所有消息的全部句子（带 role，便于后续按角色过滤） */
function allSentences(list) {
  const out = [];
  for (const m of list) {
    for (const s of splitSentences(m.text)) out.push({ role: m.role, text: s });
  }
  return out;
}

function uniq(arr) {
  return [...new Set(arr)];
}

// ---------------------------------------------------------------------------
// ① 纯函数抽事实
// ---------------------------------------------------------------------------

const EMPTY_FACTS = {
  hrAsked: [],
  interview: null,
  salaryTalk: "",
  needHuman: [],
  lastHrText: "",
  msgCount: 0,
};

/**
 * 从消息里抽"硬事实"。不调模型：模型可能幻觉出不存在的时间和地址，面试摘要不允许这种错误。
 *
 * @returns {{hrAsked:string[], interview:{time:string,place:string,contact:string}|null,
 *            salaryTalk:string, needHuman:string[], lastHrText:string, msgCount:number}}
 */
export function extractFacts(input) {
  try {
    const { messages } = safeObj(input);
    const list = sanitizeMessages(messages);
    if (!list.length) return { ...EMPTY_FACTS, hrAsked: [], needHuman: [] };

    const sentences = allSentences(list);
    const texts = sentences.map((s) => s.text);

    // —— 面试时间：句子同时命中"面试动作"+"时间词"才算，取那一整句 ——
    const timeSentence = sentences.find((s) => INTERVIEW_RE.test(s.text) && TIME_RE.test(s.text));

    // —— 地点：优先和面试同一句；没有再退到含"地址/地点/位置"的句子（仅在已确认有面试时间时才退，避免乱抓公司名）——
    let placeSentence = sentences.find((s) => INTERVIEW_RE.test(s.text) && PLACE_RE.test(s.text));
    if (!placeSentence && timeSentence) {
      placeSentence = sentences.find((s) => /地址|地点|在哪|位置/.test(s.text));
    }

    // —— 联系人：强联系词直接取；弱联系词（HR/经理/老师）要句子同时像在留联系方式才取 ——
    const contactSentence =
      sentences.find((s) => CONTACT_STRONG_RE.test(s.text)) ||
      sentences.find((s) => CONTACT_WEAK_RE.test(s.text) && CONTACT_HINT_RE.test(s.text));

    const interviewParts = {
      time: timeSentence ? safeText(timeSentence.text) : "",
      place: placeSentence ? safeText(placeSentence.text) : "",
      contact: contactSentence ? safeText(contactSentence.text) : "",
    };
    const hasInterview = Boolean(interviewParts.time || interviewParts.place || interviewParts.contact);

    // —— 薪资：按出现顺序全部保留，多条用 " | " 连接（顺序即对话顺序，人读得出来龙去脉）——
    const salaryTalk = uniq(texts.filter((t) => SALARY_RE.test(t)).map((t) => safeText(t))).join(" | ");

    // —— 需要人工拍板的原句：保留原文，让用户自己判断 ——
    const needHuman = uniq(texts.filter((t) => NEED_HUMAN_RE.test(t)).map((t) => safeText(t))).slice(
      0,
      MAX_NEED_HUMAN
    );

    // —— HR 最近问过什么：最后 3 条 HR 消息，截断 200 字 ——
    const hrTexts = list.filter((m) => m.role === "hr").map((m) => m.text);
    const hrAsked = hrTexts.slice(-3).map((t) => safeText(t));
    const lastHrText = hrTexts.length ? safeText(hrTexts[hrTexts.length - 1]) : "";

    return {
      hrAsked,
      interview: hasInterview ? interviewParts : null,
      salaryTalk,
      needHuman,
      lastHrText,
      msgCount: list.length,
    };
  } catch {
    // 兜底：抽事实绝不能让整轮自动流程挂掉
    return { ...EMPTY_FACTS, hrAsked: [], needHuman: [] };
  }
}

// ---------------------------------------------------------------------------
// ② 提示词
// ---------------------------------------------------------------------------

function safeStringify(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 提示词里要求的 JSON 形状，和 parseSummaryJson 的规整逻辑必须一致（改一处要同步另一处） */
const JSON_SHAPE =
  '{"hrAsked":[],"weAnswered":[],"interview":{"time":"","place":"","contact":""},"salaryTalk":"","nextStep":"","prepare":[]}';

/**
 * 拼提示词。纯字符串拼接，不调模型（宿主自己决定用哪个模型）。
 * profile / card 都可能为 null 或空串：真实调用里"求职者资料没导入""底细卡没生成"都很常见，必须忍。
 */
export function buildSummaryPrompt(input) {
  try {
    const { chatName, messages, profile, card } = safeObj(input);
    const list = sanitizeMessages(messages);
    const facts = extractFacts({ messages: list });

    const lines = [
      "你是求职助理。请把下面这段 BOSS 直聘的聊天记录，整理成给求职者本人看的面试要点。",
      "",
      "【输出要求】只输出一个 JSON 对象，不要解释文字，不要 Markdown 代码块。键固定为：",
      JSON_SHAPE,
      "- hrAsked：HR 问过/关心的问题（字符串数组，最多 5 条）",
      "- weAnswered：我方已经答复过的内容（字符串数组）",
      "- interview：面试时间/地点/联系人，没提到就填空字符串；整段没面试信息填 null",
      "- salaryTalk：薪资相关的讨论，用一句话概括（没聊过填空字符串）",
      "- nextStep：下一步该做什么（一句话）",
      "- prepare：面试前要准备的事项（字符串数组）",
      "只依据聊天记录里真实出现的内容，不要编造时间、地点、薪资数字。",
      "",
      `【会话】${safeText(chatName, 0) || "（未知）"}`,
      `【求职者资料】${safeText(safeStringify(profile), 500) || "（未提供）"}`,
      `【公司底细卡】${safeText(card, 800) || "（无）"}`,
      "",
      "【已由程序抽取的事实（供参考，冲突时以聊天原文为准）】",
      `面试时间：${facts.interview?.time || "（未抽到）"}`,
      `面试地点：${facts.interview?.place || "（未抽到）"}`,
      `薪资相关：${facts.salaryTalk || "（未抽到）"}`,
      `需要人工确认的句子：${facts.needHuman.length ? facts.needHuman.join(" / ") : "（无）"}`,
      "",
      "【聊天记录（按时间正序）】",
    ];
    if (!list.length) {
      lines.push("（无有效消息）");
    } else {
      for (const m of list) {
        const who = m.role === "hr" ? "HR" : m.role === "me" ? "我" : "未知";
        lines.push(`[${who}]${m.time ? ` ${m.time}` : ""} ${safeText(m.text, 300)}`);
      }
    }
    lines.push("", "现在只输出 JSON：");
    return lines.join("\n");
  } catch {
    // 拼不出来也要给宿主一段合法提示词，否则整轮任务白跑
    return `请把聊天记录整理成 JSON，键固定为 ${JSON_SHAPE}，只输出 JSON。`;
  }
}

// ---------------------------------------------------------------------------
// ③ 容错解析
// ---------------------------------------------------------------------------

function toStrArray(value) {
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === "string" ? v : v == null ? "" : safeStringify(v)))
      .map((v) => safeText(v))
      .filter(Boolean);
  }
  // 模型偶尔把数组写成单个字符串，包一层比丢掉信息好
  if (typeof value === "string" && value.trim()) return [safeText(value)];
  return [];
}

function toStr(value) {
  if (typeof value === "string") return safeText(value);
  if (value == null) return "";
  if (typeof value === "object") return "";
  return safeText(String(value));
}

/**
 * 解析模型输出。模型爱包 ```json 代码块、爱在前面写"好的，以下是整理结果："，
 * 所以先剥围栏，再退化为"取第一个 { 到最后一个 }"。
 * 解析不了就返回 null（绝不抛）—— 宿主会据此退回纯函数骨架。
 */
export function parseSummaryJson(text) {
  try {
    if (typeof text !== "string") return null;
    const raw = text.trim();
    if (!raw) return null;

    const candidates = [];
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence && fence[1]) candidates.push(fence[1].trim());
    candidates.push(raw);
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) candidates.push(raw.slice(start, end + 1));

    let parsed = null;
    for (const c of candidates) {
      try {
        const obj = JSON.parse(c);
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
          parsed = obj;
          break;
        }
      } catch {
        // 换下一个候选
      }
    }
    if (!parsed) return null;

    // —— 规整成固定形状：缺键补 [] / ""，非字符串元素转字符串，interview 三个子键补齐 ——
    // 区分"缺键"和"模型明确给了 null"：
    // 缺键多半是模型偷懒漏写 → 补成三个空字符串，保证下游拿到的永远是固定形状；
    // 明确写 null → 尊重模型的判断（这段对话没有面试信息）。
    let interview;
    if (!Object.prototype.hasOwnProperty.call(parsed, "interview")) {
      interview = { time: "", place: "", contact: "" };
    } else if (parsed.interview === null) {
      interview = null;
    } else {
      const src = safeObj(parsed.interview);
      interview = {
        time: toStr(src.time),
        place: toStr(src.place),
        contact: toStr(src.contact),
      };
    }

    return {
      hrAsked: toStrArray(parsed.hrAsked),
      weAnswered: toStrArray(parsed.weAnswered),
      interview,
      salaryTalk: toStr(parsed.salaryTalk),
      nextStep: toStr(parsed.nextStep),
      prepare: toStrArray(parsed.prepare),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// ④ 合并
// ---------------------------------------------------------------------------

function cloneSafe(value) {
  if (!value || typeof value !== "object") return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return Array.isArray(value) ? [...value] : { ...value };
  }
}

/**
 * 同一会话反复生成时按 chatName 覆盖（后写的代表更近的对话状态），其余会话原样保留。
 * updatedAt 每次都用当前时间——它表示"这份文件什么时候被刷新过"，不是单条摘要的时间。
 */
export function mergeSummary(existing, incoming) {
  try {
    const prev = Array.isArray(safeObj(existing).summaries) ? safeObj(existing).summaries : [];
    const out = [];
    for (const s of prev) {
      const copy = cloneSafe(s);
      if (copy && typeof copy === "object" && copy.chatName != null && String(copy.chatName).trim()) out.push(copy);
    }

    const inc = safeObj(incoming);
    const name = inc.chatName == null ? "" : String(inc.chatName).trim();
    if (name) {
      const entry = cloneSafe(inc);
      const idx = out.findIndex((s) => String(s.chatName).trim() === name);
      if (idx >= 0) out[idx] = entry;
      else out.push(entry);
    }

    return { updatedAt: new Date().toISOString(), summaries: out };
  } catch {
    return { updatedAt: new Date().toISOString(), summaries: [] };
  }
}

// ---------------------------------------------------------------------------
// ⑤ 主流程
// ---------------------------------------------------------------------------

function fallbackNextStep() {
  return "需人工查看";
}

/** 从 needHuman 推准备事项：命中就意味着"这件事得用户自己拿主意"，直接转成提示词 */
function fallbackPrepare(needHuman) {
  return (Array.isArray(needHuman) ? needHuman : []).slice(0, MAX_NEED_HUMAN).map((s) => `需人工确认：${safeText(s)}`);
}

/**
 * 对多段会话逐个生成摘要。
 * 顺序固定：extractFacts（先拿到保底事实）→ buildSummaryPrompt → callLLM → parseSummaryJson。
 * 解析失败或 callLLM 抛错都退回骨架，**单个会话失败不影响其他会话**（一段会话的模型超时不该毁掉整批摘要）。
 */
export async function buildSummaries(input) {
  const { chats, callLLM, profile, card, log } = safeObj(input);
  const errors = [];
  const summaries = [];
  let llmUsed = 0;
  let fallbackUsed = 0;

  const say = (msg) => {
    if (typeof log !== "function") return;
    try {
      log(msg);
    } catch {
      // 日志函数自己炸了不能影响摘要
    }
  };

  if (!Array.isArray(chats)) {
    return { summaries: [], llmUsed: 0, fallbackUsed: 0, errors: ["chats 不是数组"] };
  }

  for (const chat of chats) {
    const item = safeObj(chat);
    const chatName = item.chatName == null ? "" : String(item.chatName);
    const messages = sanitizeMessages(item.messages);
    const facts = extractFacts({ messages });

    const fallbackSummary = () => {
      fallbackUsed++;
      return {
        chatName,
        hrAsked: facts.hrAsked,
        weAnswered: [],
        interview: facts.interview,
        salaryTalk: facts.salaryTalk,
        nextStep: fallbackNextStep(),
        prepare: fallbackPrepare(facts.needHuman),
      };
    };

    try {
      if (typeof callLLM !== "function") throw new Error("callLLM 不是函数");
      const prompt = buildSummaryPrompt({ chatName, messages, profile, card });
      const text = await callLLM(prompt);
      const parsed = parseSummaryJson(text);
      if (!parsed) throw new Error("模型输出无法解析为 JSON");
      summaries.push({ chatName, ...parsed });
      llmUsed++;
      say(`[chatSummary] ${chatName || "(未知会话)"} 由模型生成`);
    } catch (err) {
      const reason = String(err && err.message ? err.message : err);
      errors.push(`${chatName || "(未知会话)"}: ${reason}`);
      summaries.push(fallbackSummary());
      say(`[chatSummary] ${chatName || "(未知会话)"} 退回骨架：${reason}`);
    }
  }

  return { summaries, llmUsed, fallbackUsed, errors };
}

// ---------------------------------------------------------------------------
// ⑥ 落盘
// ---------------------------------------------------------------------------

/**
 * 合并后写文件。**不抛**：写盘失败（目录不存在、磁盘满、被占用）只记 errors，
 * 因为摘要文件写失败不该让"自动回复 HR"这条主流程崩掉。
 */
export async function writeSummariesFile(input) {
  const { filePath, summaries, existing } = safeObj(input);
  const path = typeof filePath === "string" ? filePath : "";

  let store = existing && typeof existing === "object" ? existing : null;
  const list = Array.isArray(summaries) ? summaries : [];
  for (const s of list) {
    if (s && typeof s === "object") store = mergeSummary(store, s);
  }
  if (!store) store = { updatedAt: new Date().toISOString(), summaries: [] };

  const count = Array.isArray(store.summaries) ? store.summaries.length : 0;

  if (!path) return { ok: false, count: 0, path: "", error: "filePath 为空" };

  try {
    // 落盘前对整段 JSON 再打一次码：即使某条旧摘要来自更早的版本，也不会把完整手机号一起写进文件
    const json = maskPhones(JSON.stringify(store, null, 2));
    fs.writeFileSync(path, json, "utf8");
    return { ok: true, count, path };
  } catch (err) {
    return { ok: false, count: 0, path, error: String(err && err.message ? err.message : err) };
  }
}
