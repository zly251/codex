import {
  buildReplyPrompt,
  buildSafeResumeText,
  extractSkillWhitelist,
  extractPositiveClaims,
  validateReplyForCapabilities,
  classifyIntent,
  generateReply,
  getProviderConfig,
  sanitizePromptText,
} from "../src/llmProvider.js";
import {
  parseMonthlySalaryK,
  salaryRankForJob,
  sortJobsForApply,
} from "../src/salary.js";
import { scoreJob } from "../src/scoring.js";

const ENV_KEYS = [
  "LLM_PROVIDER",
  "ZHIPU_API_KEY",
  "ZHIPU_BASE_URL",
  "ZHIPU_MODEL",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
  "DEEPSEEK_MODEL",
];

const originalEnv = {};
for (const key of ENV_KEYS) {
  originalEnv[key] = process.env[key];
}

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log("  ok - " + msg);
  } else {
    failed++;
    console.error("  FAIL - " + msg);
  }
}

function assertNear(actual, expected, msg) {
  assert(Math.abs(Number(actual) - expected) < 1e-6, msg);
}

function setEnv(values) {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
}

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
}

console.log("[salary] parseMonthlySalaryK");
assert(parseMonthlySalaryK("12K") === 12, "12K -> 12");
assert(parseMonthlySalaryK("8-12K")?.min === 8, "8-12K min -> 8");
assert(parseMonthlySalaryK("8-12K")?.max === 12, "8-12K max -> 12");
assert(parseMonthlySalaryK("1.5万-2万")?.min === 15, "1.5万-2万 min -> 15");
assert(parseMonthlySalaryK("1.5万-2万")?.max === 20, "1.5万-2万 max -> 20");
assert(parseMonthlySalaryK("12000") === 12, "12000 -> 12");
assert(parseMonthlySalaryK("面议") === null, "面议 -> null");
assert(parseMonthlySalaryK("未知") === null, "unknown -> null");

console.log("[salary] daily/hourly/annual and edge formats");
const dailySalary = parseMonthlySalaryK("70-120元/天");
assert(dailySalary && dailySalary.min === 1.54, "70-120元/天 min -> 1.54");
assert(dailySalary && dailySalary.max === 2.64, "70-120元/天 max -> 2.64");
const hourlySalary = parseMonthlySalaryK("100-120元/时");
assertNear(hourlySalary?.min, 17.6, "100-120元/时 min -> 17.6");
assertNear(hourlySalary?.max, 21.12, "100-120元/时 max -> 21.12");
const annualSalary = parseMonthlySalaryK("20-30万/年");
assertNear(annualSalary?.min, 16.666666666666668, "20-30万/年 min -> 20万/年 monthly");
assertNear(annualSalary?.max, 25, "20-30万/年 max -> 30万/年 monthly");
const annualSalary2 = parseMonthlySalaryK("年薪20-30万");
assertNear(annualSalary2?.min, 16.666666666666668, "年薪20-30万 min -> 20万/年 monthly");
assertNear(annualSalary2?.max, 25, "年薪20-30万 max -> 30万/年 monthly");
const singleAnnualSalary = parseMonthlySalaryK("20万/年");
assertNear(singleAnnualSalary, 16.666666666666668, "20万/年 -> monthly K");
const annualSalaryPrefix = parseMonthlySalaryK("年薪20万");
assertNear(annualSalaryPrefix, 16.666666666666668, "年薪20万 -> monthly K");
const aboveSalary = parseMonthlySalaryK("20K以上");
assert(aboveSalary?.min === 20 && aboveSalary?.max === null, "20K以上 -> min 20 max null");
const belowSalary = parseMonthlySalaryK("20K以下");
assert(belowSalary?.min === null && belowSalary?.max === 20, "20K以下 -> min null max 20");
const mixedRange = parseMonthlySalaryK("8千-1.2万");
assert(mixedRange?.min === 8 && mixedRange?.max === 12, "8千-1.2万 -> 8-12K");
const noUnitRange = parseMonthlySalaryK("8-12");
assert(noUnitRange?.min === 8 && noUnitRange?.max === 12, "8-12 no unit -> 8-12K");
assert(salaryRankForJob({ salaryRaw: "70-120元/天" }, "15K") === 2, "daily salary below expectation -> rank 2");
assert(salaryRankForJob({ salaryRaw: "100-120元/时" }, "15K") === 0, "hourly salary above expectation -> rank 0");
assert(salaryRankForJob({ salaryRaw: "20K以上" }, "15K") === 0, "20K以上 above expectation -> rank 0");
assert(salaryRankForJob({ salaryRaw: "20K以下" }, "25K") === 2, "20K以下 below expectation -> rank 2");

