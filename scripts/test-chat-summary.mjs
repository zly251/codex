/**
 * test-chat-summary.mjs —— chatSummary.js 的自测脚本
 *
 * 全程不联网、不真调模型（callLLM 全部注入假函数），可离线秒跑：
 *   node scripts/test-chat-summary.mjs
 * 末尾打印 "N passed, M failed"，有失败则退出码 1。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  extractFacts,
  buildSummaryPrompt,
  parseSummaryJson,
  mergeSummary,
  buildSummaries,
  writeSummariesFile,
} from "../src/chatSummary.js";

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

const PHONE = "13812345678";

// ---------------------------------------------------------------------------
// 1. 面试时间 / 地点
// ---------------------------------------------------------------------------
console.log("[1] extractFacts 面试时间与地点");
{
  const facts = extractFacts({
    chatName: "某某科技-HR",
    messages: [
      { role: "hr", text: "你好，方便聊聊吗？", time: "2026-09-19 10:12" },
      { role: "me", text: "您好，方便", time: "2026-09-19 10:13" },
      { role: "hr", text: "明天下午2点面试，地址在朝阳区某某科技园3号楼", time: "2026-09-19 10:14" },
    ],
  });
  assert(facts.interview !== null, "能抽到 interview 对象");
  assert(
    facts.interview.time.includes("明天下午2点"),
    "interview.time 含『明天下午2点』，实际：" + facts.interview.time
  );
  assert(
    facts.interview.place.includes("朝阳区某某科技园3号楼"),
    "interview.place 含『朝阳区某某科技园3号楼』，实际：" + facts.interview.place
  );
  assert(facts.msgCount === 3, "msgCount 统计有效消息数 = 3，实际：" + facts.msgCount);
  assert(facts.hrAsked.length === 2, "hrAsked 取 HR 的 2 条消息，实际：" + facts.hrAsked.length);
  assert(
    facts.lastHrText.includes("明天下午2点"),
    "lastHrText 是 HR 最后一条，实际：" + facts.lastHrText
  );
}

// ---------------------------------------------------------------------------
// 2. 薪资句抽取 + 多条用 " | " 连接
// ---------------------------------------------------------------------------
console.log("[2] extractFacts 薪资句");
{
  const facts = extractFacts({
    messages: [
      { role: "hr", text: "这个岗位月薪8K" },
      { role: "me", text: "好的" },
      { role: "hr", text: "转正后底薪会调整到10K" },
    ],
  });
  assert(facts.salaryTalk.includes("月薪8K"), "薪资句含第一条『月薪8K』，实际：" + facts.salaryTalk);
  assert(facts.salaryTalk.includes("底薪会调整到10K"), "薪资句含第二条，实际：" + facts.salaryTalk);
  assert(facts.salaryTalk.includes(" | "), "多条薪资句用『 | 』连接，实际：" + facts.salaryTalk);
  assert(facts.salaryTalk.split(" | ").length === 2, "两条薪资句连接后为 2 段");
}

// ---------------------------------------------------------------------------
// 3. 手机号必须打码
// ---------------------------------------------------------------------------
console.log("[3] 隐私：手机号打码");
{
  const facts = extractFacts({
    messages: [{ role: "hr", text: `方便的话加我微信，电话也是这个${PHONE}，明天上午10点面试` }],
  });
  const dump = JSON.stringify(facts);
  assert(!dump.includes(PHONE), "输出中不得出现完整手机号 " + PHONE);
  assert(dump.includes("138****"), "输出中应出现打码形式 138****，实际：" + facts.interview?.contact);
  assert(facts.interview.contact.includes("138****5678"), "联系人句里手机号打码为 138****5678");

  const parsed = parseSummaryJson(`{"interview":{"contact":"电话${PHONE}"},"nextStep":"打${PHONE}"}`);
  const dumped = JSON.stringify(parsed);
  assert(!dumped.includes(PHONE), "parseSummaryJson 输出也不得含完整手机号");
  assert(dumped.includes("138****5678"), "parseSummaryJson 里也应打码");
}

// ---------------------------------------------------------------------------
// 4. needHuman 命中
// ---------------------------------------------------------------------------
console.log("[4] extractFacts needHuman");
{
  const facts = extractFacts({
    messages: [
      { role: "hr", text: "试用期是三个月，转正购买社保" },
      { role: "hr", text: "这个岗位是外包驻场，能接受吗" },
      { role: "hr", text: "你好呀" },
    ],
  });
  assert(facts.needHuman.length >= 2, "needHuman 至少命中 2 句，实际：" + facts.needHuman.length);
  assert(
    facts.needHuman.some((s) => s.includes("试用期")),
    "命中『试用期』句"
  );
  assert(
    facts.needHuman.some((s) => s.includes("社保")),
    "命中『社保』句"
  );
  assert(
    facts.needHuman.some((s) => s.includes("外包")),
    "命中『外包』句"
  );
  assert(
    !facts.needHuman.some((s) => s === "你好呀"),
    "普通寒暄不进 needHuman"
  );
}

// ---------------------------------------------------------------------------
// 5. parseSummaryJson 容错
// ---------------------------------------------------------------------------
console.log("[5] parseSummaryJson 容错");
{
  const fenced = parseSummaryJson(
    '好的，以下是根据聊天记录整理的结果：\n```json\n{"hrAsked":["什么时候能到岗"],"weAnswered":["下周一"],"interview":{"time":"明天下午2点","place":"朝阳区","contact":"王经理"},"salaryTalk":"8K","nextStep":"准备面试","prepare":["带简历"]}\n```\n希望有帮助！'
  );
  assert(fenced !== null, "能吃下 ```json 包裹 + 前后解释文字");
  assert(fenced.nextStep === "准备面试", "剥掉解释文字后 nextStep 正确");
  assert(fenced.interview.place === "朝阳区", "interview.place 正确");
  assert(fenced.prepare.length === 1, "prepare 数组解析正确");

  const bare = parseSummaryJson('前面废话 {"salaryTalk":"10K"} 后面废话');
  assert(bare !== null && bare.salaryTalk === "10K", "裸 JSON 混在文字里也能解析");

  assert(parseSummaryJson("对不起，我无法回答这个问题") === null, "纯垃圾文本返回 null");
  assert(parseSummaryJson("") === null, "空串返回 null");
  assert(parseSummaryJson(null) === null, "null 返回 null");
  assert(parseSummaryJson(undefined) === null, "undefined 返回 null");
  assert(parseSummaryJson(12345) === null, "非字符串返回 null");
  assert(parseSummaryJson("[1,2,3]") === null, "数组不是摘要对象，返回 null");
  assert(parseSummaryJson("{坏掉的 json") === null, "坏 JSON 返回 null 且不抛");
}

// ---------------------------------------------------------------------------
// 6. parseSummaryJson 规整缺键
// ---------------------------------------------------------------------------
console.log("[6] parseSummaryJson 缺键规整");
{
  const p = parseSummaryJson('{"salaryTalk":"8K"}');
  assert(Array.isArray(p.hrAsked) && p.hrAsked.length === 0, "缺失 hrAsked 补空数组");
  assert(Array.isArray(p.weAnswered) && p.weAnswered.length === 0, "缺失 weAnswered 补空数组");
  assert(Array.isArray(p.prepare) && p.prepare.length === 0, "缺失 prepare 补空数组");
  assert(p.nextStep === "", "缺失 nextStep 补空字符串");
  assert(
    p.interview && p.interview.time === "" && p.interview.place === "" && p.interview.contact === "",
    "缺失 interview 补三个空字符串"
  );
  assert(parseSummaryJson('{"interview":null}').interview === null, "模型明确给 null 时 interview 保持 null");

  const mixed = parseSummaryJson('{"hrAsked":[1,null,"问什么"],"prepare":{"a":1},"salaryTalk":8}');
  assert(
    mixed.hrAsked.every((x) => typeof x === "string"),
    "数组里的非字符串元素被转成字符串，实际：" + JSON.stringify(mixed.hrAsked)
  );
  assert(Array.isArray(mixed.prepare) && mixed.prepare.length === 0, "对象类型的 prepare 规整为空数组");
  assert(mixed.salaryTalk === "8", "数字类型的 salaryTalk 转成字符串");
}

// ---------------------------------------------------------------------------
// 7. mergeSummary
// ---------------------------------------------------------------------------
console.log("[7] mergeSummary");
{
  const existing = {
    updatedAt: "2020-01-01T00:00:00.000Z",
    summaries: [
      { chatName: "A公司", nextStep: "旧的 A" },
      { chatName: "B公司", nextStep: "B" },
    ],
  };
  const merged = mergeSummary(existing, { chatName: "A公司", nextStep: "新的 A" });
  assert(merged.summaries.length === 2, "同名覆盖后条数仍为 2，实际：" + merged.summaries.length);
  assert(
    merged.summaries.find((s) => s.chatName === "A公司").nextStep === "新的 A",
    "同名的 A公司 被覆盖"
  );
  assert(merged.summaries.find((s) => s.chatName === "B公司").nextStep === "B", "异名的 B公司 保留");
  assert(merged.updatedAt !== existing.updatedAt, "updatedAt 已更新");
  assert(!Number.isNaN(Date.parse(merged.updatedAt)), "updatedAt 是合法 ISO 字符串");
  assert(existing.summaries[0].nextStep === "旧的 A", "不修改传入的 existing 对象（无副作用）");

  const added = mergeSummary(existing, { chatName: "C公司", nextStep: "C" });
  assert(added.summaries.length === 3, "新会话被追加，实际：" + added.summaries.length);
  const noop = mergeSummary(existing, null);
  assert(noop.summaries.length === 2, "incoming 为 null 时保留原有摘要");
}

// ---------------------------------------------------------------------------
// 8. buildSummaries 主流程
// ---------------------------------------------------------------------------
console.log("[8] buildSummaries");
{
  const chats = [
    { chatName: "合法会话", messages: [{ role: "hr", text: "明天下午2点面试" }] },
    { chatName: "垃圾会话", messages: [{ role: "hr", text: "在吗" }] },
    { chatName: "报错会话", messages: [{ role: "hr", text: "试用期三个月" }] },
  ];

  const callLLM = async (prompt) => {
    if (prompt.includes("报错会话")) throw new Error("模拟网络中断");
    if (prompt.includes("垃圾会话")) return "抱歉，我不太明白你的意思，请再说一遍。";
    return (
      "```json\n" +
      JSON.stringify({
        hrAsked: ["能明天面试吗"],
        weAnswered: ["可以"],
        interview: { time: "明天下午2点", place: "朝阳区", contact: "王经理" },
        salaryTalk: "8K",
        nextStep: "确认面试",
        prepare: ["带简历", "查路线"],
      }) +
      "\n```"
    );
  };

  const logs = [];
  const result = await buildSummaries({
    chats,
    callLLM,
    profile: { name: "张三", skills: "C++" },
    card: "",
    log: (m) => logs.push(m),
  });

  assert(result.llmUsed === 1, "合法 JSON 让 llmUsed = 1，实际：" + result.llmUsed);
  assert(result.fallbackUsed === 2, "垃圾输出 + reject 各退回骨架，fallbackUsed = 2，实际：" + result.fallbackUsed);
  assert(result.summaries.length === 3, "三个会话都有摘要，实际：" + result.summaries.length);
  assert(result.errors.length === 2, "errors 记录 2 条失败原因，实际：" + JSON.stringify(result.errors));

  const okOne = result.summaries.find((s) => s.chatName === "合法会话");
  assert(okOne.nextStep === "确认面试", "模型结果被采用（nextStep=确认面试）");
  assert(okOne.prepare.length === 2, "模型 prepare 被保留");
  assert(logs.length === 3, "log 回调对每个会话都被调用，实际：" + logs.length);

  const badOne = result.summaries.find((s) => s.chatName === "垃圾会话");
  assert(badOne.nextStep.includes("需人工查看"), "骨架 nextStep 写『需人工查看』，实际：" + badOne.nextStep);
  assert(Array.isArray(badOne.weAnswered) && badOne.weAnswered.length === 0, "骨架 weAnswered 为空数组");
  assert(badOne.interview === null, "无面试信息的会话骨架 interview 为 null");

  const errOne = result.summaries.find((s) => s.chatName === "报错会话");
  assert(errOne !== undefined, "callLLM 抛错的会话仍然产出摘要（不影响主流程）");
  assert(errOne.nextStep.includes("需人工查看"), "抛错会话退回骨架");
  assert(
    errOne.prepare.some((p) => p.includes("试用期")),
    "骨架 prepare 从 needHuman 推出提示词，实际：" + JSON.stringify(errOne.prepare)
  );
  assert(
    result.errors.some((e) => e.includes("报错会话") && e.includes("模拟网络中断")),
    "errors 里保留了抛错会话的真实原因"
  );

  const noCallLLM = await buildSummaries({ chats: [chats[0]] });
  assert(!noCallLLM.errors.length === false, "callLLM 缺失时记入 errors");
  assert(noCallLLM.fallbackUsed === 1, "callLLM 缺失时退回骨架，不抛");
}

// ---------------------------------------------------------------------------
// 9. writeSummariesFile
// ---------------------------------------------------------------------------
console.log("[9] writeSummariesFile");
{
  const file = path.join(os.tmpdir(), `chat-summary-test-${process.pid}-${Date.now()}.json`);
  try {
    const existing = {
      updatedAt: "2020-01-01T00:00:00.000Z",
      summaries: [{ chatName: "老会话", nextStep: "旧" }],
    };
    const res = await writeSummariesFile({
      filePath: file,
      existing,
      summaries: [
        { chatName: "老会话", nextStep: "新", interview: null },
        { chatName: "新会话", nextStep: "准备面试", interview: { time: "明天", place: "", contact: `王经理${PHONE}` } },
      ],
    });
    assert(res.ok === true, "写入成功 ok=true，实际：" + JSON.stringify(res));
    assert(res.path === file, "返回的 path 与传入一致");
    assert(res.count === 2, "同名覆盖 + 新增 = 2 条，实际：" + res.count);
    assert(fs.existsSync(file), "文件确实落在磁盘上");

    const raw = fs.readFileSync(file, "utf8");
    const back = JSON.parse(raw);
    assert(back.summaries.length === 2, "读回来是 2 条摘要");
    assert(back.summaries.find((s) => s.chatName === "老会话").nextStep === "新", "同名会话被覆盖");
    assert(back.summaries.some((s) => s.chatName === "新会话"), "新会话已合并进去");
    assert(back.updatedAt !== "2020-01-01T00:00:00.000Z", "updatedAt 被刷新");
    assert(!raw.includes(PHONE), "落盘文件里不含完整手机号");
    assert(raw.includes("138****"), "落盘文件里手机号已打码");

    const fail = await writeSummariesFile({
      filePath: path.join(os.tmpdir(), "不存在的目录-xyz", "a.json"),
      summaries: [{ chatName: "x" }],
    });
    assert(fail.ok === false && typeof fail.error === "string", "写失败返回 ok=false + error，且不抛");
  } finally {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // 清理失败不影响断言结果
    }
  }
  assert(!fs.existsSync(file), "测试结束已删除临时文件");
}

// ---------------------------------------------------------------------------
// 10. 畸形输入
// ---------------------------------------------------------------------------
console.log("[10] 畸形输入不抛异常");
{
  const badInputs = [null, undefined, "字符串", 123, [], true];

  let threw = "";
  for (const bad of badInputs) {
    try {
      extractFacts(bad);
      buildSummaryPrompt(bad);
      parseSummaryJson(bad);
      mergeSummary(bad, bad);
      await buildSummaries(bad);
      await writeSummariesFile(bad);
    } catch (err) {
      threw = `${JSON.stringify(bad)} -> ${err.message}`;
    }
  }
  assert(threw === "", "所有导出函数对 null/字符串/数字/布尔输入都不抛，实际：" + (threw || "未抛"));

  let threw2 = "";
  try {
    const facts = extractFacts({ chatName: null, messages: "不是数组" });
    assert(facts.msgCount === 0, "messages 非数组时 msgCount = 0");
    assert(facts.interview === null && facts.salaryTalk === "", "messages 非数组时其余字段为空值");
    assert(JSON.stringify(facts.hrAsked) === "[]", "messages 非数组时 hrAsked 为空数组");

    const messy = extractFacts({
      messages: [null, 1, "字符串", { text: 5 }, { role: "hr" }, { role: "hr", text: "   " }, { role: "hr", text: "有效消息" }],
    });
    assert(messy.msgCount === 1, "只有一条元素有字符串 text，msgCount = 1，实际：" + messy.msgCount);
    assert(messy.lastHrText === "有效消息", "空 text / 非字符串 text 被安全跳过");

    const emptyMessages = extractFacts({ messages: [] });
    assert(emptyMessages.msgCount === 0 && emptyMessages.interview === null, "空数组返回空事实");

    const prompt = buildSummaryPrompt({ chatName: null, messages: null, profile: null, card: "" });
    assert(typeof prompt === "string" && prompt.includes("只输出"), "空数据也能拼出提示词字符串");
    assert(prompt.includes("salaryTalk"), "提示词里写明了固定 JSON 键");

    const prompt2 = buildSummaryPrompt({
      chatName: "X",
      messages: [{ role: "hr", text: `电话${PHONE}` }],
      profile: { name: "张三" },
      card: "底细卡内容",
    });
    assert(!prompt2.includes(PHONE), "提示词里也不出现完整手机号（不把原始手机号喂给模型）");

    const m = mergeSummary({ summaries: "不是数组" }, { chatName: "A" });
    assert(m.summaries.length === 1, "existing.summaries 非数组时按空处理");

    const r = await buildSummaries({ chats: null, callLLM: async () => "" });
    assert(r.summaries.length === 0 && r.errors.length === 1, "chats 非数组时返回空结果 + 错误说明");

    const w = await writeSummariesFile({ filePath: "", summaries: null });
    assert(w.ok === false && typeof w.error === "string", "filePath 为空时返回 ok=false");
  } catch (err) {
    threw2 = err.message;
  }
  assert(threw2 === "", "畸形字段组合也不抛，实际：" + (threw2 || "未抛"));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
