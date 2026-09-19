import fs from "node:fs";
import path from "node:path";
import { TECH_KEYWORDS } from "./utils/skills.js";
import { PROJECT_ROOT } from "./paths.js";

const DEFAULT_ZHIPU_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const DEFAULT_ZHIPU_MODEL = "glm-4.7-flash";
const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-chat";
// M3：本机 3010 OpenAI 兼容网关（qwen3.8-flash）。max_tokens 在该网关不生效，
// 控长度全部靠提示词硬约束（见 GATEWAY_SYSTEM_PROMPT）。
const DEFAULT_GATEWAY_BASE_URL = "http://127.0.0.1:3010/v1";
const DEFAULT_GATEWAY_MODEL = "qwen3.8-flash";
// 单次 LLM 请求超时。可用 .env LLM_TIMEOUT_MS 覆盖：无人值守时最怕"首选通道挂死"——
// 实测 3010 免费网关挂死时，30s×3 家会把一条 80 字回复拖到 90s+，整轮巡航跟着卡住。
// 调小它能让失效通道快速让位给后面能用的通道。
const DEFAULT_CHAT_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) > 0
  ? Number(process.env.LLM_TIMEOUT_MS)
  : 30000;
const CARD_HEADING = "候选人底细:";
const CARD_BEGIN = "[[CANDIDATE_CARD_BEGIN]]";
const CARD_END = "[[CANDIDATE_CARD_END]]";
const CARD_WHITELIST_BEGIN = "<!-- WHITELIST-BEGIN -->";
const CARD_WHITELIST_END = "<!-- WHITELIST-END -->";
// 卡片中没有 WHITELIST 标记时，按这些层级标题取白名单词；命中排除标题的层级不取。
const CARD_TIER_INCLUDE_RE = /(能独立干活|用过能讲清)/;
const CARD_TIER_EXCLUDE_RE = /(仅了解|只是接触|只是接触过|缺口|红线|不能说|禁止)/;
const GATEWAY_SYSTEM_PROMPT =
  "你是求职者本人，正在招聘平台和 HR 聊天。回复不超过80字，口语化，模拟本人语气，不要用“作为AI”等身份表述；只使用候选人底细卡和简历里的事实，不会就说不会；直接输出要发送的回复内容，不要输出任何解释。";

const COMMON_SKILL_TERMS = [
  ...TECH_KEYWORDS,
  "cpp",
  "fastapi",
  "flask",
  "django",
  "tensorflow",
  "pytorch",
  "node.js",
  "next.js",
  "vue.js",
  "tailwind",
  "postgresql",
  "mongodb",
  "mysql",
  "redis",
  "aws",
  "azure",
  "golang",
  "rust",
  "swift",
  "kotlin",
  "html",
  "css",
  "nginx",
  "kafka",
  "rabbitmq",
  "elasticsearch",
  "jenkins",
  "ci/cd",
  "机器学习",
  "深度学习",
  "人工智能",
  "AI",
  "数据分析",
  "数据挖掘",
  "图像处理",
  "计算机视觉",
  "自然语言处理",
  "嵌入式",
  "单片机",
  "驱动开发",
  "上位机",
  "下位机",
  "后端",
  "前端",
  "数据库",
  "网络编程",
  "操作系统",
  "多线程",
  "并发",
  "分布式",
  "微服务",
  "容器",
  "云原生",
  "算法",
  "自动化",
  "爬虫",
  "音视频",
  "测试开发",
  "opencv",
];

const GENERIC_CLAIM_TERMS = [
  "软件开发",
  "项目经验",
  "软件",
  "开发",
  "编程",
  "编码",
  "项目",
  "设计",
  "测试",
  "运维",
  "架构",
  "产品",
  "运营",
  "算法",
  "自动化",
  "经验",
];

const GENERIC_CLAIM_TERM_SET = new Set(
  GENERIC_CLAIM_TERMS.map(normalizeTerm).filter(Boolean)
);

const DUAL_SKILL_CLAIM_TERMS = new Set(
  COMMON_SKILL_TERMS.map(normalizeTerm).filter((term) =>
    GENERIC_CLAIM_TERM_SET.has(term)
  )
);

const POSITIVE_CLAIM_VERBS =
  /(?:我)?(?:会|能|可以|能够|具备|拥有|有|做过|接触过|负责|熟悉|掌握|熟练|了解|使用过|用过)(?:做|写|搞|用|开发)?/;

const NEGATION_PREFIX =
  /^(?:(?:我|本人)\s*)?(?:不能使用|无法使用|从来没有|没有用过|没有接触|没有做过|没有学过|没有使用过|没接触过|没做过|没学过|没怎么用过|没用过|不太会|不太懂|不太熟悉|不太了解|不太擅长|不太|不熟悉|不了解|不掌握|不擅长|不涉及|缺乏|不用|无法|不能|不会|从未|未曾|没有|没|不懂|不怎么会)/;

const PII_LABEL_RE =
  /(?:手机号|手机号码|手机|电话|联系电话|联系方式|微信号?|wechat|微信|邮箱|电子邮件|e-mail|email|地址|住址|address)\s*[:：]?\s*[^\s，。；;,.!?！？]+/gi;

const CITY_LABEL_RE =
  /(?:现居住地|所在城市|所在地|居住地|现居|城市|家乡|户籍|住在)\s*[:：]?\s*[^\s，。；;,.!?！？\n]+/gi;

const ETHNICITY_LABEL_RE =
  /(?:民族|族别|名族)\s*[:：]?\s*[^\s，。；;,.!?！？\n]+/gi;