console.log("[salary] salaryRankForJob");
assert(salaryRankForJob({ salaryMin: 20, salaryMax: 25 }, "15K") === 0, "job above expectation -> 0");
assert(salaryRankForJob({ salaryMin: 8, salaryMax: 12 }, "15K") === 2, "job below expectation -> 2");
assert(salaryRankForJob({ salaryMin: 15, salaryMax: 18 }, "15K") === 1, "equal range -> 1");
assert(salaryRankForJob({ salaryMin: 10, salaryMax: 20 }, "15K") === 1, "overlapping range -> 1");
assert(salaryRankForJob({ salaryRaw: "面议" }, "15K") === 1, "unknown salary -> 1");
assert(salaryRankForJob({ salaryMin: 20, salaryMax: 25 }, null) === 1, "no expected salary -> 1");

console.log("[salary] scoreJob and sorting");
const profile = {
  skills: "C++,Qt,Linux",
  experience: "5年",
  education: "本科",
  expectedSalary: "20K",
};
const scoredJobs = [
  { title: "A", technologies: "C++,Qt", salaryMin: 30, salaryMax: 40 },
  { title: "B", technologies: "C++,Qt", salaryMin: 8, salaryMax: 10 },
  { title: "C", technologies: "C++,Qt", salaryMin: 18, salaryMax: 25 },
].map((job) => {
  const s = scoreJob(job, profile);
  return {
    job,
    score: s.score,
    salaryRank: s.salaryRank,
    salaryStatus: s.salaryStatus,
  };
});
const sortedJobs = sortJobsForApply(scoredJobs, profile.expectedSalary);
assert(sortedJobs[0].salaryRank === 0, "above-salary job sorts first");
assert(sortedJobs[sortedJobs.length - 1].salaryRank === 2, "below-salary job sorts later");
assert(sortedJobs.every((s) => ["above", "below", "compatible"].includes(s.salaryStatus)), "salaryStatus is present");

const highMatchLowSalary = {
  job: { title: "Low", technologies: "C++,Qt", salaryMin: 8, salaryMax: 10 },
  match: 0.9,
  score: 90,
};
const lowerMatchHighSalary = {
  job: { title: "High", technologies: "C++,Qt", salaryMin: 30, salaryMax: 40 },
  match: 0.8,
  score: 80,
};
const salaryPrioritized = sortJobsForApply(
  [highMatchLowSalary, lowerMatchHighSalary],
  profile.expectedSalary
);
assert(salaryPrioritized[0].job.title === "High", "lower match above-expectation job sorts before high match below-expectation job");
assert(salaryPrioritized[1].job.title === "Low", "high match below-expectation job sorts later");
assert(salaryPrioritized[0].salaryRank === 0 && salaryPrioritized[1].salaryRank === 2, "salary rank drives primary ordering");

console.log("[reply] buildReplyPrompt");
const prompt = buildReplyPrompt({
  hrMsg: "你好，方便聊一下吗",
  name: "张三",
  skills: "C++,Qt,Linux",
  profile: {
    name: "张三",
    skills: "C++,Qt,Linux",
    expectedSalary: "15K",
    experience: "5年",
    education: "本科",
    summary: "Qt桌面开发",
  },
  job: {
    title: "C++开发工程师",
    companyName: "某公司",
    salaryRaw: "15-25K",
    technologies: "C++,Qt",
    description: "桌面软件",
    requirements: "熟悉Qt",
  },
  safeResumeText: "技能: C++, Qt; 项目: 桌面工具",
  chatText: "最近聊天内容",
});
assert(prompt.includes("C++开发工程师"), "prompt includes JD title");
assert(prompt.includes("技能: C++, Qt; 项目: 桌面工具"), "prompt includes resume text");
assert(prompt.includes("15K"), "prompt includes expected salary");
assert(/严禁/.test(prompt) && /编造/.test(prompt), "prompt forbids invented capabilities");
assert(prompt.includes("底线"), "prompt represents salary floor");
assert(prompt.includes("手机号"), "prompt includes contact leak rule");

