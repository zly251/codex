// M3 LLM 提供方/降级链/候选人底细卡 单元测试（仅 mock fetch，绝不发真实网络请求）
// 运行：node scripts/test-m3-llm.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getProviderConfig,
  chatCompletion,
  generateReply,
  classifyIntent,
  buildSafeResumeText,
  buildReplyPrompt,
  extractSkillWhitelist,
  validateReplyForCapabilities,
  candidateCardWhitelistTerms,
  resolveCandidateCardPath,
  loadCandidateCardText,
  sanitizePromptText,
} from "../src/llmProvider.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log("  ok -", msg);
  } else {
    failed++;
    console.error("  FAIL -", msg);
  }
}
function section(name) {
  console.log("\n== " + name + " ==");
}

// —— 环境隔离：测试全部用显式 env 对象；进程环境变量里有真实 key，防串扰先摘除 ——
const GUARDED_ENV_KEYS = [
  "LLM_PROVIDER",
  "QODER_GATEWAY_API_KEY",
  "QODER_GATEWAY_BASE_URL",
  "QODER_GATEWAY_MODEL",
  "ZHIPU_API_KEY",
  "ZHIPU_BASE_URL",
  "ZHIPU_MODEL",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
  "DEEPSEEK_MODEL",
  "JOB_AGENT_CANDIDATE_CARD_PATH",
];
const savedEnv = {};
for (const key of GUARDED_ENV_KEYS) {
  savedEnv[key] = process.env[key];
  delete process.env[key];
}
function restoreEnv() {
  for (const key of GUARDED_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
}

// 假 key（只用于断言绝不外泄，不是真实凭据）
const FK_GW = "fk-gatewa…-9d31";
const FK_ZP = "fk-zhipu-***";
const FK_DS = "fk-deepse…-2a88";
const ALL_KEYS_ENV = {
  QODER_GATEWAY_API_KEY: FK_GW,
  ZHIPU_API_KEY: FK_ZP,
  DEEPSEEK_API_KEY: FK_DS,
};

function jsonResponse(content) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}
function recordingFetch(replyFor) {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body || "{}");
    calls.push({
      url,
      headers: init.headers || {},
      body,
      authorization: (init.headers || {}).Authorization,
      providerHint: /zhipu|bigmodel/.test(url)
        ? "zhipu"
        : /deepseek/.test(url)
          ? "deepseek"
          : "localgateway",
    });
    return typeof replyFor === "function" ? replyFor(calls.length - 1, body) : jsonResponse(replyFor);
  };
  fn.calls = calls;
  return fn;
}
function failingFetch() {
  const calls = [];
  const fn = async (url, init) => {
    calls.push(url);
    throw new Error("fetch failed");
  };
  fn.calls = calls;
  return fn;
}
function collectWarnings() {
  const list = [];
  return {
    list,
    onWarning: (msg) => list.push(String(msg)),
  };
}