const ETHNICITY_VALUE_RE =
  /(?:是|为|属于)\s*(?:汉族|回族|满族|壮族|苗族|维吾尔族|彝族|土家族|蒙古族|藏族|布依族|侗族|瑶族|朝鲜族|白族|哈尼族|哈萨克族|黎族|傣族|畲族|傈僳族|仡佬族|东乡族|高山族|拉祜族|水族|佤族|纳西族|羌族|土族|仫佬族|锡伯族|柯尔克孜族|达斡尔族|景颇族|毛南族|撒拉族|布朗族|塔吉克族|阿昌族|普米族|鄂温克族|怒族|京族|基诺族|德昂族|保安族|俄罗斯族|裕固族|乌孜别克族|门巴族|鄂伦春族|独龙族|塔塔尔族|赫哲族|珞巴族)/gi;

const PHOTO_LABEL_RE =
  /(?:照片|头像|图片)\s*[:：]\s*[^\s，。！？\n]+|(?:照片|头像|图片)\s*data:image\/[^\s，。！？\n]+/gi;

const IMAGE_DATA_RE = /data:image\/[a-zA-Z0-9.+-]+(?:;base64)?,[a-zA-Z0-9+/=_-]*/gi;

const BASE64_DATA_RE =
  /base64\s*(?:[,:：]\s*[a-zA-Z0-9+/=_-]+|[a-zA-Z0-9+/=_-]{4,})/gi;

const CAPABILITY_GUARD_REPLY =
  "这块我简历里没有明确写，建议以简历内容为准，我可以再确认一下。";

function trimText(value) {
  return String(value || "").trim();
}

function normalizeTerm(value) {
  return String(value || "").trim().toLowerCase();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasTerm(text, term) {
  const t = normalizeTerm(term);
  if (!t) return false;
  const lowerText = String(text || "").toLowerCase();
  if (/^[a-z0-9#.+_-]+$/.test(t)) {
    const q = escapeRegExp(t);
    return new RegExp(`(^|[^a-z0-9])${q}([^a-z0-9]|$)`, "i").test(lowerText);
  }
  return lowerText.includes(t);
}

export function sanitizePromptText(text) {
  let out = String(text || "");
  out = out.replace(CITY_LABEL_RE, "[已隐藏]");
  out = out.replace(ETHNICITY_LABEL_RE, "[已隐藏]");
  out = out.replace(ETHNICITY_VALUE_RE, "[已隐藏]");
  out = out.replace(PHOTO_LABEL_RE, "[已隐藏]");
  out = out.replace(IMAGE_DATA_RE, "[已隐藏]");
  out = out.replace(BASE64_DATA_RE, "[已隐藏]");
  out = out.replace(PII_LABEL_RE, "[已隐藏]");
  out = out.replace(/(?<!\d)\d{17}[\dXx](?!\d)/g, "[已隐藏]");
  out = out.replace(/(?<!\d)\d{15}(?!\d)/g, "[已隐藏]");
  out = out.replace(/\d{4}年\d{1,2}月\d{1,2}日/g, "[已隐藏]");
  out = out.replace(
    /(?<!\d)(?:19|20)\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?/g,
    "[已隐藏]"
  );
  out = out.replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, "[已隐藏]");
  out = out.replace(
    /(?<!\d)(?:0\d{2,3}[- ]?)?\d{7,8}(?!\d)/g,
    "[已隐藏]"
  );
  out = out.replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, "[已隐藏]");
  return out;
}