console.log("[reply] safe resume view excludes PII");
const piiResumeEditor = {
  targetRole: "C++开发工程师",
  skills: "C++,Qt",
  experience: "5年",
  education: "本科",
  expectedSalary: "18K",
  summary: "Qt桌面开发，手机:13800138000，微信号:wxid_abc",
  work: [
    { company: "某公司", title: "开发工程师", period: "2020-2022", content: "桌面软件，邮箱:a@b.com" },
  ],
  projects: [
    { name: "桌面工具", role: "独立开发", period: "2021", content: "Qt工具，身份证110101199003071234" },
  ],
  educationList: [
    { school: "某大学", degree: "本科", period: "2015-2019", content: "计算机，出生日期1990年1月1日，地址:北京市朝阳区xx路" },
  ],
};
const piiProfile = {
  name: "张三",
  phone: "13800138000",
  email: "pii@example.com",
  city: "北京",
  birthDate: "2000-01-01",
  ethnicity: "汉族",
  expectedSalary: "18K",
  skills: "C++,Qt",
};
const safeResumeView = buildSafeResumeText({
  profile: piiProfile,
  resumeEditor: { ...piiResumeEditor, photo: "data:image/png;base64,abc" },
});
const safePrompt = buildReplyPrompt({
  hrMsg: "你好",
  name: "张三",
  skills: "C++,Qt",
  profile: piiProfile,
  resumeEditor: piiResumeEditor,
});
assert(!safeResumeView.includes("13800138000"), "safe resume view excludes phone");
assert(!safeResumeView.includes("pii@example.com"), "safe resume view excludes email");
assert(!safeResumeView.includes("北京"), "safe resume view excludes city");
assert(!safeResumeView.includes("2000-01-01"), "safe resume view excludes birthDate");
assert(!safeResumeView.includes("汉族"), "safe resume view excludes ethnicity");
assert(!safeResumeView.includes("data:image"), "safe resume view excludes photo");
assert(!safeResumeView.includes("wxid_abc"), "safe resume view excludes wechat id");
assert(!safeResumeView.includes("a@b.com"), "safe resume view excludes work email");
assert(!safeResumeView.includes("110101199003071234"), "safe resume view excludes ID card number");
assert(!safeResumeView.includes("1990年1月1日"), "safe resume view excludes Chinese birth date");
assert(!safeResumeView.includes("北京市朝阳区xx路"), "safe resume view excludes address label value");
assert(safeResumeView.includes("18K"), "safe resume view preserves expectedSalary");
assert(!safePrompt.includes("13800138000"), "prompt excludes phone");
assert(!safePrompt.includes("pii@example.com"), "prompt excludes email");
assert(!safePrompt.includes("2000-01-01"), "prompt excludes birthDate");
assert(!safePrompt.includes("汉族"), "prompt excludes ethnicity");
assert(!safePrompt.includes("北京"), "prompt excludes city");
assert(!safePrompt.includes("wxid_abc"), "prompt excludes wechat id");
assert(!safePrompt.includes("a@b.com"), "prompt excludes work email");
assert(!safePrompt.includes("110101199003071234"), "prompt excludes ID card number");
assert(!safePrompt.includes("1990年1月1日"), "prompt excludes Chinese birth date");
assert(!safePrompt.includes("北京市朝阳区xx路"), "prompt excludes address label value");
assert(safePrompt.includes("18K"), "prompt preserves expectedSalary");

