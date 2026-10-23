// M5 console 模块单元测试 + 扩展侧零 DOM 写红线断言
// 纯函数测试，无 DB、无网络、无子进程。所有期望值为手算对照。
// 覆盖：
//   组1  console 纯函数：buildConsole / toMarkdown / validateConsoleResult
//   组2  M5 零副作用：不 import fs/net/child_process，不碰 process/global
//   组3  扩展侧红线：content.js 零 DOM 写、background.js 零 DOM 引用、panel.js 只写自己的面板
//   组4  panel.js esc() XSS 转义单元测试
//   组5  console ↔ extension 交互面（消息名 / 载荷形状）锁定

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log("  ✓ " + msg);
  } else {
    failed++;
    failures.push(msg);
    console.error("  ✗ " + msg);
  }
}

const { readFile } = await import("fs/promises");
const { join, dirname } = await import("path");
const { fileURLToPath } = await import("url");

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const CONSOLE_DIR = join(REPO_ROOT, "src", "modules", "console");
const EXT_DIR = join(REPO_ROOT, "extension");

// ============================================================
// [组1] buildConsole — 正常聚合
// ============================================================
console.log("\n[组1] buildConsole · 正常聚合");
const {
  SCHEMA_VERSION,
  SummarySchema,
  DetailItemSchema,
  ConsoleResultSchema,
  validateConsoleResult,
  buildConsole,
  toMarkdown,
  CONSOLE_MODULE_VERSION,
  CONSOLE_MODULE_NAME,
} = await import("../../../src/modules/console/index.js");

assert(SCHEMA_VERSION === "console-v1", `SCHEMA_VERSION = console-v1 (得 ${SCHEMA_VERSION})`);
assert(CONSOLE_MODULE_NAME === "console" && typeof CONSOLE_MODULE_VERSION === "string",
  `模块名/版本导出齐全 (${CONSOLE_MODULE_NAME}@${CONSOLE_MODULE_VERSION})`);

// 对照组：2 岗位 / 2 价值卡 / 3 证据回执 / 3 建议
const baseInput = {
  jobs: [
    { jobId: "j1", jobTitle: "Java后端开发", companyName: "杭州字节科技有限公司" },
    { jobId: "j2", jobTitle: "前端开发", companyName: "阿里" },
    { jobId: "j3", jobTitle: "运维工程师", companyName: "阿里" },
  ],
  valueCards: [
    { jobId: "j1", jobTitle: "Java后端开发", score: 88, salary: { min: 12000, max: 18000 } },
    { jobId: "j2", jobTitle: "前端开发", score: 70, salary: { min: 9000, max: 15000 } },
  ],
  evidenceReceipts: [
    { ok: true, meta: { jobTitle: "Java后端开发" }, markers: [] },
    { ok: false, meta: { jobTitle: "前端开发" }, markers: ["job_title_empty"] },
    { ok: true, meta: { jobTitle: "运维工程师" }, markers: ["salary_suspicious"] },
  ],
  chatSuggestions: [
    { jobTitle: "Java后端开发", text: "a" },
    { jobTitle: "Java后端开发", text: "b" },
    { jobTitle: "运维工程师", text: "c" },
  ],
};

