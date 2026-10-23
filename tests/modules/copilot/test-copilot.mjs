// M3 copilot 模块测试 —— 输出守卫（隐私词 / 技能白名单 / 160 字截断）+ 三态判定 + 编排层
// 运行：node tests/modules/copilot/test-copilot.mjs
// 约定：零依赖，自带 assert；exit 1 = 有失败。

import {
  loadWhitelistTerms,
  parseWhitelistTerms,
  normalizeTerm,
  scanPrivacy,
  extractSkillMentions,
  checkSkillWhitelist,
  truncateText,
  guardText,
  guardSuggestions,
} from "../../../src/modules/copilot/guard.js";
import { decide, detectSuggestionType } from "../../../src/modules/copilot/intent.js";
import { generateSuggestions } from "../../../src/modules/copilot/copilot.js";
import {
  SCHEMA_VERSION,
  STATUS,
  MAX_TEXT_LEN,
  GUARD_RESULT,
  validateCopilotResult,
} from "../../../src/modules/copilot/types.js";

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) passed++;
  else {
    failed++;
    failures.push(msg);
    console.error("  ✗ " + msg);
  }
}

// ─────────────────────────────────────────────
// 1. 白名单真源解析（解析底细卡，不许模块内硬编码副本）
// ─────────────────────────────────────────────
console.log("[1] 技能白名单真源（prompts/candidate-card.md）");
const WL = loadWhitelistTerms();
assert(WL.length >= 12, `白名单应 ≥12 词（实测 ${WL.length}；不断言恰好14，因"AI协作使用"等词会被再切分）`);
assert(WL.includes("需求分析") && WL.includes("业务沟通") && WL.includes("自动化"), "白名单应含关键业务词（需求分析/业务沟通/自动化）");
assert(WL.includes("qt"), `白名单应含 Qt（归一化后小写；实测含 ${WL.filter(t => /qt/.test(t))}）`);
for (const banned of ["c++", "python", "java", "solidworks"]) {
  assert(!WL.includes(banned), `禁区词 ${banned} 不得出现在白名单内`);
}
assert(parseWhitelistTerms("没有任何标记区的文本") .length === 0, "无 WHITELIST 标记区应返回空数组（不猜）");
assert(normalizeTerm("- 需求分析（半年）") === "需求分析", "normalizeTerm 去列表符与括号注释");
assert(normalizeTerm("  Qt ") === "qt", "normalizeTerm 去空白并转小写");

// ─────────────────────────────────────────────
// 2. 输出守卫 ① 隐私词拦截（命中即整条拦下，不外发）
// ─────────────────────────────────────────────
console.log("[2] 守卫①隐私词拦截");
const privacyCases = [
  ["我的手机号是13812345678，方便联系", "phone", "手机号"],
  ["身份证 11010119900101123X 请查收", "idCard", "身份证号"],
  ["工资卡卡号6222020200112233", "bankCard", "银行卡号"],
  ["方便加个微信吗", "wechat", "微信号"],
  ["我的住址是南京市玄武区珠江路1号", "address", "具体住址"],
  ["详细住址：幸福路88号3栋", "address", "住址关键词"],
  ["发邮件到 zhang@example.com", "email", "邮箱"],
  ["我出生于1990年1月1日", "birthday", "精确生日"],
];
for (const [text, id, label] of privacyCases) {
  const hit = scanPrivacy(text);
  assert(hit && hit.id === id, `scanPrivacy 应命中「${label}」：${text}`);
  const g = guardText(text, { whitelist: WL });
  assert(!g.ok && g.result === GUARD_RESULT.BLOCKED && g.guard.hit === id, `guardText 应整条拦截（${label}）且不外发文本：${g.reason}`);
}
assert(scanPrivacy("您好，请问这个岗位还招人吗？") === null, "正常话术不得误拦隐私词");