console.log("[reply] sanitizePromptText");
assert(!sanitizePromptText("手机号：13800138000").includes("13800138000"), "sanitize mobile number");
assert(!sanitizePromptText("电话:010-12345678").includes("010-12345678"), "sanitize landline");
assert(!sanitizePromptText("邮箱:a@b.com").includes("a@b.com"), "sanitize email");
assert(!sanitizePromptText("身份证110101199003071234").includes("110101199003071234"), "sanitize ID card");
assert(!sanitizePromptText("生日1990年1月1日").includes("1990年1月1日"), "sanitize Chinese birth date");
assert(!sanitizePromptText("生日1990-01-01").includes("1990-01-01"), "sanitize ISO birth date");
assert(!sanitizePromptText("微信：abc123").includes("abc123"), "sanitize wechat id label");
assert(!sanitizePromptText("base64,abc").includes("base64,abc"), "sanitize base64 string");

console.log("[reply] free text PII sanitized");
const freeTextPiiValues = [
  "城市北京",
  "民族汉族",
  "照片:data:image/png;base64,abc",
  "我住在广州",
  "是回族",
  "头像:data:image/jpeg;base64,xyz",
  "所在地上海",
];
const freeTextPiiPrompt = buildReplyPrompt({
  hrMsg: "你好",
  name: "张三",
  skills: "C++,Qt",
  profile: {
    skills: "C++,Qt",
    summary: "城市北京 民族汉族",
    work: [{ content: "照片:data:image/png;base64,abc" }],
    projects: [{ content: "我住在广州" }],
    educationList: [{ content: "所在地上海" }],
  },
  chatText: "是回族 头像:data:image/jpeg;base64,xyz",
});
for (const rawValue of freeTextPiiValues) {
  assert(!freeTextPiiPrompt.includes(rawValue), `prompt hides free text PII: ${rawValue}`);
}

const chatPiiPrompt = buildReplyPrompt({
  hrMsg: "你好",
  name: "张三",
  skills: "C++,Qt",
  profile: piiProfile,
  resumeEditor: piiResumeEditor,
  chatText:
    "手机:13900139000 微信号:abc123 邮箱:user@example.com 地址:北京市朝阳区xx路 1990-01-01",
});
assert(!chatPiiPrompt.includes("13900139000"), "prompt sanitizes mobile in chatText");
assert(!chatPiiPrompt.includes("abc123"), "prompt sanitizes wechat id in chatText");
assert(!chatPiiPrompt.includes("user@example.com"), "prompt sanitizes email in chatText");
assert(!chatPiiPrompt.includes("北京市朝阳区xx路"), "prompt sanitizes address in chatText");
assert(!chatPiiPrompt.includes("1990-01-01"), "prompt sanitizes birth date in chatText");

const rawTextPrompt = buildReplyPrompt({
  hrMsg: "你好",
  name: "张三",
  skills: "C++",
  profile: { ...piiProfile, rawText: "秘密SolidWorks", description: "秘密描述" },
  resume: { description: "简历秘密描述", rawText: "原始秘密" },
  resumeEditor: piiResumeEditor,
});
assert(!rawTextPrompt.includes("秘密SolidWorks"), "prompt excludes profile rawText");
assert(!rawTextPrompt.includes("秘密描述"), "prompt excludes profile description");
assert(!rawTextPrompt.includes("简历秘密描述"), "prompt excludes resume description");
assert(!rawTextPrompt.includes("原始秘密"), "prompt excludes resume rawText");

console.log("[reply] expectedSalary from resume editor is preserved");
const editorSalaryProfile = { ...piiProfile, expectedSalary: "" };
const editorSalaryResume = { ...piiResumeEditor, expectedSalary: "20K" };
const editorSalaryView = buildSafeResumeText({
  profile: editorSalaryProfile,
  resumeEditor: editorSalaryResume,
});
const editorSalaryPrompt = buildReplyPrompt({
  hrMsg: "你好",
  name: "张三",
  skills: "C++,Qt",
  profile: editorSalaryProfile,
  resumeEditor: editorSalaryResume,
});
assert(editorSalaryView.includes("20K"), "safe resume keeps salary from resume editor");
assert(editorSalaryPrompt.includes("20K"), "prompt keeps salary from resume editor");