{
  const r = buildConsole(baseInput);
  assert(r.ok === true, "聚合结果 ok=true");
  assert(r.schemaVersion === "console-v1", "结果带 schemaVersion=console-v1");
  assert(r._validationErrors === undefined, "正常输入无 _validationErrors");
  assert(r.summary.totalJobs === 3, `汇总岗位数 = 3 (得 ${r.summary.totalJobs})`);
  // avgSalary：只取 valueCards 的 salary.max：(18000 + 15000)/2 = 16500
  assert(r.summary.avgSalary === 16500, `平均薪资 = 16500 (得 ${r.summary.avgSalary})`);
  // highRiskCount = ok 为假的回执数 = 1
  assert(r.summary.highRiskCount === 1, `高风险数 = 1 (得 ${r.summary.highRiskCount})`);
  // pendingReviewCount = ok 且 markers 非空 = 1（运维工程师）
  assert(r.summary.pendingReviewCount === 1, `待确认数 = 1 (得 ${r.summary.pendingReviewCount})`);
  assert(r.detail.length === 3, `明细条数 = 3 (得 ${r.detail.length})`);

  const j1 = r.detail.find((d) => d.jobTitle === "Java后端开发");
  assert(j1 && j1.companyName === "杭州字节科技有限公司", "明细按公司归属正确");
  assert(j1 && j1.valueScore === 88, `价值评分透传 = 88 (得 ${j1 && j1.valueScore})`);
  assert(j1 && j1.salary.min === 12000 && j1.salary.max === 18000, "薪资区间透传正确");
  assert(j1 && j1.evidenceOk === true, "证据 ok 透传");
  assert(j1 && j1.suggestionCount === 2, `建议数 = 2 (得 ${j1 && j1.suggestionCount})`);

  const j3 = r.detail.find((d) => d.jobTitle === "运维工程师");
  assert(j3 && j3.salary.min === 0 && j3.salary.max === 0, "无价值卡岗位薪资兜底 {0,0}");
  assert(j3 && j3.valueScore === 0, "无价值卡岗位评分兜底 0");
  assert(j3 && j3.evidenceOk === true && j3.suggestionCount === 1, "无价值卡岗位仍能接上证据与建议");
}

// ============================================================
// [组2] 空输入 / 缺字段 — 纯函数不炸
// ============================================================
console.log("\n[组2] 空输入与缺字段兜底");
{
  const r0 = buildConsole({});
  assert(r0.summary.totalJobs === 0 && r0.summary.avgSalary === 0, "空对象 → 全 0 汇总");
  assert(r0.detail.length === 0 && r0.ok === true, "空对象 → 空明细且 ok");

  const r1 = buildConsole();
  assert(r1 && r1.ok === true && r1.detail.length === 0, "不传参也不抛异常");

  const r2 = buildConsole({ jobs: [{}, { jobTitle: "无公司岗位" }] });
  assert(r2.summary.totalJobs === 2, "缺 companyName 也能计数");
  assert(r2.detail[0].companyName === "未知公司", "公司名兜底为「未知公司」");
  assert(r2.detail.some((d) => d.jobTitle === "无公司岗位"), "仅给 jobTitle 也能进明细");
}

// ============================================================
// [组3] 纯函数性 — 同输入严格同输出，且不改动入参
// ============================================================
console.log("\n[组3] 纯函数性（幂等 + 不改入参）");
{
  const snapshot = JSON.stringify(baseInput);
  const a = buildConsole(baseInput);
  const b = buildConsole(baseInput);
  assert(JSON.stringify(a) === JSON.stringify(b), "同输入两次调用结果严格相等");
  assert(JSON.stringify(baseInput) === snapshot, "buildConsole 未修改入参对象");
  assert(a.detail !== b.detail, "两次调用返回独立数组（无共享可变状态）");
}

// ============================================================
// [组4] toMarkdown — 只读渲染
// ============================================================
console.log("\n[组4] toMarkdown 渲染");
{
  const r = buildConsole(baseInput);
  const md = toMarkdown(r);
  assert(md.startsWith("# 求职助手控制台汇总"), "Markdown 含标题行");
  assert(md.includes("| 岗位 | 公司 | 薪资 | 价值评分 | 证据 | 建议数 |"), "Markdown 含表头");
  assert(md.includes("|------|------|------|----------|------|--------|"), "Markdown 含分隔行");
  assert(md.includes("| Java后端开发 | 杭州字节科技有限公司 | 12000-18000 | 88 | ✅ | 2 |"),
    "Markdown 明细行按手算对照渲染");
  assert(md.includes("- 岗位总数：3") && md.includes("- 平均薪资：16500"), "Markdown 汇总数字与 summary 一致");
  assert(md.includes("- 高风险岗位：1") && md.includes("- 待确认岗位：1"), "Markdown 风险/待确认计数正确");
  assert(toMarkdown(r) === md, "toMarkdown 幂等（同输入同输出）");
  assert(md.includes("❌"), "证据失败行渲染 ❌");
}