function findTermRanges(text, term) {
  const t = normalizeTerm(term);
  if (!t) return [];
  const lower = String(text || "").toLowerCase();
  const ranges = [];
  if (/^[a-z0-9#.+_-]+$/.test(t)) {
    const re = new RegExp(
      `(^|[^a-z0-9])${escapeRegExp(t)}([^a-z0-9]|$)`,
      "gi"
    );
    let match;
    while ((match = re.exec(lower))) {
      const start = match.index + match[1].length;
      ranges.push({ start, end: start + t.length });
      re.lastIndex = start + t.length;
    }
  } else {
    let index = lower.indexOf(t);
    while (index !== -1) {
      ranges.push({ start: index, end: index + t.length });
      index = lower.indexOf(t, index + t.length);
    }
  }
  return ranges;
}

function isTermNegated(text, range) {
  const before = String(text || "")
    .slice(Math.max(0, range.start - 12), range.start)
    .trimEnd();
  const after = String(text || "")
    .slice(range.end, Math.min(text.length, range.end + 12))
    .trimStart()
    .replace(/^[，。；、,.!?！？\s]+/, "");
  const negatedBefore =
    /(?:并不会|不会(?:做|弄|用|碰|搞|写|开发)?|没有(?:做过|接触过|接触|参与|用过|使用过|学过|弄过|碰过|搞过|写过|开发过)?|没(?:做过|接触过|接触|参与|用过|使用过|学过|弄过|碰过|搞过|写过|开发过)?|不太熟悉|不太了解|不太擅长|不太|不熟悉|不了解|不掌握|不擅长|从未|未曾|尚未|缺少|缺乏|不懂|不熟练)$/.test(
      before
    );
  if (negatedBefore) return true;
  const negatedAfter =
    /^(?:不熟悉|不了解|不掌握|不擅长|不会(?:做|弄|用|写|搞|碰|开发)?|不行|不清楚|没接触过|没有接触过|没做过|没有做过|没学过|没有学过|没怎么用过|没有怎么用过|不熟练|一般般|没有经验|没经验)/.test(
      after
    );
  return negatedAfter;
}

function genericClaimMatches(text) {
  const alternation = GENERIC_CLAIM_TERMS.map(escapeRegExp).join("|");
  const re = new RegExp(
    `(?:我会|我能|可以|会|有|具备|拥有|做过|接触过|负责|熟悉|掌握)(?:多年|丰富|相关|扎实)?(?:做|写|搞)?(${alternation})`,
    "gi"
  );
  const matches = [];
  let match;
  while ((match = re.exec(text))) {
    const term = match[1];
    const start = match.index + match[0].length - term.length;
    matches.push({ term, start, end: start + term.length });
  }
  return matches;
}

function skillTermsFromText(text) {
  const terms = new Set();
  const lower = String(text || "").toLowerCase();
  for (const keyword of [...COMMON_SKILL_TERMS, ...GENERIC_CLAIM_TERMS]) {
    if (lower.includes(keyword)) terms.add(keyword);
  }
  const tokens = String(text || "").match(/[a-z0-9][a-z0-9#.+_-]{1,}/gi) || [];
  for (const token of tokens) {
    const term = token.toLowerCase();
    if (term.length >= 2) terms.add(term);
  }
  return Array.from(terms);
}

function claimTermsFromText(text) {
  const terms = new Set();
  const value = String(text || "");
  for (const term of [...COMMON_SKILL_TERMS, ...GENERIC_CLAIM_TERMS]) {
    if (hasTerm(value, term)) terms.add(normalizeTerm(term));
  }
  const tokens = value.match(/[a-z0-9][a-z0-9#.+_-]{1,}/gi) || [];
  for (const token of tokens) {
    const term = normalizeTerm(token);
    if (term.length >= 2) terms.add(term);
  }
  return Array.from(terms);
}

function isNegatedClaim(part) {
  const clean = String(part || "")
    .trim()
    .replace(/^(?:但是|但|不过|另外|此外|只是|并且|而且)\s*/, "");
  if (NEGATION_PREFIX.test(clean)) return true;
  return (
    /(?:没|没有)(?:有)?(?:用|学|做|接触|碰|弄|搞|写|开发|会)?过?/.test(clean) ||
    /不(?:是)?(?:太|很)?会/.test(clean) ||
    /不(?:太|很)?熟悉|不了解|不掌握|不擅长|从未|未曾/.test(clean)
  );
}

function isPositiveClaim(part) {
  const clean = String(part || "")
    .trim()
    .replace(/^(?:但是|但|不过|另外|此外|只是|并且|而且)\s*/, "");
  return POSITIVE_CLAIM_VERBS.test(clean);
}

export function extractPositiveClaims(reply) {
  const claims = [];
  const sentences = String(reply || "").split(
    /(?<=[。！？!?；;\n])/
  );
  for (const sentence of sentences) {
    const parts = sentence.split(/([，,、和与及/])/);
    let previousPositive = false;
    for (const rawPart of parts) {
      const part = String(rawPart || "").trim();
      if (!part || /^[，,、和与及/]$/.test(part)) continue;
      if (isNegatedClaim(part)) {
        previousPositive = false;
        continue;
      }
      const hasTerms = claimTermsFromText(part).length > 0;
      if (isPositiveClaim(part) && hasTerms) {
        claims.push(part);
        previousPositive = true;
        continue;
      }
      if (previousPositive && hasTerms) {
        claims.push(part);
        previousPositive = true;
        continue;
      }
      previousPositive = false;
    }
  }
  return claims;
}

export function getProviderConfig(env = process.env) {
  const gatewayKey = trimText(env.QODER_GATEWAY_API_KEY);
  const zhipuKey = trimText(env.ZHIPU_API_KEY);
  const deepseekKey = trimText(env.DEEPSEEK_API_KEY);
  const override = String(env.LLM_PROVIDER || "").trim().toLowerCase();

  // 真实可用的 provider（有 key 才算可用）
  const available = [];
  if (gatewayKey) available.push("localgateway");
  if (zhipuKey) available.push("zhipu");
  if (deepseekKey) available.push("deepseek");

  const DEFAULT_ORDER = ["localgateway", "zhipu", "deepseek"];
  const warnings = [];

  let order;
  if (override === "template") {
    order = [];
  } else if (
    override === "localgateway" ||
    override === "zhipu" ||
    override === "deepseek"
  ) {
    // 尊重显式指定：指定项排第一，其余按默认顺序补上，保留跨 provider 重试。
    // 指定项没有 key 时给出 warning（沿用既有缺 key 的处理风格）。
    if (override === "localgateway" && !gatewayKey) {
      warnings.push(
        "LLM_PROVIDER=localgateway 但未配置 QODER_GATEWAY_API_KEY，已回退到其他可用提供方或模板"
      );
    } else if (override === "zhipu" && !zhipuKey) {
      warnings.push(
        "LLM_PROVIDER=zhipu 但未配置 ZHIPU_API_KEY，已回退到其他可用提供方或模板"
      );
    } else if (override === "deepseek" && !deepseekKey) {
      warnings.push(
        "LLM_PROVIDER=deepseek 但未配置 DEEPSEEK_API_KEY，已回退到其他可用提供方或模板"
      );
    }
    const rest = DEFAULT_ORDER.filter((name) => name !== override);
    order = [override, ...rest].filter((name) => available.includes(name));
  } else if (override) {
    // 未知 override：无法点名具体提供方，按默认优先级链处理并记录 warning
    warnings.push(
      `LLM_PROVIDER=${override} 不是已注册的提供方，已按默认优先级链（localgateway→zhipu→deepseek→template）选择`
    );
    order = DEFAULT_ORDER.filter((name) => available.includes(name));
  } else {
    order = DEFAULT_ORDER.filter((name) => available.includes(name));
  }

  if (gatewayKey && !trimText(env.QODER_GATEWAY_BASE_URL)) {
    // 未显式配置 baseUrl 时静默使用本机默认端口，不视为错误
  }

  const provider = order[0] || "template";
  const warning =
    override === "zhipu" && !zhipuKey
      ? // 保持与 M3 之前完全一致的首要 warning 文案（既有测试断言该字段）
        "LLM_PROVIDER=zhipu 但未配置 ZHIPU_API_KEY，已回退到其他可用提供方或模板"
      : warnings[0] || null;

  return {
    provider,
    warning,
    warnings,
    // 降级链：按顺序尝试的真实 provider；template 作为链尾兜底
    chain: [...order, "template"],
    localgateway: {
      apiKey: gatewayKey,
      baseUrl:
        trimText(env.QODER_GATEWAY_BASE_URL) || DEFAULT_GATEWAY_BASE_URL,
      model: trimText(env.QODER_GATEWAY_MODEL) || DEFAULT_GATEWAY_MODEL,
      // 网关实测 max_tokens 不生效，不发该参数，长度靠 system 提示硬约束
      omitMaxTokens: true,
      systemPrompt: GATEWAY_SYSTEM_PROMPT,
    },
    zhipu: {
      apiKey: zhipuKey,
      baseUrl: trimText(env.ZHIPU_BASE_URL) || DEFAULT_ZHIPU_BASE_URL,
      model: trimText(env.ZHIPU_MODEL) || DEFAULT_ZHIPU_MODEL,
      omitMaxTokens: false,
      systemPrompt: "",
    },
    deepseek: {
      apiKey: deepseekKey,
      baseUrl: trimText(env.DEEPSEEK_BASE_URL) || DEFAULT_DEEPSEEK_BASE_URL,
      model: trimText(env.DEEPSEEK_MODEL) || DEFAULT_DEEPSEEK_MODEL,
      omitMaxTokens: false,
      systemPrompt: "",
    },
  };
}

const CANDIDATE_CARD_REL = path.join("prompts", "candidate-card.md");

function candidateCardEnv(env) {
  return env && typeof env === "object" ? env : process.env;
}

// 底细卡路径解析（沿用 paths.js 风格：显式 env 优先，其次数据目录/仓库根下 prompts/）。
// 优先级：显式参数 > JOB_AGENT_CANDIDATE_CARD_PATH > <JOB_AGENT_DATA_DIR>/prompts/ > <repo>/prompts/
export function resolveCandidateCardPath(env = process.env, explicitPath = "") {
  const e = candidateCardEnv(env);
  const explicit = trimText(explicitPath) || trimText(e.JOB_AGENT_CANDIDATE_CARD_PATH);
  if (explicit) return explicit;
  const candidates = [];
  const dataDir = trimText(e.JOB_AGENT_DATA_DIR);
  if (dataDir) candidates.push(path.join(dataDir, CANDIDATE_CARD_REL));
  candidates.push(path.join(PROJECT_ROOT, CANDIDATE_CARD_REL));
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch (err) {
      /* ignore */
    }
  }
  return "";
}

// 读取并清洗底细卡；不存在/读取失败返回空串（维持现状，不影响原有行为）。
export function loadCandidateCardText(env = process.env, explicitPath = "") {
  const filePath = resolveCandidateCardPath(env, explicitPath);
  if (!filePath) return "";
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return sanitizePromptText(String(raw || "").trim());
  } catch (err) {
    return "";
  }
}

// 从底细卡文本中提炼"可声明能力"词表。
// 优先取显式标记区 <!-- WHITELIST-BEGIN/END -->；否则按层级标题（## / ###）判断：
// 标题含"能独立干活"或"用过能讲清"的段落取词，含"仅了解/缺口/红线"的段落跳过。
export function candidateCardWhitelistTerms(cardText) {
  const text = String(cardText || "");
  if (!text) return [];
  let scope = text;
  const b = text.indexOf(CARD_WHITELIST_BEGIN);
  const e = text.indexOf(CARD_WHITELIST_END);
  if (b !== -1 && e !== -1 && e > b) {
    scope = text.slice(b + CARD_WHITELIST_BEGIN.length, e);
    const terms = new Set();
    // 显式标记区按顿号/逗号/分号/换行切条目（去掉括号注释），
    // 中文短语整条直接进白名单；ASCII 词再走词典/分词兜底。
    for (const rawEntry of scope.split(/[、，,;；\n]+/)) {
      const entry = rawEntry
        .replace(/（[^）]*）/g, "")
        .replace(/\([^)]*\)/g, "")
        .trim();
      if (entry.length >= 2) terms.add(normalizeTerm(entry));
    }
    for (const term of skillTermsFromText(scope)) {
      const t = normalizeTerm(term);
      if (t) terms.add(t);
    }
    return Array.from(terms);
  }
  const kept = [];
  let collecting = false;
  for (const line of scope.split(/\r?\n/)) {
    const heading = /^(?:#{1,6})\s+(.*)$/.exec(line.trim());
    if (heading) {
      const title = heading[1];
      if (CARD_TIER_EXCLUDE_RE.test(title)) {
        collecting = false;
        continue;
      }
      collecting = CARD_TIER_INCLUDE_RE.test(title);
      if (collecting) kept.push(title);
      continue;
    }
    if (collecting) kept.push(line);
  }
  return Array.from(
    new Set(skillTermsFromText(kept.join("\n")).map(normalizeTerm).filter(Boolean))
  );
}

function formatCandidateCardBlock(cardText) {
  const body = sanitizePromptText(trimText(cardText));
  if (!body) return "";
  return [CARD_HEADING, CARD_BEGIN, body, CARD_END].join("\n");
}

export function buildSafeResumeText({
  profile = {},
  resume,
  resumeEditor,
  expectedSalary,
  candidateCard,
  candidateCardPath,
  env,
} = {}) {
  const r = {};
  for (const source of [profile, resume, resumeEditor]) {
    for (const [key, value] of Object.entries(source || {})) {
      if (key === "expectedSalary" && value !== undefined && value !== null) {
        r[key] = value;
      } else if (trimText(value)) {
        r[key] = value;
      }
    }
  }
  if (expectedSalary !== undefined && expectedSalary !== null) {
    r.expectedSalary = expectedSalary;
  }
  const lines = [];
  const add = (label, value) => {
    const text = sanitizePromptText(trimText(value));
    if (text) lines.push(`${label}: ${text}`);
  };

  add("目标岗位", r.targetRole);
  add("技能", r.skills);
  add("经验", r.experience);
  add("学历", r.education);
  add("期望薪资", r.expectedSalary);
  add("个人优势", r.summary);

  for (const item of Array.isArray(r.work) ? r.work : []) {
    const line = [item.company, item.title, item.period, item.content]
      .map((value) => sanitizePromptText(trimText(value)))
      .filter(Boolean)
      .join(" ");
    if (line) lines.push(`工作经历: ${line}`);
  }
  for (const item of Array.isArray(r.projects) ? r.projects : []) {
    const line = [item.name, item.role, item.period, item.content]
      .map((value) => sanitizePromptText(trimText(value)))
      .filter(Boolean)
      .join(" ");
    if (line) lines.push(`项目经历: ${line}`);
  }
  for (const item of Array.isArray(r.educationList) ? r.educationList : []) {
    const line = [item.school, item.degree, item.period, item.content]
      .map((value) => sanitizePromptText(trimText(value)))
      .filter(Boolean)
      .join(" ");
    if (line) lines.push(`教育经历: ${line}`);
  }

  // 底细卡注入：存在则作为"候选人底细"块放在最前，补充（不替换）简历拼装；
  // 不存在则完全维持现状。卡片文本再过一遍 sanitizePromptText。
  const cardText =
    typeof candidateCard === "string"
      ? candidateCard
      : loadCandidateCardText(env, candidateCardPath);
  const cardBlock = formatCandidateCardBlock(cardText);
  if (cardBlock) lines.unshift(cardBlock);

  return lines.join("\n");
}

export function buildReplyPrompt({
  hrMsg,
  name,
  skills,
  profile,
  job,
  resume,
  resumeEditor,
  safeResumeText,
  chatText,
  expectedSalary,
  candidateCard,
  candidateCardPath,
  env,
} = {}) {
  const p = profile || {};
  const j = job || {};
  const personName = sanitizePromptText(trimText(name || p.name || "用户"));
  const personSkills = sanitizePromptText(trimText(skills || p.skills || ""));
  const jobTitle = sanitizePromptText(trimText(j.title || ""));
  const companyName = sanitizePromptText(
    trimText(j.companyName || j.company || "")
  );
  const jobTechnologies = sanitizePromptText(trimText(j.technologies || ""));
  const salary = sanitizePromptText(
    trimText(
      expectedSalary !== undefined && expectedSalary !== null
        ? expectedSalary
        : p.expectedSalary ||
          resume?.expectedSalary ||
          resumeEditor?.expectedSalary ||
          ""
    )
  );
  const jobSalary = sanitizePromptText(
    trimText(j.salaryRaw || j.salary || j.salaryDesc || "")
  );
  const jobDescription = sanitizePromptText(
    trimText(j.description || j.jobDetail || "")
  );
  const jobRequirements = sanitizePromptText(
    trimText(j.requirements || j.requirement || "")
  );
  const safeResume = sanitizePromptText(
    trimText(
      safeResumeText ||
        buildSafeResumeText({
          profile,
          resume,
          resumeEditor,
          expectedSalary,
          candidateCard,
          candidateCardPath,
          env,
        })
    )
  );
  const chatContext = trimText(sanitizePromptText(chatText || ""));

  // 底细卡可能已随 safeResumeText 传入（调用方预拼），也可能需要这里自己加载。
  // 已含卡片时不重复注入，但"唯一来源"规则行在两种情况下都要出现。
  const cardText =
    typeof candidateCard === "string"
      ? candidateCard
      : loadCandidateCardText(env, candidateCardPath);
  const cardAlreadyInside =
    safeResume.includes(CARD_HEADING) || safeResume.includes(CARD_BEGIN);
  const cardPresent = cardAlreadyInside || !!trimText(cardText);
  const cardBlock =
    !cardAlreadyInside && trimText(cardText)
      ? formatCandidateCardBlock(cardText)
      : "";

  const lines = [
    "你是求职者本人，正在招聘平台和 HR 聊天。请用自然、口语化、不客套的中文回复，像真人求职者沟通，不要使用“作为AI”等身份表述。",
    "",
    "硬性能力约束：",
    "- 只能使用下方简历/个人资料中已经出现的能力、技能、项目、经历和学历。",
    "- 严禁使用模型通用知识编造简历和个人资料中不存在的技能、项目、工作经历、学历或成果。",
    "- 如果 HR 的问题涉及没有写在简历/资料中的能力，用已有信息回应，不得虚构。",
    ...(cardPresent
      ? [
          "- 候选人底细卡是事实与口径的唯一来源：卡内没有的能力、经历、数字一律不认领。",
          "- 卡内「授权代答范围」（2026-09-19）里写明可以直接答的：面试邀约（应下并问清时间/地点/联系人）、面试时间协调（随时可到岗）、谈薪（期望不低于 4000）。",
          "- 仍必须转人工的：Offer/录用/入职确认/签合同/试用期/社保/外包驻场，以及任何要用户本人点头或签字的事。",
        ]
      : []),
    "",
    "长度与语气：回复不超过80字，口语化，模拟本人口径，短句为主，不客套堆话。",
    "",
    "薪资规则：",
    `- 期望薪资是谈判底线${salary ? `：${salary}` : "（以个人资料为准）"}。`,
    "- 被问到时，优先提出不低于期望薪资的期望范围或数字。",
    "- 只有 HR 给出的范围明显低于期望薪资、且对话整体积极时，才可以表达愿意就略低数字沟通。",
    "- 绝不主动报出更低数字。",
    "",
    "联系方式规则：",
    "- 手机号、微信号、地址等联系方式已经包含在简历中。",
    "- 不要在聊天中重复写出手机号、微信号、地址等联系细节。",
    "",
    "面试邀约规则（2026-09-19 用户授权：聊到面试为止）：",
    "- HR 约面试时：爽快应下（“方便的/可以的”），并主动问清**具体时间、地址、联系人**；本人口径是**随时可到岗**。",
    "- 只确认“我会准时到/请把时间地点发我”，不要承诺岗位细节之外的任何条件。",
    "- 若对方同时提到 Offer、入职日期、签合同、试用期、社保、外包驻场：只说“这块我和您电话里/面谈细聊”，**不替本人答应**。",
    "",
    "职位信息：",
    `职位：${jobTitle}`,
    `公司：${companyName}`,
    `薪资：${jobSalary}`,
    `技术要求：${jobTechnologies}`,
    `职位描述：${jobDescription}`,
    `任职要求：${jobRequirements}`,
    "",
    "个人资料：",
    `姓名：${personName}`,
    `目标岗位：${sanitizePromptText(trimText(p.targetRole || ""))}`,
    `技能：${personSkills}`,
    `经验：${sanitizePromptText(trimText(p.experience || ""))}`,
    `学历：${sanitizePromptText(trimText(p.education || ""))}`,
    `个人优势：${sanitizePromptText(trimText(p.summary || ""))}`,
    `期望薪资：${salary}`,
    "",
    cardBlock,
    "完整简历：",
    safeResume || "（暂无完整简历文本）",
    "",
    "最近聊天上下文：",
    chatContext || "（暂无）",
    "",
    `HR 最新消息：${sanitizePromptText(trimText(hrMsg || ""))}`,
    "",
    "请直接输出要发送给 HR 的回复内容，20-80字，不要输出前后说明。",
  ];

  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

export function extractSkillWhitelist(profile, resumeText, resume = {}) {
  const p = profile || {};
  const r = resume || {};
  const fullText = String(resumeText || "");
  // 底细卡块单独处理：只有"能独立干活/用过能讲清"层（或显式 WHITELIST 标记区）
  // 的词进白名单，"仅了解"层不进；卡片其余部分不参与白名单提取。
  let cardExtraTerms = [];
  let resumeTextWithoutCard = fullText;
  const cb = fullText.indexOf(CARD_BEGIN);
  const ce = fullText.indexOf(CARD_END);
  if (cb !== -1 && ce !== -1 && ce > cb) {
    const cardBody = fullText.slice(cb + CARD_BEGIN.length, ce);
    resumeTextWithoutCard =
      fullText.slice(0, cb) + fullText.slice(ce + CARD_END.length);
    cardExtraTerms = candidateCardWhitelistTerms(cardBody);
  }
  const safeResumeView = /(?:目标岗位|技能|经验|学历|期望薪资|个人优势|工作经历|项目经历|教育经历)\s*[:：]/.test(
    resumeTextWithoutCard
  )
    ? resumeTextWithoutCard
    : "";
  const structuredProfileKeys = [
    "skills",
    "skill",
    "skillList",
    "skillsList",
    "skillTags",
    "tech",
    "techStack",
    "technologies",
    "skillsSummary",
    "experience",
    "education",
    "summary",
    "targetRole",
  ];
  const structuredResumeKeys = [
    "skills",
    "skill",
    "skillList",
    "skillsList",
    "technologies",
    "title",
    "content",
    "summary",
  ];
  const texts = [
    ...structuredProfileKeys.map((key) => p[key]),
    ...structuredResumeKeys.map((key) => r[key]),
    safeResumeView,
  ];
  for (const group of [p.work, p.projects, p.educationList]) {
    for (const item of Array.isArray(group) ? group : []) {
      for (const key of Object.keys(item || {})) {
        texts.push(item[key]);
      }
    }
  }
  for (const group of [r.work, r.projects, r.educationList]) {
    for (const item of Array.isArray(group) ? group : []) {
      for (const key of Object.keys(item || {})) {
        texts.push(item[key]);
      }
    }
  }

  const terms = new Set();
  for (const text of texts) {
    for (const term of skillTermsFromText(text)) {
      terms.add(normalizeTerm(term));
    }
  }
  for (const term of cardExtraTerms) {
    if (term) terms.add(normalizeTerm(term));
  }
  return Array.from(terms);
}

export function validateReplyForCapabilities(reply, whitelist) {
  const allowed = new Set((whitelist || []).map(normalizeTerm).filter(Boolean));
  const missing = new Set();
  const genericTerms = GENERIC_CLAIM_TERM_SET;
  const claims = extractPositiveClaims(reply);

  for (const claim of claims) {
    const terms = claimTermsFromText(claim);
    const supportedNamed = new Set(
      terms.filter(
        (term) => !genericTerms.has(term) && allowed.has(term)
      )
    );
    for (const term of terms) {
      if (allowed.has(term)) continue;
      if (
        genericTerms.has(term) &&
        !DUAL_SKILL_CLAIM_TERMS.has(term) &&
        supportedNamed.size > 0
      ) {
        continue;
      }
      missing.add(term);
    }
  }

  return {
    ok: missing.size === 0,
    missing: Array.from(missing),
    ...(missing.size > 0 ? { reason: "capability_guard" } : {}),
  };
}

export function classifyIntent(hrMsg) {
  const text = String(hrMsg || "").toLowerCase();
  // 2026-09-19 用户授权：「就和 HR 聊到谈薪面试这一环节，之后我去面试」。
  // 政策变化：面试邀约/时间地点/谈薪 由「一律转人工」改为「可按卡内口径代答」；
  // 但凡是要"答应下来或签字"的事（offer/录用/入职确认/合同/试用期/社保/外包驻场）仍转人工。
  // 底线不变：宁可过拦，不可漏放承诺类内容——所以 offer/合同那组词表要宁宽勿窄。
  const offer =
    /\boffer\b|录用|入职确认|确认入职|入职日期|入职时间|签合同|签协议|劳动合同|试用期|转正|社保|公积金|五险一金|工资卡|背调|体检|押金|违约金|竞业/.test(text);
  const outsourcing = /外包|驻场|派遣|中介|代招/.test(text);
  const interviewMention =
    /面试|面谈|复试|初试|视频面试|线下面试|到面|到店|hr面|试岗/.test(text);
  const interviewScheduling =
    /时间|地点|地址|日期|安排|约|预约|通知|确认|几点|什么时候|在哪|哪里|方便面试/.test(text);
  // 裸邀约兜底规则：真实 HR 常用"明天上午10点来面试吧"这类不带"时间/地点"字样的邀约。
  const interviewInviteSignals =
    /(明天|后天|今天|本周|下周|周[一二三四五六日天]|\d+点|\d+号|上午|下午|来|到|参加|安排|约|定)/.test(
      text
    );
  const interviewInvite = interviewMention && interviewInviteSignals;
  const interviewPlaceTime = interviewMention && interviewScheduling;
  const interview = interviewInvite || interviewPlaceTime;
  const salary =
    /薪资|工资|待遇|薪酬|多少钱|期望薪|底薪|提成/.test(text);
  const contact =
    /微信|wechat|手机号|手机号码|电话|联系方式|怎么联系|加个微信/.test(text);

  if (offer) {
    return {
      needManual: true,
      kind: "offer",
      reason: "Offer/合同/试用期/社保类需人工确认（用户 2026-09-19 授权范围内不含这类承诺）",
    };
  }
  if (outsourcing) {
    return {
      needManual: true,
      kind: "outsourcing",
      reason: "外包/驻场/派遣类需人工确认（卡内红线）",
    };
  }
  if (interview) {
    // 授权代答：应下邀约 + 问清时间地点联系人，并写入会话要点摘要（供用户去面）
    return {
      needManual: false,
      kind: "interview",
      interview: true,
      reason: "面试邀约：可代答（应下 + 问清时间地点），要点转摘要",
    };
  }
  if (salary) {
    return { needManual: false, kind: "salary" };
  }
  if (contact) {
    return { needManual: false, kind: "contact" };
  }
  return { needManual: false, kind: "general" };
}

export function templateReply(hrMsg, name, skills, options = {}) {
  const intent = classifyIntent(hrMsg);
  // 面试类在授权范围内可直接答（2026-09-19）：应下邀约 + 问清时间地点联系人
  if (intent.kind === "interview") {
    return "方便的，麻烦您把面试的具体时间和地址发我，我按时到。";
  }
  if (intent.kind === "salary") {
    return "薪资可以聊，我期望不低于 4K，具体还是先看岗位内容再细谈。";
  }
  if (intent.kind === "contact") {
    return "联系方式我已经在简历里提供，方便的话可以查看简历进一步沟通。";
  }
  const fallbacks = [
    "收到，谢谢回复！方便的话可以约个时间详细聊聊。",
    "好的，了解了。有什么需要我进一步说明的随时问我。",
    "谢谢您的消息，我对这个岗位挺感兴趣的，希望有机会跟您详细沟通一下。",
  ];
  return fallbacks[Math.floor(Math.random() * fallbacks.length)];
}

function chatCompletionsUrl(baseUrl, provider) {
  const clean = String(baseUrl || "").replace(/\/+$/, "");
  if (provider === "deepseek" && !/\/v1$/.test(clean)) {
    return `${clean}/v1/chat/completions`;
  }
  return `${clean}/chat/completions`;
}

// 错误分类：只描述类别，绝不携带 key 或响应正文
class LlmCallError extends Error {
  constructor(kind, message) {
    super(message || kind);
    this.name = "LlmCallError";
    this.kind = kind; // network | http | timeout | parse | empty
  }
}

function classifyErrorKind(error) {
  if (error instanceof LlmCallError) return error.kind;
  const msg = String(error?.message || "");
  if (/abort|timeout|timed out/i.test(msg)) return "timeout";
  if (/fetch failed|network|ECONNREFUSED|ENOTFOUND|socket|ECONNRESET|EAI_AGAIN/i.test(msg)) {
    return "network";
  }
  return "network";
}

function describeError(error) {
  const kind = classifyErrorKind(error);
  const msg = String(error?.message || "")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/https?:\/\/\S+/g, "[url]")
    .slice(0, 80);
  return { kind, msg };
}

export async function chatCompletion({
  messages,
  apiKey,
  baseUrl,
  model,
  provider,
  maxTokens = 200,
  temperature = 0.8,
  timeoutMs = DEFAULT_CHAT_TIMEOUT_MS,
  omitMaxTokens = false,
  systemPrompt = "",
  fetchImpl,
} = {}) {
  const fetchFn = fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new LlmCallError("network", "no fetch implementation");
  }
  if (!trimText(apiKey)) {
    throw new LlmCallError("config", `${provider || "provider"} 缺少 API key`);
  }
  const finalMessages = [];
  if (trimText(systemPrompt)) {
    finalMessages.push({ role: "system", content: sanitizePromptText(systemPrompt) });
  }
  for (const m of Array.isArray(messages) ? messages : []) {
    if (m && typeof m.content === "string") {
      finalMessages.push({ ...m, content: sanitizePromptText(m.content) });
    } else if (m) {
      finalMessages.push(m);
    }
  }
  const url = chatCompletionsUrl(baseUrl, provider);
  const payload = {
    model,
    messages: finalMessages,
    temperature,
  };
  if (!omitMaxTokens) {
    payload.max_tokens = maxTokens;
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, Math.max(1, Number(timeoutMs) || 1))
      : null;
  let response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (e) {
    if (timedOut || e?.name === "AbortError") {
      throw new LlmCallError("timeout", `LLM 请求超时（${timeoutMs}ms）`);
    }
    throw new LlmCallError(classifyErrorKind(e), `LLM 网络错误（provider=${provider || "unknown"}）`);
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!response || response.ok === false) {
    const status = response?.status || 0;
    // 不读取/不打印响应正文，避免泄露任何 key 或原始内容
    throw new LlmCallError("http", `LLM 请求失败 HTTP ${status}（provider=${provider || "unknown"}）`);
  }
  let data;
  try {
    data = await response.json();
  } catch (e) {
    throw new LlmCallError("parse", "LLM 响应 JSON 解析失败");
  }
  const text = trimText(data?.choices?.[0]?.message?.content);
  if (!text) {
    throw new LlmCallError("empty", "LLM 返回内容为空");
  }
  return { text, raw: data };
}

function emitWarning(options, message) {
  if (typeof options?.onWarning === "function") {
    try {
      options.onWarning(message);
      return;
    } catch (e) {
      return;
    }
  }
  if (typeof options?.log === "function") {
    try {
      options.log(message);
    } catch (e) {
      /* ignore */
    }
  }
}

/**
 * 通用文本生成（2026-09-19 新增，给会话要点摘要用）：复用与回复相同的 provider 链，
 * 但不做能力白名单校验（摘要是给用户自己看的内部产物，不是要发给 HR 的话）。
 * 全部 provider 失败时抛错，调用方自行退回模板/骨架。
 */
export async function generateText(prompt, options = {}) {
  const config = getProviderConfig(options.env || process.env);
  const chain = (Array.isArray(config.chain) ? config.chain : []).filter((p) => p !== "template");
  let lastError = null;
  for (const providerName of chain) {
    const providerConfig = config[providerName];
    if (!providerConfig || !trimText(providerConfig.apiKey)) continue;
    try {
      const completion = await chatCompletion({
        messages: [{ role: "user", content: String(prompt || "") }],
        apiKey: providerConfig.apiKey,
        baseUrl: providerConfig.baseUrl,
        model: providerConfig.model,
        provider: providerName,
        fetchImpl: options.fetchImpl,
        maxTokens: options.maxTokens,
        temperature: options.temperature,
        timeoutMs: options.llmTimeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS,
        omitMaxTokens: !!providerConfig.omitMaxTokens,
        systemPrompt: providerConfig.systemPrompt,
      });
      const text = String(completion.text || "").trim();
      if (text) return text;
      lastError = new Error(`provider=${providerName} 返回空文本`);
    } catch (e) {
      lastError = e;
      emitWarning(options, `[llm] 摘要用 ${providerName} 失败（${describeError(e).kind}），试下一个`);
    }
  }
  throw lastError || new Error("没有可用的 LLM provider（generateText）");
}

export async function generateReply(hrMsg, name, skills, options = {}) {
  const intent = classifyIntent(hrMsg);
  if (intent.needManual) {
    return {
      ok: false,
      needManual: true,
      reason: intent.reason,
      reply: "",
    };
  }

  const config = getProviderConfig(options.env || process.env);
  for (const warningMessage of config.warnings?.length
    ? config.warnings
    : config.warning
      ? [config.warning]
      : []) {
    emitWarning(options, warningMessage);
  }

  const prompt = buildReplyPrompt({
    hrMsg,
    name,
    skills,
    ...options,
  });
  const profile = options.profile || {};
  const safeResumeForWhitelist = options.safeResumeText
    ? String(options.safeResumeText)
    : buildSafeResumeText({
        profile,
        resume: options.resume,
        resumeEditor: options.resumeEditor,
        expectedSalary: options.expectedSalary,
      });
  const whitelist = extractSkillWhitelist(
    profile,
    safeResumeForWhitelist,
    options.resume || options.resumeEditor
  );
  // 跨 provider 重试链：按 getProviderConfig 给出的顺序依次尝试真实可用的
  // provider（localgateway → zhipu → deepseek），全部失败才落 templateReply。
  const chain = (Array.isArray(config.chain) ? config.chain : []).filter(
    (p) => p !== "template"
  );
  if (chain.length === 0) {
    return templateReply(hrMsg, name, skills, options);
  }

  let lastErrorKind = "";
  for (const providerName of chain) {
    const providerConfig = config[providerName];
    if (!providerConfig || !trimText(providerConfig.apiKey)) continue;
    try {
      const completion = await chatCompletion({
        messages: [{ role: "user", content: prompt }],
        apiKey: providerConfig.apiKey,
        baseUrl: providerConfig.baseUrl,
        model: providerConfig.model,
        provider: providerName,
        fetchImpl: options.fetchImpl,
        maxTokens: options.maxTokens,
        temperature: options.temperature,
        timeoutMs: options.llmTimeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS,
        omitMaxTokens: !!providerConfig.omitMaxTokens,
        systemPrompt: providerConfig.systemPrompt,
      });
      const reply = String(completion.text || "").slice(0, 200).trim();
      if (!reply) {
        lastErrorKind = "empty";
        emitWarning(
          options,
          `[llm] provider=${providerName} 错误类别=empty，已尝试下一个提供方`
        );
        continue;
      }
      const validation = validateReplyForCapabilities(reply, whitelist);
      if (!validation.ok) {
        return {
          ok: false,
          reason: "capability_guard",
          reply: CAPABILITY_GUARD_REPLY,
        };
      }
      return reply;
    } catch (e) {
      const { kind, msg } = describeError(e);
      lastErrorKind = kind;
      const nextProvider = chain[chain.indexOf(providerName) + 1] || "template";
      emitWarning(
        options,
        `[llm] provider=${providerName} 错误类别=${kind}（${msg}），降级到 ${nextProvider}`
      );
    }
  }

  if (lastErrorKind) {
    emitWarning(options, `[llm] 全部提供方失败（最后类别=${lastErrorKind}），已落模板回复`);
  }
  return templateReply(hrMsg, name, skills, options);
}