console.log("[reply] empty resume editor expectedSalary overrides profile");
const emptyEditorProfile = { ...piiProfile, expectedSalary: "20K" };
const emptyEditorResume = { ...piiResumeEditor, expectedSalary: "" };
const emptySalaryView = buildSafeResumeText({
  profile: emptyEditorProfile,
  resumeEditor: emptyEditorResume,
});
const emptySalaryPrompt = buildReplyPrompt({
  hrMsg: "你好",
  name: "张三",
  skills: "C++,Qt",
  profile: emptyEditorProfile,
  resumeEditor: emptyEditorResume,
  expectedSalary: "",
});
assert(!emptySalaryView.includes("20K"), "safe resume drops profile salary when editor salary is empty");
assert(!emptySalaryPrompt.includes("20K"), "prompt drops profile salary when editor salary is empty");
const missingEditorSalaryView = buildSafeResumeText({
  profile: emptyEditorProfile,
  resumeEditor: {},
  expectedSalary: "",
});
const missingEditorSalaryPrompt = buildReplyPrompt({
  hrMsg: "你好",
  name: "张三",
  skills: "C++,Qt",
  profile: emptyEditorProfile,
  resumeEditor: {},
  expectedSalary: "",
});
assert(!missingEditorSalaryView.includes("20K"), "safe resume drops profile salary when editor has no salary field");
assert(!missingEditorSalaryPrompt.includes("20K"), "prompt drops profile salary when editor has no salary field");

console.log("[reply] expectedSalary PII sanitized in prompt lines");
const piiSalaryValues = [
  "城市北京",
  "民族汉族",
  "照片:data:image/png;base64,abc",
  "手机:13800138000",
];
for (const rawSalary of piiSalaryValues) {
  const piiSalaryPrompt = buildReplyPrompt({
    hrMsg: "你好",
    name: "张三",
    skills: "C++,Qt",
    profile: { skills: "C++,Qt" },
    expectedSalary: rawSalary,
  });
  assert(
    piiSalaryPrompt.includes("期望薪资是谈判底线：[已隐藏]。"),
    `salary rule line hides ${rawSalary}`
  );
  assert(
    piiSalaryPrompt.includes("期望薪资：[已隐藏]"),
    `profile line hides ${rawSalary}`
  );
  assert(!piiSalaryPrompt.includes(rawSalary), `prompt hides ${rawSalary}`);
}

console.log("[reply] capability whitelist");
console.log("[reply] positive claim extraction");
const mlClaims = extractPositiveClaims("我可以做机器学习和数据分析");
assert(mlClaims.some((c) => c.includes("机器学习")), "extract 机器学习 claim");
assert(mlClaims.some((c) => c.includes("数据分析")), "extract 数据分析 claim");
assert(extractPositiveClaims("我会SolidWorks").some((c) => c.includes("SolidWorks")), "extract SolidWorks claim");
assert(extractPositiveClaims("能开发").some((c) => c.includes("开发")), "extract 能开发 claim");
assert(extractPositiveClaims("我不能使用 Docker").length === 0, "negated 不能使用 excluded");
assert(extractPositiveClaims("从未使用过 Docker").length === 0, "negated 从未 excluded");
assert(extractPositiveClaims("不太会开发").length === 0, "negated 不太会 excluded");
assert(extractPositiveClaims("没做过机器学习").length === 0, "negated 没做过 excluded");