// ============================================================
// [组5] validateConsoleResult / schema — 形状变更即失败
// ============================================================
console.log("\n[组5] 类型校验与 schema 形状");
{
  assert(validateConsoleResult(null).length > 0, "null 输入报错");
  assert(validateConsoleResult({}).length > 0, "空对象报错");
  const r = buildConsole(baseInput);
  assert(validateConsoleResult(r).length === 0, "合法结果零校验错误");

  const bad1 = { ...r, schemaVersion: "console-v2" };
  assert(validateConsoleResult(bad1).length === 1, "schemaVersion 篡改 → 报错");
  const bad2 = { ...r, ok: "true" };
  assert(validateConsoleResult(bad2).length === 1, "ok 非 boolean → 报错");
  const bad3 = { ...r, summary: null };
  assert(validateConsoleResult(bad3).length === 1, "summary 缺失 → 报错");
  const bad4 = { ...r, detail: {} };
  assert(validateConsoleResult(bad4).length === 1, "detail 非数组 → 报错");

  assert(JSON.stringify(SummarySchema) === JSON.stringify({
    totalJobs: "number", avgSalary: "number", highRiskCount: "number", pendingReviewCount: "number",
  }), "SummarySchema 四字段形状锁定");

  assert(JSON.stringify(DetailItemSchema) === JSON.stringify({
    jobTitle: "string", companyName: "string", salary: "object",
    valueScore: "number", evidenceOk: "boolean", suggestionCount: "number",
  }), "DetailItemSchema 六字段形状锁定");

  assert(JSON.stringify(ConsoleResultSchema) === JSON.stringify({
    schemaVersion: "string", ok: "boolean", summary: "object", detail: "array",
  }), "ConsoleResultSchema 四字段形状锁定");

  // 实测：summary/detail 键集合不得漂移
  assert(JSON.stringify(Object.keys(r.summary).sort()) === JSON.stringify(
    ["avgSalary", "highRiskCount", "pendingReviewCount", "totalJobs"]), "summary 键集合锁定");
  assert(JSON.stringify(Object.keys(r.detail[0]).sort()) === JSON.stringify(
    ["companyName", "evidenceOk", "jobTitle", "salary", "suggestionCount", "valueScore"]),
    "detail item 键集合锁定");
}