// ─────────────────────────────────────────────
// 3. 输出守卫 ② 技能白名单（白名单外技能词触发拒绝）
// ─────────────────────────────────────────────
console.log("[3] 守卫②技能白名单");
{
  const g1 = guardText("我精通C++和Python开发，能独立完成项目", { whitelist: WL });
  assert(!g1.ok && g1.guard.hit === "skill_whitelist", `白名单外技能词应拒绝：${g1.reason}`);
  const { offenders } = extractSkillMentions("我精通C++和Python开发", WL);
  assert(offenders.includes("c++") && offenders.includes("python"), `offenders 应含 c++/python：${offenders}`);
  const g2 = guardText("我在需求分析和业务沟通方面经验丰富", { whitelist: WL });
  assert(g2.ok && g2.result === GUARD_RESULT.PASS, "白名单内技能词（需求分析/业务沟通）应放行");
  const g3 = guardText("您好，看到贵司在招Qt岗位，方便聊聊吗？", { whitelist: WL });
  assert(g3.ok, `白名单内 Qt 单独出现不应误拦：${g3.reason}`);
  const g4 = guardText("我是做桌面开发工作的", { whitelist: WL });
  assert(!g4.ok && g4.offenders === undefined && g4.guard.hit === "skill_whitelist" && /开发/.test(g4.reason), `泛词"开发"认领语境一律拦截（guard.js 口径：泛词出现在任何位置都算认领，宁严勿漏）：${g4.reason}`);
  const empty = checkSkillWhitelist("我精通Python", []);
  assert(!empty.ok && empty.offenders.includes("python"), "白名单为空时已知技术词不得放行（无白名单则不敢放行）");
}

// ─────────────────────────────────────────────
// 4. 输出守卫 ③ 160 字截断（≤160 且以完整句或省略号收尾）
// ─────────────────────────────────────────────
console.log("[4] 守卫③160字截断");
{
  const long500 = "啊".repeat(500);
  const t1 = truncateText(long500);
  assert(t1.truncated && t1.text.length <= MAX_TEXT_LEN && t1.text.endsWith("…"), `500字无标点输入 → ≤160 且省略号收尾（实测 ${t1.text.length} 字）`);

  const sentences = "这是第一段内容说明。".repeat(30); // 420 字，每 10 字一个句号
  const t2 = truncateText(sentences);
  const lastCh = t2.text[t2.text.length - 1];
  assert(t2.truncated && t2.text.length <= MAX_TEXT_LEN && /[。！？；]/.test(lastCh), `超长带句号文本 → ≤160 且完整句收尾（实测 ${t2.text.length} 字，收尾「${lastCh}」）`);

  const t3 = truncateText("短句不截断。");
  assert(!t3.truncated && t3.text === "短句不截断。", "≤160 字文本原样返回");

  const g = guardText("嗯".repeat(200), { whitelist: WL });
  assert(g.ok && g.result === GUARD_RESULT.TRUNCATED && g.text.length <= MAX_TEXT_LEN, "guardText 对超长文本返回 TRUNCATED 且已裁剪");
}

// ─────────────────────────────────────────────
// 5. 三态判定（每态 ≥2 用例，附判定依据字段）
// ─────────────────────────────────────────────
console.log("[5] 三态判定");
// noChat
{
  const d1 = decide({});
  assert(d1.status === STATUS.NO_CHAT && d1.signals.hasText === false, "noChat①：全空输入 → 依据 signals.hasText=false");
  const d2 = decide({ pageText: "   ", hrMsg: "", chatHistory: [] });
  assert(d2.status === STATUS.NO_CHAT && typeof d2.reason === "string" && d2.reason.length > 0, "noChat②：全空白 → 依据 reason 说明均空");
}
// needManual
{
  const d1 = decide({ hrMsg: "你的offer已审批，下周一确认入职日期" });
  assert(d1.status === STATUS.NEED_MANUAL && d1.matched.length > 0 && d1.intents.includes("offer"), `needManual①：offer/入职 → 依据 matched=${d1.matched}`);
  const d2 = decide({ hrMsg: "我们试用期三个月，社保按最低基数交" });
  assert(d2.status === STATUS.NEED_MANUAL && d2.matched[0] === "试用期", `needManual②：试用期/社保 → 依据 matched=${d2.matched}`);
  const d3 = decide({ pageText: "岗位性质：外包驻场项目" });
  assert(d3.status === STATUS.NEED_MANUAL && d3.intents.includes("outsourcing"), `needManual③：外包/驻场红线 → 依据 intents=${d3.intents}`);
}
// OK（正常建议）
{
  const d1 = decide({ hrMsg: "你好，看到你对我们的岗位感兴趣" });
  assert(d1.status === STATUS.OK && d1.intents.includes("general"), `OK①：一般沟通 → 依据 intents=${d1.intents}`);
  const d2 = decide({ hrMsg: "你的期望薪资是多少？" });
  assert(d2.status === STATUS.OK && d2.signals.salary === true && d2.intents.includes("salary") && d2.matched.length > 0, `OK②：薪资询问 → 依据 signals.salary/intents/matched=${d2.matched}`);
  const d3 = decide({ hrMsg: "明天下午3点来公司面试可以吗" });
  assert(d3.status === STATUS.OK && d3.signals.interview === true, `OK③：面试邀约可代答 → 依据 signals.interview`);
  assert(detectSuggestionType(d3.__ || { hrMsg: "明天下午3点来公司面试" }) === "interview", "detectSuggestionType：面试邀约 → interview");
  assert(detectSuggestionType({ hrMsg: "你的期望薪资多少" }) === "salary", "detectSuggestionType：薪资 → salary");
  assert(detectSuggestionType({ pageText: "岗位详情页文本" }) === "greeting", "detectSuggestionType：仅页面文本无对话 → greeting");
}