const whitelist = extractSkillWhitelist(
  {
    skills: "C++,Qt,Linux",
    projects: [{ content: "使用Qt开发桌面工具" }],
  },
  "技能: C++, Qt"
);
assert(whitelist.includes("c++"), "whitelist contains c++");
assert(whitelist.includes("qt"), "whitelist contains qt");
const hiddenRawWhitelist = extractSkillWhitelist(
  {
    skills: "C++",
    rawText: "SolidWorks",
    description: "Matlab",
  },
  "原始SolidWorks",
  {
    skills: "C++",
    rawText: "AutoCAD",
    description: "Blender",
  }
);
assert(!hiddenRawWhitelist.includes("solidworks"), "profile rawText does not feed whitelist");
assert(!hiddenRawWhitelist.includes("matlab"), "profile description does not feed whitelist");
assert(!hiddenRawWhitelist.includes("autocad"), "resume rawText does not feed whitelist");
assert(!hiddenRawWhitelist.includes("blender"), "resume description does not feed whitelist");
assert(validateReplyForCapabilities("我会SolidWorks", hiddenRawWhitelist).ok === false, "hidden raw-only skill is not allowed");
assert(validateReplyForCapabilities("我可以使用C++和Qt开发", whitelist).ok === true, "allowed skills pass");
assert(validateReplyForCapabilities("我熟悉 C++", ["c++"]).ok === true, "C++ with c++ whitelist passes");
assert(validateReplyForCapabilities("我会SolidWorks", ["c++"]).ok === false, "SolidWorks with c++ whitelist fails");
assert(validateReplyForCapabilities("我有五年开发经验", ["c++"]).ok === false, "generic experience with c++ whitelist fails");
assert(validateReplyForCapabilities("能开发", ["c++"]).ok === false, "generic development with c++ whitelist fails");
assert(validateReplyForCapabilities("我会机器学习和数据分析", ["机器学习"]).ok === false, "unsupported compound data analysis fails");
assert(validateReplyForCapabilities("我会机器学习和数据分析", ["机器学习", "数据分析"]).ok === true, "supported compound claims pass");
assert(validateReplyForCapabilities("我不能使用 Docker", ["c++"]).ok === true, "negated 不能使用 allowed");
assert(validateReplyForCapabilities("从未使用过 Docker", ["c++"]).ok === true, "negated 从未使用过 allowed");
assert(validateReplyForCapabilities("不太会开发", ["c++"]).ok === true, "negated 不太会 allowed");
const rejected = validateReplyForCapabilities("我熟悉Python和Java", whitelist);
assert(rejected.ok === false, "absent skills rejected");
assert(rejected.reason === "capability_guard", "capability failure exposes stable reason");
assert(rejected.missing.includes("python") && rejected.missing.includes("java"), "missing skills are listed");
const chineseWhitelist = extractSkillWhitelist(
  { skills: "机器学习,数据分析", projects: [{ content: "图像处理" }] },
  "技能: 计算机视觉"
);
assert(chineseWhitelist.includes("机器学习"), "Chinese whitelist contains 机器学习");
assert(chineseWhitelist.includes("数据分析"), "Chinese whitelist contains 数据分析");
assert(chineseWhitelist.includes("图像处理"), "structured project content feeds whitelist");
assert(chineseWhitelist.includes("计算机视觉"), "resume text feeds whitelist");
assert(validateReplyForCapabilities("我可以做机器学习和数据分析", chineseWhitelist).ok === true, "supported Chinese skills pass");
const chineseRejected = validateReplyForCapabilities("我可以做深度学习和数据挖掘", chineseWhitelist);
assert(chineseRejected.ok === false, "absent Chinese skills rejected");
assert(chineseRejected.missing.includes("深度学习") && chineseRejected.missing.includes("数据挖掘"), "absent Chinese skills are listed");