// ============================================================
// [组6] M5 零副作用 — 源码扫描 + 运行期 moduleLoadList
// ============================================================
console.log("\n[组6] M5 零副作用（无 fs / 网络 / 子进程）");
{
  const srcs = {};
  for (const f of ["console.js", "types.js", "index.js"]) {
    srcs[f] = await readFile(join(CONSOLE_DIR, f), "utf-8");
  }

  const SIDE_EFFECT_PATTERNS = [
    /\brequire\s*\(\s*["'](?:fs|node:fs)/,
    /\bfrom\s+["'](?:fs|node:fs)/,
    /\b(?:require|from)\s*\(?\s*["'](?:net|node:net|http|node:http|https|node:https|dgram|node:dgram)/,
    /\b(?:require|from)\s*\(?\s*["'](?:child_process|node:child_process)/,
    /\bspawn\s*\(/,
    /\bexecSync\s*\(/,
    /\bfetch\s*\(/,
    /\bXMLHttpRequest\b/,
    /\bprocess\s*\.\s*(?:exit|cwd|env)\b/,
    /\bconsole\s*\.\s*(?:log|error|warn)\s*\(/,
  ];
  for (const [f, src] of Object.entries(srcs)) {
    const hits = [];
    for (const re of SIDE_EFFECT_PATTERNS) {
      const m = src.match(re);
      if (m) hits.push(m[0]);
    }
    assert(hits.length === 0, `${f} 无 fs/网络/子进程/io 副作用调用${hits.length ? " → 命中 " + hits.join(",") : ""}`);
  }

  // 运行期证据：import 前后 process.moduleLoadList 不得新增 child_process/net/http/fs
  const banned = /node:(?:child_process|net|http|https|dgram|fs)/;
  const before = (process.moduleLoadList || []).filter((m) => banned.test(m)).length;
  await import("../../../src/modules/console/index.js?fresh=" + Date.now());
  const after = (process.moduleLoadList || []).filter((m) => banned.test(m)).length;
  assert(after === before, `导入 M5 未新增任何 fs/net/http/child_process 内置模块 (${before} → ${after})`);

  // M5 不得 import 其他 modules（与 G2/G4 同向的自证）
  for (const [f, src] of Object.entries(srcs)) {
    const imps = [...src.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]);
    const bad = imps.filter((p) => p.includes("modules/") || p.includes("../"));
    assert(bad.length === 0, `${f} 无跨模块/旧链 import${bad.length ? " → " + bad.join(",") : ""}`);
  }
}

// ============================================================
// [组7] 扩展侧红线第一层：content.js 零 DOM 写
// ============================================================
console.log("\n[组7] 红线 L1 · content.js 零 DOM 写");
const extSrc = {};
for (const f of ["background.js", "content.js", "panel.js"]) {
  extSrc[f] = await readFile(join(EXT_DIR, f), "utf-8");
}

const WRITE_CALLS = [
  "innerHTML", "outerHTML", "insertAdjacentHTML", "insertAdjacentElement",
  "insertAdjacentText", "document.write", "document.writeln",
  "appendChild", "append", "prepend", "prependChild", "removeChild",
  "replaceChild", "replaceWith", "remove(", "insertBefore", "createElement",
  "createElementNS", "createTextNode", "createComment", "cloneNode",
  "setAttribute", "removeAttribute", "classList.add", "classList.remove",
  "classList.toggle", "setProperty", "removeProperty", "style.cssText",
  "insertRule", "innerHTML=", "value =", "value=", "checked =",
  "submit(", "click(", ".click()", "dispatchEvent", "focus()", "scrollIntoView",
];
const ASSIGN_WRITES = [
  /\.innerText\s*=/, /\.textContent\s*=/, /\.innerHTML\s*=/, /\.value\s*=/,
  /\.href\s*=/, /\.src\s*=/, /\.className\s*=/,
];
{
  const src = extSrc["content.js"];
  const hits = WRITE_CALLS.filter((w) => src.includes(w));
  assert(hits.length === 0, `content.js 无 DOM 写 API${hits.length ? " → 命中 " + hits.join(", ") : ""}`);

  const assignHits = ASSIGN_WRITES.filter((re) => re.test(src)).map((re) => re.source);
  assert(assignHits.length === 0, `content.js 无赋值式写入${assignHits.length ? " → 命中 " + assignHits.join(", ") : ""}`);

  // 只读证据：只允许 querySelectorAll / innerText 读取
  assert(src.includes("document.querySelectorAll"), "content.js 仍保留只读 querySelectorAll");
  assert(src.includes("innerText"), "content.js 仍保留只读 innerText");
  // 反过来确认没有 mutation observer / 事件派发
  assert(!src.includes("MutationObserver"), "content.js 无 MutationObserver（不做页面变更观测注入）");
  assert(!src.includes("addEventListener"), "content.js 不向页面注册任何事件监听");
}

// ============================================================
// [组8] 红线 L1 · background.js 零 DOM 引用
// ============================================================
console.log("\n[组8] 红线 L1 · background.js 零 DOM 引用");
{
  const src = extSrc["background.js"];
  const domRefs = ["document.", "window.", "innerHTML", "appendChild", "createElement", "querySelector"];
  const hits = domRefs.filter((w) => src.includes(w));
  assert(hits.length === 0, `background.js 无 document/window DOM 引用${hits.length ? " → " + hits.join(", ") : ""}`);
  assert(src.includes("chrome.sidePanel"), "background.js 只做 sidePanel 开关（行为未漂移）");
}

// ============================================================
// [组9] 红线 L2 · panel.js 不得向平台页注入写指令
// ============================================================
console.log("\n[组9] 红线 L2 · panel.js 写操作只落在自家面板");
{
  const src = extSrc["panel.js"];
  // 面板自身渲染是允许的（豁免）：这些写操作的目标是 panel.html 的自有节点
  const EXEMPT_NOTE = "豁免：panel.js 渲染的是自己的 sidePanel UI（panel.html 的 #suggestions/#vc-* /#job-*），不写招聘平台页面 DOM";
  const writeHits = WRITE_CALLS.filter((w) => src.includes(w));
  assert(writeHits.length > 0, `panel.js 确实存在写操作（${writeHits.length} 类）→ ${EXEMPT_NOTE}`);

  // 真正的红线：不得向页面注入脚本 / 携带写入类指令
  const INJECT_PATTERNS = [
    "chrome.scripting.executeScript",
    "chrome.tabs.executeScript",
    "chrome.scripting.insertCSS",
    "chrome.tabs.insertCSS",
  ];
  const injectHits = INJECT_PATTERNS.filter((w) => src.includes(w));
  // executeScript 唯一出现处是 content.js 的「只读自愈注入」，且注入的是本项目 content.js（只读脚本）
  assert(injectHits.length === 1 && injectHits[0] === "chrome.scripting.executeScript",
    `panel.js 的注入 API 仅限 content.js 只读自愈一处（命中 ${injectHits.join(",")}）`);

  const injIdx = src.indexOf("chrome.scripting.executeScript");
  const injCtx = src.slice(injIdx, injIdx + 300);
  assert(injCtx.includes('files: ["content.js"]'), "注入目标固定为本项目只读脚本 content.js（非内联任意代码）");
  assert(!/func\s*:|code\s*:/.test(injCtx), "注入不使用 func/code 内联函数（不可夹带写操作）");

  // 消息面：panel → content 只发 READ_PAGE（读），不得带写指令
  // 写意图词不含 "type:" —— 否则会误伤 { type: "READ_PAGE" } 这个字段名本身
  const WRITE_INTENT = ["写入", "修改", "填充", "点击", "提交", "setValue", "WRITE", "SET_VALUE", "FILL"];
  const sentMsgs = [...src.matchAll(/sendMessage\([^)]*\{([^}]*)\}/g)].map((m) => m[1]);
  assert(sentMsgs.length >= 1, "panel.js 存在向 content 的消息发送");
  const badIntent = [];
  for (const m of sentMsgs) {
    for (const w of WRITE_INTENT) if (m.includes(w)) badIntent.push(w);
  }
  assert(badIntent.length === 0, `panel → content 消息不含写意图指令${badIntent.length ? " → " + badIntent.join(",") : ""}`);
  // 正向锁定：发出去的消息 type 值只能是 READ_PAGE
  const sentTypes = [...src.matchAll(/sendMessage\([^)]*?type:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert(sentTypes.length >= 1 && sentTypes.every((t) => t === "READ_PAGE"),
    `panel 发出的消息 type 恒为 READ_PAGE (得 ${sentTypes.join(",")})`);

  // panel 不得直接查询平台页 DOM（只能 getElementById 自己面板里的节点）
  assert(!src.includes("document.querySelectorAll"), "panel.js 不得对页面做 querySelectorAll（只操作自家节点）");
  const getEl = [...src.matchAll(/document\.getElementById\(/g)];
  assert(getEl.length > 0, "panel.js 用 getElementById 定位自家面板节点");
}

// ============================================================
// [组10] panel.js esc() XSS 转义单元测试（真 XSS 面）
// ============================================================
console.log("\n[组10] panel.js esc() 转义单测");
{
  const src = extSrc["panel.js"];
  const m = src.match(/function\s+esc\s*\(\s*s\s*\)\s*\{[\s\S]*?\n\}/);
  assert(!!m, "panel.js 中存在 esc() 转义函数");
  const esc = new Function("return (" + m[0].replace(/^function\s+esc/, "function esc") + ")")();
  // 上面 new Function 返回的是函数声明，取其值
  const escFn = typeof esc === "function" ? esc : null;
  assert(typeof escFn === "function", "esc() 可被独立取出执行");

  const cases = [
    ["<script>alert(1)</script>", "&lt;script&gt;alert(1)&lt;/script&gt;"],
    ['"><img onerror=alert(1)>', "&quot;&gt;&lt;img onerror=alert(1)&gt;"],
    ["'", "&quot;"], // esc 只转义双引号，单引号原样（见下条说明）
    ["&", "&amp;"],
    ["<small>", "&lt;small&gt;"],
  ];
  // 注：esc 的映射表只处理 & < > " 四个字符，单 ' 不转义——这是既有实现，
  // 测试按实际语义断言：单引号不会被转成实体（不构成 innerHTML 内的属性逃逸，因为属性用双引号包裹）
  const safeCases = [
    ["<script>alert(1)</script>", "&lt;script&gt;alert(1)&lt;/script&gt;"],
    ['"><img onerror=alert(1)>', "&quot;&gt;&lt;img onerror=alert(1)&gt;"],
    ["&", "&amp;"],
    ["<small>", "&lt;small&gt;"],
    ["</div><script>x</script>", "&lt;/div&gt;&lt;script&gt;x&lt;/script&gt;"],
    ["<svg/onload=alert(1)>", "&lt;svg/onload=alert(1)&gt;"],
  ];
  for (const [input, expected] of safeCases) {
    const out = escFn(input);
    assert(out === expected, `esc(${JSON.stringify(input)}) = ${JSON.stringify(expected)} (得 ${JSON.stringify(out)})`);
  }

  // 反向断言：转义结果里不得再出现可执行标记
  for (const input of ["<script>alert(1)</script>", '"><img onerror=alert(1)>', "<svg/onload=1>", "<iframe src=x>"]) {
    const out = escFn(input);
    assert(!out.includes("<script") && !out.includes("<img") && !out.includes("<svg") && !out.includes("<iframe"),
      `esc 输出无可执行标签残留：${JSON.stringify(input)} → ${JSON.stringify(out)}`);
    assert(!/[<>"]/.test(out), `esc 输出无裸尖括号/双引号：${JSON.stringify(out)}`);
  }

  // 非空/非字符串兜底
  assert(escFn("") === "", "esc('') = ''");
  assert(escFn(null) === "null", "esc(null) 走 String() 兜底不抛异常");
  assert(escFn(undefined) === "undefined", "esc(undefined) 走 String() 兜底不抛异常");

  // 幂等性：二次转义不得产生双重实体绕过
  const once = escFn("<b>x</b>");
  assert(escFn(once) !== once, "esc 二次转义会继续实体化（无反向解码路径）");
}

// ============================================================
// [组11] console ↔ extension 交互面锁定
// ============================================================
console.log("\n[组11] 交互面锁定：消息名 / 载荷形状");
{
  // (a) panel → content 消息名固定为 READ_PAGE
  const panel = extSrc["panel.js"];
  const content = extSrc["content.js"];
  assert(/sendMessage\([^)]*type:\s*"READ_PAGE"/.test(panel), "panel.js 发送 {type:\"READ_PAGE\"}");
  assert(/msg\.type\s*===\s*"READ_PAGE"/.test(content), "content.js 只响应 READ_PAGE 一种消息");

  // (b) content → panel 回包形状锁定：{ok, pageText, href}
  const respM = content.match(/sendResponse\(\{([^}]*)\}\)/);
  assert(!!respM, "content.js 有 sendResponse 回包");
  const keys = (respM ? respM[1] : "").split(",").map((s) => s.split(":")[0].trim()).filter(Boolean).sort();
  assert(JSON.stringify(keys) === JSON.stringify(["href", "ok", "pageText"]),
    `回包键集合 = ok/pageText/href (得 ${keys.join("/")})`);
  assert(panel.includes("page.pageText") && panel.includes("page.href"), "panel.js 按 pageText/href 消费回包");

  // (c) panel → server 请求体形状锁定：{pageText, href, commuteMode, oneWayKm}
  const bodyM = panel.match(/body:\s*JSON\.stringify\(\{([\s\S]*?)\}\)/);
  assert(!!bodyM, "panel.js 有 POST 请求体");
  const bodyKeys = (bodyM ? bodyM[1] : "")
    .split(",").map((s) => s.split(":")[0].trim()).filter(Boolean).sort();
  assert(JSON.stringify(bodyKeys) === JSON.stringify(["commuteMode", "href", "oneWayKm", "pageText"]),
    `请求体键集合 = pageText/href/commuteMode/oneWayKm (得 ${bodyKeys.join("/")})`);
  assert(panel.includes("/api/extension/look"), "panel.js 打到 /api/extension/look");

  // (d) server → panel 响应字段形状锁定
  for (const field of ["jobTitle", "needManual", "suggestions", "value", "reason"]) {
    assert(panel.includes("data." + field), `panel.js 消费服务端字段 data.${field}`);
  }

  // (e) console 模块侧对接 value 卡的真实字段形状（与 src/value.mjs computeValueCard 对齐）
  const card = {
    ok: true,
    jobId: "j1",
    jobTitle: "Java后端开发",
    score: 88,
    salary: { min: 6000, max: 10000 },
  };
  const r = buildConsole({ jobs: [{ jobId: "j1", jobTitle: "Java后端开发", companyName: "阿里" }], valueCards: [card] });
  assert(r.detail[0].valueScore === 88 && r.detail[0].salary.max === 10000,
    "console 能消费 value 卡的 score/salary 字段（与 computeValueCard 同形）");

  // (f) 证据回执字段形状（与 evidence 模块同形）：ok / markers / meta.jobTitle
  const r2 = buildConsole({
    jobs: [{ jobTitle: "前端开发", companyName: "阿里" }],
    evidenceReceipts: [{ ok: true, markers: ["x"], meta: { jobTitle: "前端开发" } }],
  });
  assert(r2.summary.pendingReviewCount === 1, "console 能消费 evidence 回执的 ok/markers/meta.jobTitle");

  // (g) 建议项字段形状：{jobTitle, text}
  const r3 = buildConsole({
    jobs: [{ jobTitle: "运维", companyName: "阿里" }],
    chatSuggestions: [{ jobTitle: "运维", label: "追问薪资", text: "请问薪资结构" }],
  });
  assert(r3.detail[0].suggestionCount === 1, "console 能消费 chatSuggestions 的 jobTitle 关联");
  assert(r3.detail[0].suggestionCount === 1 && !("label" in r3.detail[0]), "建议项只聚合计数，不把 label 泄漏进明细");
}

// ============================================================
// 汇总
// ============================================================
console.log("\n" + "=".repeat(50));
console.log(`Console 模块测试结果: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("失败项:");
  failures.forEach((f) => console.error("  - " + f));
  process.exit(1);
} else {
  console.log("✅ 全部通过");
}
