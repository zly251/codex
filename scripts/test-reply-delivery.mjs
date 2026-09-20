// 回复送达真实性自检：node scripts/test-reply-delivery.mjs
// 背景：2026-09-19 夜间巡航"报告回复 3 条、实际只送达 1 条"。根因是 sendReply
// 不等待聊天页就绪就打字（空壳页面 → 未找到输入框/打进错误会话），且 ok:false 时
// 仍打"已回复 …"日志、轮次汇总只报 replied 不报 failed —— 报告数与送达数从此背离。
// 本文件用假 page 对象验证三件事（任一回归都会让 npm test 失败）：
//   A. 聊天页未就绪 → 返回 chat_not_ready，绝不打字；
//   B. 会话行未选中（含名字兜底失败）→ 返回 row_not_selected，绝不盲发；
//   C. 发送未确认 → 日志写"发送未确认"，绝不写"已回复"；
//   D. monitorChat 的 once 统计含 failed，未送达的会话不被标已回复（下轮会重试）；
//   E. autopilot 轮次汇总把 failed 单列，failed>0 时不得转入低频空闲。
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

// 必须在 import chatState/chatApply 前设置（路径在模块顶层求值）
const tmpState = path.join(os.tmpdir(), `job-agent-reply-state-${process.pid}-${Date.now()}.json`);
process.env.JOB_AGENT_CHAT_STATE_PATH = tmpState;
const tmpDb = path.join(os.tmpdir(), `job-agent-reply-${process.pid}-${Date.now()}.db`);
process.env.JOB_AGENT_DB_PATH = tmpDb;

const { initDb } = await import("../src/db/index.js");
initDb();
const { AutoApplyBot } = await import("../src/chatApply.js");
const chatState = await import("../src/chatState.js");
const liveLog = await import("../src/log.js");
const { createAutopilot } = await import("../src/autopilot.js");

let passed = 0;
let failed = 0;
function assertEq(actual, expected, msg) {
  try {
    assert.equal(actual, expected);
    passed++;
    console.log("  ✓ " + msg);
  } catch (e) {
    failed++;
    console.error("  ✗ " + msg);
    console.error("      期望=" + JSON.stringify(expected) + " 实际=" + JSON.stringify(actual));
  }
}

// ── 假 page：evaluate 在 Node 里执行页面函数，document 用假 DOM ──
// doc 可配置：areaText（聊天区文本）、inputValue（输入框残留值）、rows（会话列表行）
function makeFakePage(doc = {}) {
  const state = {
    areaText: doc.areaText ?? "早，还在招人吗？",
    inputValue: doc.inputValue ?? "",
    rows: doc.rows ?? [],
  };
  const fakeDoc = {
    body: { innerText: state.areaText },
    querySelector(sel) {
      const s = String(sel);
      if (s.includes("[contenteditable]") || s.includes("textarea") || s.includes("[class*='input']")) {
        return {
          value: state.inputValue,
          isContentEditable: false,
          innerText: "",
          type: "text",
          className: "",
          getAttribute: () => null,
          getClientRects: () => [{}],
        };
      }
      if (s.includes("chat-record") || s.includes("chat-message")) {
        return { innerText: state.areaText, getClientRects: () => [{}] };
      }
      return null;
    },
    querySelectorAll() {
      return state.rows; // 名字兜底：有匹配行则选中
    },
  };
  return {
    async evaluate(fn, ...args) {
      const prev = global.document;
      global.document = fakeDoc;
      try {
        return await fn(...args);
      } catch (e) {
        return null;
      } finally {
        if (prev === undefined) delete global.document;
        else global.document = prev;
      }
    },
    url: () => "https://www.zhipin.com/web/geek/chat",
    keyboard: { press: async () => {} },
    reload: async () => {},
  };
}

console.log("回复送达真实性自检开始\n");