const genericRejected = validateReplyForCapabilities("我会开发", ["c++"]);
assert(genericRejected.ok === false, "generic development claim blocked");
assert(genericRejected.missing.includes("开发"), "generic development term listed");
const experienceRejected = validateReplyForCapabilities("有多年经验", ["c++"]);
assert(experienceRejected.ok === false, "generic experience claim blocked");
assert(experienceRejected.missing.includes("经验"), "generic experience term listed");
const aiClaimRejected = validateReplyForCapabilities("做过AI项目", ["c++"]);
assert(aiClaimRejected.ok === false, "generic AI project claim blocked");
assert(aiClaimRejected.missing.includes("ai"), "AI term listed when unsupported");
assert(validateReplyForCapabilities("我会开发，熟练使用C++和Qt", ["c++", "qt", "开发"]).ok === true, "supported generic claim passes");
assert(validateReplyForCapabilities("我不会 Docker", ["c++"]).ok === true, "negated Docker allowed");
assert(validateReplyForCapabilities("我不会做机器学习", ["c++"]).ok === true, "negated Chinese skill with 做 allowed");
assert(validateReplyForCapabilities("没学过数据分析", ["c++"]).ok === true, "negated data analysis with 学过 allowed");
assert(validateReplyForCapabilities("没做过机器学习", ["c++"]).ok === true, "negated Chinese skill allowed");
assert(validateReplyForCapabilities("没有接触过数据分析", ["c++"]).ok === true, "negated data analysis allowed");
assert(validateReplyForCapabilities("不太熟悉 Node.js", ["c++"]).ok === true, "negated English skill allowed");
assert(validateReplyForCapabilities("我有五年开发经验。我熟悉 C++", ["c++"]).ok === false, "generic experience in separate sentence fails");
assert(validateReplyForCapabilities("我熟悉 C++，能开发", ["c++"]).ok === false, "separate generic development claim fails");
assert(validateReplyForCapabilities("我熟悉 C++，主要在 C++ 桌面开发", ["c++"]).ok === true, "generic development in same claim as C++ passes");
assert(validateReplyForCapabilities("我能做 C++ 开发和算法", ["c++"]).ok === false, "separate unsupported 算法 fails");
assert(validateReplyForCapabilities("我能做 C++ 开发和算法", ["c++", "算法"]).ok === true, "whitelisted 算法 passes");
const algorithmRejected = validateReplyForCapabilities("我能做 C++ 算法", ["c++"]);
assert(algorithmRejected.ok === false, "same-claim unsupported 算法 fails");
assert(algorithmRejected.missing.includes("算法"), "same-claim unsupported 算法 is listed");
assert(validateReplyForCapabilities("我能做 C++ 算法", ["c++", "算法"]).ok === true, "same-claim whitelisted 算法 passes");
const automationRejected = validateReplyForCapabilities("我会 C++ 自动化", ["c++"]);
assert(automationRejected.ok === false, "same-claim unsupported 自动化 fails");
assert(automationRejected.missing.includes("自动化"), "same-claim unsupported 自动化 is listed");
assert(validateReplyForCapabilities("我会 C++ 自动化", ["c++", "自动化"]).ok === true, "same-claim whitelisted 自动化 passes");
assert(validateReplyForCapabilities("我不是很会 Docker", ["c++"]).ok === true, "negated 不是很会 allowed");
assert(validateReplyForCapabilities("Docker 我没用过", ["c++"]).ok === true, "negated Docker 我没用过 allowed");
assert(extractPositiveClaims("我不是很会 Docker").length === 0, "negated 不是很会 excluded");
assert(extractPositiveClaims("Docker 我没用过").length === 0, "negated Docker 我没用过 excluded");

console.log("[reply] fake Zhipu");
setEnv({
  LLM_PROVIDER: "zhipu",
  ZHIPU_API_KEY: "test-key",
  ZHIPU_BASE_URL: "https://fake.example/v4",
  ZHIPU_MODEL: "test-model",
  DEEPSEEK_API_KEY: "",
  DEEPSEEK_BASE_URL: "",
  DEEPSEEK_MODEL: "",
});
let fakeCall = null;
const modelReply = await generateReply("请问岗位需要什么技能？", "张三", "C++,Qt", {
  profile: { skills: "C++,Qt", expectedSalary: "15K" },
  resumeText: "技能: C++, Qt",
  fetchImpl: async (url, init) => {
    fakeCall = { url, init };
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "您好，我可以使用C++和Qt开发。" } }],
      }),
    };
  },
});
assert(modelReply === "您好，我可以使用C++和Qt开发。", "fake Zhipu model text is returned");
assert(fakeCall?.url.includes("/chat/completions"), "chat completion endpoint is called");
assert(fakeCall?.init?.headers?.Authorization === "Bearer test-key", "Zhipu auth header is used");
assert(String(fakeCall?.init?.body || "").includes("test-model"), "configured model is sent");

