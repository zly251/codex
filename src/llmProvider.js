import { TECH_KEYWORDS } from "./utils/skills.js";

const DEFAULT_ZHIPU_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const DEFAULT_ZHIPU_MODEL = "glm-4.7-flash";
const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-chat";

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
  const zhipuKey = trimText(env.ZHIPU_API_KEY);
  const deepseekKey = trimText(env.DEEPSEEK_API_KEY);
  const override = String(env.LLM_PROVIDER || "").trim().toLowerCase();

  let provider;
  if (override === "template") {
    provider = "template";
  } else if (override === "zhipu") {
    provider = zhipuKey ? "zhipu" : deepseekKey ? "deepseek" : "template";
  } else if (override === "deepseek") {
    provider = deepseekKey ? "deepseek" : zhipuKey ? "zhipu" : "template";
  } else if (zhipuKey) {
    provider = "zhipu";
  } else if (deepseekKey) {
    provider = "deepseek";
  } else {
    provider = "template";
  }

  const warning =
    override === "zhipu" && !zhipuKey
      ? "LLM_PROVIDER=zhipu 但未配置 ZHIPU_API_KEY，已回退到其他可用提供方或模板"
      : null;

  return {
    provider,
    warning,
    zhipu: {
      apiKey: zhipuKey,
      baseUrl: trimText(env.ZHIPU_BASE_URL) || DEFAULT_ZHIPU_BASE_URL,
      model: trimText(env.ZHIPU_MODEL) || DEFAULT_ZHIPU_MODEL,
    },
    deepseek: {
      apiKey: deepseekKey,
      baseUrl: trimText(env.DEEPSEEK_BASE_URL) || DEFAULT_DEEPSEEK_BASE_URL,
      model: trimText(env.DEEPSEEK_MODEL) || DEFAULT_DEEPSEEK_MODEL,
    },
  };
}

export function buildSafeResumeText({
  profile = {},
  resume,
  resumeEditor,
  expectedSalary,
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
        buildSafeResumeText({ profile, resume, resumeEditor, expectedSalary })
    )
  );
  const chatContext = trimText(sanitizePromptText(chatText || ""));

  const lines = [
    "你是求职者本人，正在招聘平台和 HR 聊天。请用自然、口语化、不客套的中文回复，像真人求职者沟通，不要使用“作为AI”等身份表述。",
    "",
    "硬性能力约束：",
    "- 只能使用下方简历/个人资料中已经出现的能力、技能、项目、经历和学历。",
    "- 严禁使用模型通用知识编造简历和个人资料中不存在的技能、项目、工作经历、学历或成果。",
    "- 如果 HR 的问题涉及没有写在简历/资料中的能力，用已有信息回应，不得虚构。",
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

  return lines.join("\n");
}

export function extractSkillWhitelist(profile, resumeText, resume = {}) {
  const p = profile || {};
  const r = resume || {};
  const safeResumeView = /(?:目标岗位|技能|经验|学历|期望薪资|个人优势|工作经历|项目经历|教育经历)\s*[:：]/.test(
    String(resumeText || "")
  )
    ? String(resumeText || "")
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
  const offer =
    /\boffer\b|录用|入职时间|入职日期|到岗时间|到岗日期|offer确认|确认offer|offer已发|offer什么时候|offer多久/.test(text);
  const interviewMention =
    /面试|面谈|复试|初试|视频面试|线下面试|到面|hr面/.test(text);
  const interviewScheduling =
    /时间|地点|地址|日期|安排|约|预约|通知|确认|几点|什么时候|在哪|哪里|方便面试/.test(text);
  const interviewPlaceTime = interviewMention && interviewScheduling;
  const salary =
    /薪资|工资|待遇|薪酬|多少钱|期望薪/.test(text);
  const contact =
    /微信|wechat|手机号|手机号码|电话|联系方式|怎么联系|加个微信/.test(text);

  if (offer) {
    return {
      needManual: true,
      kind: "offer",
      reason: "面试/Offer需人工确认",
    };
  }
  if (interviewPlaceTime && !salary) {
    return {
      needManual: true,
      kind: "interview",
      reason: "面试/Offer需人工确认",
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
  if (intent.kind === "salary") {
    return "我的期望薪资在简历中有写明，具体范围可以进一步沟通。";
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

export async function chatCompletion({
  messages,
  apiKey,
  baseUrl,
  model,
  provider,
  maxTokens = 200,
  temperature = 0.8,
  fetchImpl,
} = {}) {
  const fetchFn = fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new Error("no fetch implementation");
  }
  const url = chatCompletionsUrl(baseUrl, provider);
  const response = await fetchFn(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
    }),
  });
  if (!response || response.ok === false) {
    const status = response?.status || 0;
    const message =
      (await response?.text?.().catch(() => "")) || `LLM request failed ${status}`;
    throw new Error(message);
  }
  const data = await response.json();
  const text = trimText(data?.choices?.[0]?.message?.content);
  return { text, raw: data };
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
  if (config.warning) {
    if (typeof options.onWarning === "function") options.onWarning(config.warning);
    else if (typeof options.log === "function") options.log(config.warning);
  }
  if (config.provider === "template") {
    return templateReply(hrMsg, name, skills, options);
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
  const providerConfig =
    config.provider === "zhipu" ? config.zhipu : config.deepseek;

  try {
    const completion = await chatCompletion({
      messages: [{ role: "user", content: prompt }],
      apiKey: providerConfig.apiKey,
      baseUrl: providerConfig.baseUrl,
      model: providerConfig.model,
      provider: config.provider,
      fetchImpl: options.fetchImpl,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
    });
    const reply = String(completion.text || "").slice(0, 200).trim();
    if (!reply) return templateReply(hrMsg, name, skills, options);
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
    return templateReply(hrMsg, name, skills, options);
  }
}