// ─────────────────────────────
console.log("[A. 聊天页未就绪 → chat_not_ready，绝不打字]");
{
  liveLog.clear();
  const bot = new AutoApplyBot({});
  bot.page = makeFakePage();
  bot._navigateToChat = async () => {};
  bot._waitForChatReadyOrReload = async () => false; // ← 新闸门：空壳页面判不就绪
  let selectCalls = 0;
  let typed = 0;
  bot._selectChatRow = async () => { selectCalls++; return true; };
  bot._humanType = async () => { typed++; return true; };
  const r = await bot.sendReply("测试HR", "您好，方便聊聊吗", { name: "测试HR", company: "测试公司", msg: "在吗" }, {});
  assertEq(r.ok, false, "未就绪时 ok 应为 false");
  assertEq(r.reason, "chat_not_ready", "未就绪时 reason 应为 chat_not_ready");
  assertEq(selectCalls, 0, "未就绪时不应尝试选会话行");
  assertEq(typed, 0, "未就绪时绝不打字");
  const logs = liveLog.list(5).map((e) => e.msg);
  assert(logs.some((m) => m.includes("聊天页未就绪")), "应记录『聊天页未就绪』日志");
  passed++;
  console.log("  ✓ 应记录『聊天页未就绪』日志");
}

// ─────────────────────────────
console.log("\n[B. 会话行未选中 → row_not_selected，绝不盲发]");
{
  liveLog.clear();
  const bot = new AutoApplyBot({});
  bot.page = makeFakePage({ rows: [] }); // 名字兜底也找不到
  bot._navigateToChat = async () => {};
  bot._waitForChatReadyOrReload = async () => true;
  bot._selectChatRow = async () => false; // 行选择失败
  let typed = 0;
  bot._humanType = async () => { typed++; return true; };
  const r = await bot.sendReply("测试HR", "您好", { name: "测试HR", company: "测试公司", msg: "在吗" }, {});
  assertEq(r.ok, false, "未选中时 ok 应为 false");
  assertEq(r.reason, "row_not_selected", "未选中时 reason 应为 row_not_selected");
  assertEq(typed, 0, "未选中时绝不盲发");
  const logs = liveLog.list(5).map((e) => e.msg);
  assert(logs.some((m) => m.includes("未能定位会话")), "应记录『未能定位会话』日志");
  passed++;
  console.log("  ✓ 应记录『未能定位会话』日志");
}

// ─────────────────────────────
console.log("\n[C. 手动回复（只有 hrName）：名字兜底命中后照常发送]");
{
  liveLog.clear();
  const bot = new AutoApplyBot({});
  bot.page = makeFakePage({
    rows: [{ textContent: "测试HR", offsetParent: {}, click() {} }],
    areaText: "早，" + "您好，方便聊聊吗".slice(0, 30), // 复核要求回复文本出现在聊天区
  });
  bot._navigateToChat = async () => {};
  bot._waitForChatReadyOrReload = async () => true;
  bot._humanType = async () => true;
  bot._clickSendButton = async () => true;
  bot._humanWait = async () => {};
  const r = await bot.sendReply("测试HR", "您好，方便聊聊吗", null, {}); // chat=null，只有名字
  assertEq(r.ok, true, "名字兜底命中时应发送成功");
  assertEq(r.reason, "sent", "发送成功时 reason 应为 sent");
  const logs = liveLog.list(5).map((e) => e.msg);
  assert(logs.some((m) => m.includes("已回复") && m.includes("确认发送")), "确认送达时日志写『已回复…确认发送』");
  passed++;
  console.log("  ✓ 确认送达时日志写『已回复…确认发送』");
}

// ─────────────────────────────
console.log("\n[D. 发送未确认 → 日志绝不写『已回复』，返回 unverified]");
{
  liveLog.clear();
  const bot = new AutoApplyBot({});
  bot.page = makeFakePage({
    rows: [{ textContent: "测试HR", offsetParent: {}, click() {} }],
    inputValue: "残留文字", // 输入框没清空 → 复核不通过 → 未确认
  });
  bot._navigateToChat = async () => {};
  bot._waitForChatReadyOrReload = async () => true;
  bot._humanType = async () => true;
  bot._clickSendButton = async () => true;
  bot._humanWait = async () => {};
  const r = await bot.sendReply("测试HR", "您好，方便聊聊吗", null, {});
  assertEq(r.ok, false, "未确认时 ok 应为 false");
  assertEq(r.reason, "unverified", "未确认时 reason 应为 unverified");
  const logs = liveLog.list(5).map((e) => e.msg);
  assert(logs.some((m) => m.includes("发送未确认")), "日志应写『发送未确认』");
  assert(!logs.some((m) => m.startsWith("已回复")), "未确认时日志不得以『已回复』开头");
  passed++;
  console.log("  ✓ 未确认时日志不得以『已回复』开头");
}