console.log("[reply] zhipu missing key warning");
setEnv({
  LLM_PROVIDER: "zhipu",
  ZHIPU_API_KEY: "",
  ZHIPU_BASE_URL: "",
  ZHIPU_MODEL: "",
  DEEPSEEK_API_KEY: "test-key",
  DEEPSEEK_BASE_URL: "https://fake.example/v1",
  DEEPSEEK_MODEL: "deepseek-test",
});
const zhipuMissingConfig = getProviderConfig(process.env);
assert(zhipuMissingConfig.provider === "deepseek", "zhipu without key falls back to DeepSeek");
assert(zhipuMissingConfig.warning && zhipuMissingConfig.warning.includes("ZHIPU_API_KEY"), "zhipu missing key returns warning");
let warnedMessage = "";
const warningReply = await generateReply("请问岗位需要什么技能？", "张三", "C++", {
  profile: { skills: "C++" },
  onWarning: (msg) => { warnedMessage = msg; },
  fetchImpl: async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: "您好，我会C++。" } }] }),
  }),
});
assert(warnedMessage.includes("ZHIPU_API_KEY"), "generateReply emits provider warning");
assert(typeof warningReply === "string" && warningReply.length > 0, "warning fallback still returns reply");

console.log("[reply] no keys fallback");
setEnv({
  LLM_PROVIDER: "",
  ZHIPU_API_KEY: "",
  ZHIPU_BASE_URL: "",
  ZHIPU_MODEL: "",
  DEEPSEEK_API_KEY: "",
  DEEPSEEK_BASE_URL: "",
  DEEPSEEK_MODEL: "",
});
const templateReply = await generateReply("你好，可以聊聊吗", "张三", "C++,Qt");
assert(typeof templateReply === "string" && templateReply.length > 0, "template fallback is returned without keys");
assert(templateReply.length <= 200, "template fallback is bounded");

console.log("[reply] capability guard fallback");
setEnv({
  LLM_PROVIDER: "zhipu",
  ZHIPU_API_KEY: "test-key",
  ZHIPU_BASE_URL: "https://fake.example/v4",
  ZHIPU_MODEL: "test-model",
  DEEPSEEK_API_KEY: "",
  DEEPSEEK_BASE_URL: "",
  DEEPSEEK_MODEL: "",
});
const guardReply = await generateReply("你会C++吗？", "张三", "C++", {
  profile: { skills: "C++" },
  resumeText: "技能: C++",
  fetchImpl: async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: "我会SolidWorks" } }],
    }),
  }),
});
assert(guardReply?.ok === false && guardReply?.reason === "capability_guard", "capability guard failure returns stable reason");
assert(typeof guardReply?.reply === "string" && guardReply.reply.length > 0, "capability guard failure returns fixed fallback text");

console.log("[reply] manual intent");
const interviewIntent = classifyIntent("明天下午方便面试吗？地点在哪里？");
assert(interviewIntent.needManual === true, "interview time/place -> manual");
assert(interviewIntent.reason === "面试/Offer需人工确认", "manual reason is stable");
assert(classifyIntent("请问薪资范围大概多少").needManual === false, "salary question is allowed");
assert(classifyIntent("offer已经发了吗").needManual === true, "offer question -> manual");
assert(classifyIntent("什么时间方便沟通").needManual === false, "normal timing question not manual");
assert(classifyIntent("您几点方便").needManual === false, "normal convenient time question not manual");
assert(classifyIntent("什么时候方便聊").needManual === false, "normal chat timing question not manual");
assert(classifyIntent("面试时间定在明天几点").needManual === true, "interview time -> manual");
assert(classifyIntent("面试地点在哪里").needManual === true, "interview location -> manual");
assert(classifyIntent("安排面试吧").needManual === true, "schedule interview -> manual");
assert(classifyIntent("约个面试").needManual === true, "make interview appointment -> manual");
assert(classifyIntent("offer确认").needManual === true, "offer confirmation -> manual");
assert(classifyIntent("入职时间是什么时候").needManual === true, "onboarding time -> manual");
assert(classifyIntent("到岗时间方便吗").needManual === true, "start time -> manual");
const manualResult = await generateReply("明天下午方便面试吗？", "张三", "C++", {
  profile: { skills: "C++" },
  fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [] }) }),
});
assert(manualResult?.ok === false && manualResult?.needManual === true, "generateReply returns manual object without LLM call");

restoreEnv();

console.log(`\nresult: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