// ─────────────────────────────────────────────
// 6. 编排层：所有对外 text 必过守卫；三态直通；不只靠硬编码模板
// ─────────────────────────────────────────────
console.log("[6] 编排层 generateSuggestions");
{
  // 6a. 外部草稿优先且逐条过守卫
  const okDraft = "请问这个团队目前多少人？";
  const r = generateSuggestions(
    { hrMsg: "你好，对岗位感兴趣吗" },
    {
      whitelist: WL,
      drafts: [
        "我的手机号13812345678，直接联系我",   // 隐私词 → 拦
        "我精通SolidWorks建模",                // 白名单外技能 → 拦
        "嗯".repeat(200),                      // 超长 → 截断放行
        okDraft,                               // 正常 → 放行
        okDraft,                               // 重复 → 正文去重拦下
      ],
    }
  );
  assert(r.status === STATUS.OK && r.ok === true, "OK 态：status=OK 且 ok=true");
  assert(r.suggestions.some(s => s.text === okDraft), "外部草稿（非模板）应出现在建议里 —— 不是只剩硬编码模板");
  assert(r.suggestions.every(s => s.text.length <= MAX_TEXT_LEN), `外发建议全部 ≤${MAX_TEXT_LEN} 字`);
  assert(r.suggestions.every(s => !/1[3-9]\d{9}/.test(s.text) && !/SolidWorks/i.test(s.text)), "被拦隐私词/越界技能词绝不出现在外发文本");
  assert(r.blocked.some(b => b.guard && b.guard.hit === "phone"), "blocked 留痕含隐私拦截（原始文本保留供审计）");
  assert(r.blocked.some(b => b.guard && b.guard.hit === "skill_whitelist"), "blocked 留痕含技能白名单拦截");
  assert(r.blocked.some(b => b.guard && b.guard.reason === "正文重复"), "重复草稿被去重拦截");
  assert(r.guard.truncatedCount >= 1 && r.guard.result === GUARD_RESULT.TRUNCATED, "含截断项时整体 guard.result=TRUNCATED");
  assert(validateCopilotResult(r).length === 0 && !r._validationErrors, "OK 态结果通过 validateCopilotResult 无错误");

  // 6b. 默认（不注入白名单）读真源卡也能出建议；greeting 路径验证模板变量填充
  //     注意：jobTitle 不能含泛词"开发/编程"（guard.js 一律拦截，宁严勿漏）
  const r2 = generateSuggestions({ jobTitle: "Qt工程师", companyName: "某某科技", pageText: "岗位详情页：招聘Qt工程师一名" });
  assert(r2.status === STATUS.OK && r2.suggestions.length >= 1, "默认路径（白名单从底细卡真源读取）可出建议");
  assert(r2.suggestions.some(s => s.text.includes("Qt工程师") && s.text.includes("某某科技")), "模板变量 {jobTitle}/{companyName} 已填充");

  // 6c. needManual / noChat 态不出建议
  const r3 = generateSuggestions({ hrMsg: "offer 已发，确认下五险一金和入职日期" });
  assert(r3.status === STATUS.NEED_MANUAL && r3.ok === false && r3.suggestions.length === 0, "needManual：不出建议，只提示人工");
  assert(typeof r3.decisionReason === "string" && r3.decisionReason.includes("人工"), `needManual 判定依据可读：${r3.decisionReason}`);
  const r4 = generateSuggestions({});
  assert(r4.status === STATUS.NO_CHAT && r4.ok === false && r4.suggestions.length === 0, "noChat：不出建议");
  assert(r4.guard.result === GUARD_RESULT.BLOCKED, `noChat guard 标记 BLOCKED：${r4.guard.result}`);

  // 6d. schemaVersion 恒在
  assert(r2.schemaVersion === SCHEMA_VERSION && r4.schemaVersion === SCHEMA_VERSION, `结果携带 schemaVersion=${SCHEMA_VERSION}`);
}

// ─────────────────────────────────────────────
console.log("");
console.log(`passed: ${passed}  failed: ${failed}`);
if (failed > 0) {
  console.error("FAILURES:\n" + failures.map(f => "  - " + f).join("\n"));
  process.exit(1);
}