// ─────────────────────────────
console.log("\n[E. monitorChat once 统计含 failed，未送达不标已回复]");
{
  liveLog.clear();
  const bot = new AutoApplyBot({});
  bot.running = true;
  bot.generation = 42;
  bot.page = makeFakePage();
  bot._getPage = async () => {};
  bot._scanChatSessions = async () => [
    { name: "已送达HR", company: "公司A", msg: "在吗", hrLast: true, unread: true },
    { name: "未送达HR", company: "公司B", msg: "还在招吗", hrLast: true, unread: true },
    { name: "需人工HR", company: "公司C", msg: "方便来面试吗", hrLast: true, unread: true },
  ];
  bot.syncFeedback = async () => {};
  bot._findApplicationForChat = async () => null;
  bot._findResumeForChat = async () => null;
  const onMsg = async (c) => {
    if (c.name === "已送达HR") return { ok: true, reason: "sent", reply: "好的" };
    if (c.name === "未送达HR") return { ok: false, reason: "unverified", reply: "好的" };
    if (c.name === "需人工HR") return { ok: false, reason: "offer 需要人工", needManual: true };
    return { ok: false, reason: "no_handler" };
  };
  const stats = await bot.monitorChat(onMsg, 30000, {
    once: true,
    autoReply: true,
    sendResume: false,
    sendResumeScreenshot: false,
  });
  assertEq(stats.scanned, 3, "扫描 3 个会话");
  assertEq(stats.replied, 1, "只有确认送达的 1 条计入 replied");
  assertEq(stats.failed, 1, "未确认的 1 条计入 failed");
  assertEq(stats.manual, 1, "需人工的 1 条计入 manual");
  assertEq(stats.resumeSent, 0, "未启用简历自动发送时 resumeSent=0");

  const delivered = chatState.shouldReply({ name: "已送达HR", company: "公司A", msg: "在吗" });
  assertEq(delivered, false, "确认送达的会话被标已回复，不应再回");
  const undelivered = chatState.shouldReply({ name: "未送达HR", company: "公司B", msg: "还在招吗" });
  assertEq(undelivered, true, "未送达的会话不标已回复，下一轮应重试");
  const manualChat = chatState.shouldReply({ name: "需人工HR", company: "公司C", msg: "方便来面试吗" });
  assertEq(manualChat, false, "需人工的会话被标记人工待办，不再自动回");
}

// ─────────────────────────────
console.log("\n[F. autopilot 轮次汇总单列 failed，failed>0 不转空闲]");
{
  // 复刻 test-autopilot 的假依赖：replyDueChats 报告 1 条未送达
  const deps = {
    isBrowserConnected: () => true,
    connectBrowser: async () => ({ ok: true }),
    checkLogin: async () => true,
    syncFeedback: async () => ({ replied: 0 }),
    replyDueChats: async () => ({ replied: 0, failed: 1, pending: 0 }),
    applyQueue: async () => ({ sent: 0, remaining: 0 }),
    writeSummaries: async () => ({ written: 0 }),
    log: (m) => logs.push(m),
    sleep: async () => {},
  };
  const logs = [];
  const ap = createAutopilot(deps);
  const r = await ap.tick();
  assertEq(r.phase, "working", "有未送达时 phase 应为 working（不能转低频空闲）");
  assertEq(r.failed, 1, "轮次结果应带 failed=1");
  assert(logs.some((m) => m.includes("未送达 1 条")), "轮次日志应写『未送达 1 条』");
  passed++;
  console.log("  ✓ 轮次日志应写『未送达 1 条』");

  // 对照：无未送达且队列排空 → 转空闲
  const deps2 = {
    isBrowserConnected: () => true,
    connectBrowser: async () => ({ ok: true }),
    checkLogin: async () => true,
    syncFeedback: async () => ({ replied: 0 }),
    replyDueChats: async () => ({ replied: 0, failed: 0, pending: 0 }),
    applyQueue: async () => ({ sent: 0, remaining: 0 }),
    writeSummaries: async () => ({ written: 0 }),
    log: () => {},
    sleep: async () => {},
  };
  const ap2 = createAutopilot(deps2);
  const r2 = await ap2.tick();
  assertEq(r2.phase, "idle", "无未送达且排空时 phase 应为 idle");
}

console.log(`\n回复送达真实性自检: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`失败项见上方 ✗（共 ${failed} 项）`);
  process.exit(1);
}