// ============================================================
section("A. getProviderConfig provider 矩阵（>=6 组合）");
{
  const a = getProviderConfig({ ...ALL_KEYS_ENV });
  ok(a.provider === "localgateway", "三 key 齐全 → 首选 localgateway");
  ok(
    JSON.stringify(a.chain) === JSON.stringify(["localgateway", "zhipu", "deepseek", "template"]),
    "默认降级链顺序 localgateway→zhipu→deepseek→template"
  );

  const b = getProviderConfig({ QODER_GATEWAY_API_KEY: FK_GW });
  ok(b.provider === "localgateway" && JSON.stringify(b.chain) === '["localgateway","template"]', "只有网关 key → 链仅 gateway+template");
  ok(b.localgateway.baseUrl === "http://127.0.0.1:3010/v1", "网关默认 baseUrl");
  ok(b.localgateway.model === "qwen3.8-flash", "网关默认 model=qwen3.8-flash");
  ok(b.localgateway.omitMaxTokens === true, "网关 omitMaxTokens=true（不发 max_tokens）");

  const c = getProviderConfig({ ZHIPU_API_KEY: FK_ZP });
  ok(c.provider === "zhipu", "只有智谱 key → zhipu");
  const d = getProviderConfig({ DEEPSEEK_API_KEY: FK_DS });
  ok(d.provider === "deepseek", "只有 deepseek key → deepseek");

  const e = getProviderConfig({});
  ok(e.provider === "template" && JSON.stringify(e.chain) === '["template"]', "无 key → template 兜底");

  const f = getProviderConfig({ ...ALL_KEYS_ENV, LLM_PROVIDER: "zhipu" });
  ok(f.provider === "zhipu", "显式 LLM_PROVIDER=zhipu 优先");
  ok(f.chain.includes("localgateway") && f.chain.includes("deepseek"), "显式指定后其余提供方保留在重试链中");

  const g = getProviderConfig({ ...ALL_KEYS_ENV, LLM_PROVIDER: "template" });
  ok(g.provider === "template" && g.chain.length === 1, "LLM_PROVIDER=template → 强制模板，链长 1");

  const h = getProviderConfig({ ZHIPU_API_KEY: FK_ZP, LLM_PROVIDER: "localgateway" });
  ok(h.provider === "zhipu", "指定 localgateway 但缺 key → 回退其他可用方");
  ok(
    (h.warnings || []).some((w) => w.includes("LLM_PROVIDER=localgateway") && w.includes("QODER_GATEWAY_API_KEY")),
    "缺网关 key 的 warning 点名环境变量名"
  );

  const i2 = getProviderConfig({ LLM_PROVIDER: "zhipu" });
  ok(
    i2.warning === "LLM_PROVIDER=zhipu 但未配置 ZHIPU_API_KEY，已回退到其他可用提供方或模板",
    "zhipu 缺 key 的首要 warning 文案与 M2 完全一致（兼容存量断言）"
  );

  const j = getProviderConfig({ ...ALL_KEYS_ENV, LLM_PROVIDER: "no-such-provider" });
  ok(
    (j.warnings || []).some((w) => w.includes("不是已注册的提供方")) && j.provider === "localgateway",
    "未知 override → warning + 默认链"
  );

  const k = getProviderConfig({
    QODER_GATEWAY_API_KEY: FK_GW,
    QODER_GATEWAY_BASE_URL: "http://127.0.0.1:9999/v1",
    QODER_GATEWAY_MODEL: "some-model",
  });
  ok(
    k.localgateway.baseUrl === "http://127.0.0.1:9999/v1" && k.localgateway.model === "some-model",
    "QODER_GATEWAY_BASE_URL / MODEL 环境变量覆盖生效"
  );
  ok(k.zhipu.omitMaxTokens === false && k.deepseek.omitMaxTokens === false, "zhipu/deepseek 仍发 max_tokens");
}

// ============================================================
section("B. chatCompletion 请求体断言（mock fetch）");
await (async () => {
  const cfg = getProviderConfig({ ...ALL_KEYS_ENV });
  const fetchGw = recordingFetch("好的");
  const r1 = await chatCompletion({
    messages: [{ role: "user", content: "岗位还在招吗" }],
    apiKey: cfg.localgateway.apiKey,
    baseUrl: cfg.localgateway.baseUrl,
    model: cfg.localgateway.model,
    provider: "localgateway",
    omitMaxTokens: cfg.localgateway.omitMaxTokens,
    systemPrompt: cfg.localgateway.systemPrompt,
    fetchImpl: fetchGw,
  });
  ok(r1.text === "好的", "网关链路返回解析出文本");
  const call = fetchGw.calls[0];
  ok(call.url === "http://127.0.0.1:3010/v1/chat/completions", "网关请求 URL 正确");
  ok(call.authorization === `Bearer ${FK_GW}`, "网关带 Authorization: Bearer <key>");
  ok(!("max_tokens" in call.body), "网关请求体不含 max_tokens");
  ok(call.body.model === "qwen3.8-flash", "网关默认 model 进入请求体");
  ok(
    call.body.messages[0].role === "system" && call.body.messages[0].content.includes("回复不超过80字"),
    "网关 system 提示含 80 字硬约束"
  );
  ok(
    call.body.messages[0].content.includes("口语化") && call.body.messages[0].content.includes("模拟本人"),
    "网关 system 提示含口语化/模拟本人"
  );

  const fetchZp = recordingFetch("收到");
  await chatCompletion({
    messages: [{ role: "user", content: "hello" }],
    apiKey: cfg.zhipu.apiKey,
    baseUrl: cfg.zhipu.baseUrl,
    model: cfg.zhipu.model,
    provider: "zhipu",
    omitMaxTokens: cfg.zhipu.omitMaxTokens,
    fetchImpl: fetchZp,
  });
  ok(typeof fetchZp.calls[0].body.max_tokens === "number", "zhipu 请求体包含 max_tokens");
  ok(!fetchZp.calls[0].body.messages.some((m) => m.role === "system"), "zhipu 不注入网关 system 提示");
})();

// 超时分类：mock 一个尊重 AbortSignal 的挂起 fetch
await (async () => {
  const hangingFetch = (url, init) =>
    new Promise((_resolve, reject) => {
      (init.signal || new AbortController().signal).addEventListener("abort", () => {
        const err = new Error("This operation was aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  let kind = "";
  try {
    await chatCompletion({
      messages: [{ role: "user", content: "x" }],
      apiKey: FK_GW,
      baseUrl: "http://127.0.0.1:3010/v1",
      model: "qwen3.8-flash",
      provider: "localgateway",
      timeoutMs: 50,
      omitMaxTokens: true,
      fetchImpl: hangingFetch,
    });
  } catch (e) {
    kind = e.kind || "";
  }
  ok(kind === "timeout", "AbortController 超时被归类为 timeout（不误判 network）");
})();

// HTTP 失败：不读响应正文
await (async () => {
  const badStatus = async () => ({ ok: false, status: 503, json: async () => ({ secret_leak: "x" }) });
  let kind = "";
  try {
    await chatCompletion({
      messages: [{ role: "user", content: "x" }],
      apiKey: FK_GW,
      baseUrl: "http://127.0.0.1:3010/v1",
      model: "m",
      provider: "localgateway",
      fetchImpl: badStatus,
    });
  } catch (e) {
    kind = e.kind || "";
    ok(!String(e.message).includes("secret_leak"), "HTTP 错误消息不携带响应正文");
  }
  ok(kind === "http", "非 2xx 归类为 http");
})();

// 缺 key → config
await (async () => {
  let kind = "";
  try {
    await chatCompletion({
      messages: [{ role: "user", content: "x" }],
      apiKey: "",
      baseUrl: "http://127.0.0.1:3010/v1",
      model: "m",
      provider: "localgateway",
      fetchImpl: recordingFetch("y"),
    });
  } catch (e) {
    kind = e.kind || "";
  }
  ok(kind === "config", "空 key 直接归类 config，不发请求");
})();

// ============================================================
section("C. 跨提供方降级重试（generateReply）");
{
  // 网关挂 → 智谱救场
  const warn = collectWarnings();
  const seqFetch = recordingFetch((n) =>
    n === 0 ? Promise.reject(new Error("fetch failed")) : jsonResponse("我先把简历发您看下")
  );
  const r1 = await generateReply("岗位还开着吗", "张三", "Qt", {
    env: { ...ALL_KEYS_ENV },
    fetchImpl: seqFetch,
    onWarning: warn.onWarning,
  });
  ok(typeof r1 === "string" && r1.includes("简历"), "网关 network 失败后由 zhipu 成功回复");
  ok(seqFetch.calls.length === 2, "共发起 2 次请求（gateway→zhipu）");
  ok(seqFetch.calls[1].authorization === `Bearer ${FK_ZP}`, "第二次请求带的是 zhipu 的 key");
  ok(warn.list.some((w) => w.includes("provider=localgateway") && w.includes("错误类别=network")), "降级 warning 点名 provider 与错误类别");

  // 空回复也算失败，继续降级
  const warn2 = collectWarnings();
  const emptyThenOk = recordingFetch((n) => (n === 0 ? jsonResponse("   ") : jsonResponse("可以，方便详细聊聊")));
  const r2 = await generateReply("方便电话沟通吗", "张三", "Qt", {
    env: { ...ALL_KEYS_ENV },
    fetchImpl: emptyThenOk,
    onWarning: warn2.onWarning,
  });
  ok(typeof r2 === "string" && r2.length > 0, "网关空回复 → 降级 zhipu 成功");
  ok(warn2.list.some((w) => w.includes("错误类别=empty")), "空回复被归类 empty 并发 warning");

  // 全链失败 → 模板兜底
  const warn3 = collectWarnings();
  const failing = failingFetch();
  const r3 = await generateReply("请问薪资范围大概多少", "张三", "Qt", {
    env: { ...ALL_KEYS_ENV },
    fetchImpl: failing,
    onWarning: warn3.onWarning,
  });
  ok(r3 === "我的期望薪资在简历中有写明，具体范围可以进一步沟通。", "全部提供方失败 → 薪资模板回复");
  ok(failing.calls.length === 3, "三个提供方都尝试过");
  ok(warn3.list.some((w) => w.includes("全部提供方失败") && w.includes("已落模板回复")), "链耗尽有明确 warning");

  // HTTP 5xx 也走降级
  const warn4 = collectWarnings();
  let hits = 0;
  const httpThenOk = async (url, init) => {
    hits++;
    if (hits === 1) return { ok: false, status: 500, json: async () => ({}) };
    return jsonResponse("这块我参与过，主要做需求和验收");
  };
  const r4 = await generateReply("你做过类似岗位吗", "张三", "Qt", {
    env: { ...ALL_KEYS_ENV },
    fetchImpl: httpThenOk,
    onWarning: warn4.onWarning,
  });
  ok(typeof r4 === "string" && r4.includes("验收"), "HTTP 失败后降级链继续工作");
  ok(warn4.list.some((w) => w.includes("错误类别=http")), "HTTP 失败类别进 warning");

  // warning 绝不泄露 key 值
  const allWarn = [...warn.list, ...warn2.list, ...warn3.list, ...warn4.list].join("\n");
  ok(!allWarn.includes(FK_GW) && !allWarn.includes(FK_ZP) && !allWarn.includes(FK_DS), "onWarning 输出不含任何 API key 值");
  ok(!allWarn.includes("Bearer fk-"), "onWarning 输出不含 Authorization 头原文");
}

// ============================================================
section("D. capability_guard：内容违规立即返回，不跨 provider 重试");
{
  const warn = collectWarnings();
  const fetchGuard = recordingFetch("我会SolidWorks，可以独立干活");
  const r = await generateReply("你会三维软件吗", "张三", "C++", {
    env: { QODER_GATEWAY_API_KEY: FK_GW, ZHIPU_API_KEY: FK_ZP },
    fetchImpl: fetchGuard,
    onWarning: warn.onWarning,
    safeResumeText: "技能: C++,Qt,OpenGL",
  });
  ok(r && r.ok === false && r.reason === "capability_guard", "白名单外能力认领 → guard 对象");
  ok(typeof r.reply === "string" && r.reply.includes("简历里没有明确写"), "guard 回复是固定兜底话术");
  ok(fetchGuard.calls.length === 1, "guard 只触发 1 次请求：不做跨 provider 重试");
  ok(!warn.list.some((w) => w.includes("降级到 zhipu")), "guard 路径没有产生降级 warning");

  // 白名单内回复正常放行
  const fetchOk2 = recordingFetch("需求梳理和质量验收是我主要做的");
  const r2 = await generateReply("你平时负责什么", "张三", "C++", {
    env: { QODER_GATEWAY_API_KEY: FK_GW },
    fetchImpl: fetchOk2,
    safeResumeText: "技能: 需求梳理,质量验收,数据分析",
  });
  ok(typeof r2 === "string", "白名单内回复直接放行");

  // 人工意图：不花 LLM 调用
  const manualFetch = recordingFetch("不该被调用");
  const r3 = await generateReply("明天下午方便面试吗？地点在哪里？", "张三", "Qt", {
    env: { QODER_GATEWAY_API_KEY: FK_GW },
    fetchImpl: manualFetch,
  });
  ok(r3.needManual === true && r3.ok === false, "面试+地点时间 → needManual 对象");
  ok(manualFetch.calls.length === 0, "needManual 分支不发任何 LLM 请求");
}

// ============================================================
section("E. classifyIntent：裸面试邀约穿闸修复（真网关冒烟抓出的红线）");
{
  const leaks = ["明天上午10点来面试吧，方便吗", "来面试吧", "方便的话明天来公司面谈"];
  for (const msg of leaks) {
    const it = classifyIntent(msg);
    ok(it.needManual === true, `裸邀约转人工: ${msg}`);
  }
  ok(classifyIntent("请问薪资范围大概多少").needManual === false, "薪资问题不被误拦（无面试词）");
  ok(classifyIntent("什么时间方便沟通").needManual === false, "普通约聊时间不误拦");
  ok(classifyIntent("您几点方便").needManual === false, "普通几点不误拦");
  ok(classifyIntent("什么时候方便聊").needManual === false, "普通什么时候不误拦");
  ok(classifyIntent("安排面试吧").needManual === true, "存量：安排面试 → manual");
  ok(classifyIntent("约个面试").needManual === true, "存量：约个面试 → manual");
  ok(classifyIntent("面试时间定在明天几点").needManual === true, "存量：面试时间 → manual");
  ok(classifyIntent("offer已经发了吗").needManual === true, "存量：offer → manual");
  ok(classifyIntent("方便留个微信吗").needManual === false, "要微信不转人工（contact）");

  const manualR = await generateReply("明天上午10点来面试吧", "张三", "Qt", {
    env: { QODER_GATEWAY_API_KEY: FK_GW },
    fetchImpl: recordingFetch("不该被调用"),
  });
  ok(manualR && manualR.needManual === true && manualR.reply === "", "generateReply 对裸邀约直接转人工，不代答");
}

// ============================================================
section("F. 候选人底细卡：注入 / sanitize / 缺卡维持现状");
{
  const tmpCard = path.join(
    fs.mkdtempSync(path.join(process.env.TEMP || __dirname, "m3card-")),
    "candidate-card.md"
  );
  fs.writeFileSync(
    tmpCard,
    "# 测试卡\n## 1. 能独立干活\n- 需求梳理（手机 13800001111，邮箱 test@example.com）\n## 仅了解\n- Rust\n",
    "utf8"
  );

  const resolved = resolveCandidateCardPath({ JOB_AGENT_CANDIDATE_CARD_PATH: tmpCard });
  ok(resolved === tmpCard, "JOB_AGENT_CANDIDATE_CARD_PATH 显式覆盖生效");

  const cardText = loadCandidateCardText({ JOB_AGENT_CANDIDATE_CARD_PATH: tmpCard });
  ok(!cardText.includes("13800001111") && cardText.includes("[已隐藏]"), "卡读入即过 sanitizePromptText（手机号被遮）");
  ok(!cardText.includes("test@example.com"), "卡内邮箱被遮");

  const withCard = buildSafeResumeText({
    profile: { skills: "Qt" },
    candidateCardPath: tmpCard,
  });
  ok(withCard.startsWith("候选人底细:\n[[CANDIDATE_CARD_BEGIN]]"), "底细块注入且置顶");
  ok(withCard.includes("[[CANDIDATE_CARD_END]]"), "底细块有结束哨兵");
  ok(!withCard.includes("13800001111"), "safeResumeText 输出不含卡内手机号");

  // 缺卡验证：显式 env 指向不存在路径（空串会回退到仓库默认卡，不算缺卡）
  const missingPath = path.join(path.dirname(tmpCard), "no-such-card.md");
  ok(loadCandidateCardText({ JOB_AGENT_CANDIDATE_CARD_PATH: missingPath }) === "", "卡不存在 → 读出空串");
  const noCard = buildSafeResumeText({
    profile: { skills: "Qt" },
    candidateCardPath: missingPath,
  });
  ok(!noCard.includes("[[CANDIDATE_CARD"), "缺卡时输出不含卡片哨兵（维持现状）");
  ok(noCard === "技能: Qt", "缺卡时输出与 M2 行为逐字节一致");
  const promptNoCard = buildReplyPrompt({
    hrMsg: "岗位还在吗",
    name: "张三",
    skills: "Qt",
    candidateCardPath: missingPath,
  });
  ok(!promptNoCard.includes("唯一来源"), "缺卡时不注入唯一来源规则行");

  const promptWith = buildReplyPrompt({
    hrMsg: "岗位还在吗",
    name: "张三",
    skills: "Qt",
    candidateCardPath: tmpCard,
  });
  ok(promptWith.includes("候选人底细卡是事实与口径的唯一来源"), "有卡 → 注入唯一来源规则行");
  ok(promptWith.includes("回复不超过80字，口语化，模拟本人"), "提示词含长度与语气硬约束");
  ok(!promptWith.includes("13800001111"), "buildReplyPrompt 全文无卡内手机号");
  // 卡经 safeResumeText 预拼传入时不重复注入
  const promptPre = buildReplyPrompt({
    hrMsg: "岗位还在吗",
    name: "张三",
    skills: "Qt",
    safeResumeText: withCard,
  });
  ok(
    (promptPre.match(/\[\[CANDIDATE_CARD_BEGIN\]\]/g) || []).length === 1,
    "safeResumeText 已含卡时不重复注入"
  );
  ok(promptPre.includes("唯一来源"), "预拼卡片同样触发唯一来源规则行");

  // sanitize 兜底：直接传含 PII 的卡字符串
  const promptPii = buildReplyPrompt({
    hrMsg: "hi",
    name: "张三",
    skills: "Qt",
    candidateCard: "联系方式: 13900002222 生日: 2003-05-17",
  });
  ok(!promptPii.includes("13900002222"), "传入字符串卡也过 sanitize（手机号被遮）");
  ok(!promptPii.includes("2003-05-17"), "卡内出生日期被遮");
  fs.rmSync(tmpCard, { force: true });
}

// ============================================================
section("G. 真实底细卡 prompts/candidate-card.md：白名单语义");
{
  const realPath = path.join(ROOT, "prompts", "candidate-card.md");
  ok(fs.existsSync(realPath), "真实底细卡文件存在");
  const card = fs.readFileSync(realPath, "utf8");
  // 2026-09-19：用户已就「年龄/期望薪资/到岗/主投方向」四项签字，卡顶标记由「待签字」改为「已签字」。
  // 断言改为：卡顶必须带有明确的签字状态标记（未签 / 已签都算），防止将来被静默删掉。
  ok(card.includes("待用户签字确认") || card.includes("已由用户签字确认"), "卡顶保留签字状态标记（未签/已签）");
  if (card.includes("已由用户签字确认")) {
    ok(!card.includes("〔待确认"), "已签字后卡内不再残留〔待确认〕字段");
    ok(/不低于\s*4000/.test(card), "已签字卡片写明期望薪资底线 4000");
  }

  const terms = candidateCardWhitelistTerms(card);
  ok(terms.length >= 12, `真实卡白名单 >=12 词（实际 ${terms.length}）`);
  const has = (t) => terms.includes(t);
  ok(has("qt"), "白名单含 qt（2.2 工作使用层，按卡内口径认领）");
  ok(has("需求分析") && has("业务沟通") && has("客户沟通") && has("质量验收"), "白名单含核心业务词");
  ok(has("数据分析") && has("自动化"), "白名单含数据分析/自动化");
  const banned = ["solidworks", "六级", "cet-4", "cet", "c++", "python", "docker", "cuda"];
  for (const b2 of banned) {
    ok(!terms.some((t) => t.includes(b2)), `白名单不含禁区词: ${b2}`);
  }

  // 整条词条目不被切碎（曾经的顿号连写解析 bug 回归位）
  const mini = "<!-- WHITELIST-BEGIN -->\n需求梳理、业务沟通\n<!-- WHITELIST-END -->";
  const miniTerms = candidateCardWhitelistTerms(mini);
  ok(miniTerms.includes("需求梳理") && miniTerms.includes("业务沟通"), "顿号分隔条目逐条完整解析");

  // 全链路：真实卡注入 safeResumeText 后，SolidWorks 认领仍被 guard 拦
  const wl = extractSkillWhitelist(
    { skills: "C++,Qt,数据分析" },
    buildSafeResumeText({ profile: { skills: "C++,Qt,数据分析" }, candidateCard: sanitizePromptText(card) })
  );
  ok(wl.includes("qt") && wl.includes("需求分析"), "白名单合并了卡片 WHITELIST 区词条");
  ok(!wl.includes("solidworks"), "solidworks 不进白名单（2.3/红线区不参与）");
  ok(!wl.includes("rust"), "标题为「仅了解」的层不取词（无标记区时按标题过滤）");
  ok(validateReplyForCapabilities("我会SolidWorks", wl).ok === false, "带真实卡时 SolidWorks 认领仍触发 guard");
  ok(validateReplyForCapabilities("我做过需求分析和质量验收", wl).ok === true, "卡内白名单能力正常放行");

  const guardWarn = collectWarnings();
  const g = await generateReply("你会SolidWorks吗", "张三", "C++", {
    env: { QODER_GATEWAY_API_KEY: FK_GW, ZHIPU_API_KEY: FK_ZP },
    fetchImpl: recordingFetch("我会SolidWorks，还能做装配体"),
    onWarning: guardWarn.onWarning,
    safeResumeText: buildSafeResumeText({ profile: { skills: "C++,Qt" }, candidateCard: sanitizePromptText(card) }),
  });
  ok(g && g.reason === "capability_guard", "generateReply 端到端：真实卡在场时违规回复被 guard");
}

// ============================================================
section("H. 回归锚点（M3 不改变既有行为）");
{
  const cfg = getProviderConfig({ ...ALL_KEYS_ENV });
  ok(cfg.deepseek.baseUrl === "https://api.deepseek.com", "deepseek baseUrl 默认不变");
  const fetchDeep = recordingFetch("ok");
  await chatCompletion({
    messages: [{ role: "user", content: "x" }],
    apiKey: FK_DS,
    baseUrl: cfg.deepseek.baseUrl,
    model: cfg.deepseek.model,
    provider: "deepseek",
    fetchImpl: fetchDeep,
  });
  ok(fetchDeep.calls[0].url === "https://api.deepseek.com/v1/chat/completions", "deepseek URL 补 /v1 行为不变");

  const salary = await generateReply("薪资范围多少", "张三", "Qt", {
    env: {},
    fetchImpl: failingFetch(),
  });
  ok(salary === "我的期望薪资在简历中有写明，具体范围可以进一步沟通。", "无提供方时薪资模板兜底不变");

  const contact = await generateReply("方便加个微信吗", "张三", "Qt", {
    env: {},
    fetchImpl: failingFetch(),
  });
  ok(contact.includes("联系方式"), "联系方式模板兜底不变");

  ok(sanitizePromptText("电话：13512345678").includes("[已隐藏]"), "sanitizePromptText 仍遮电话");
}

restoreEnv();

console.log(`\nresult: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
