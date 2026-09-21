// 巡航调度器自检：node scripts/test-autopilot.mjs
// 全程注入假 deps —— 不开浏览器、不连数据库、不发任何网络请求（这台机器内存紧张，跑不起真浏览器）。
// 假 sleep 用 setImmediate 让出事件循环：既不会真的等 10 分钟，也不会让循环变成占满微任务队列的死循环。
import assert from "node:assert/strict";
import { createAutopilot } from "../src/autopilot.js";

let passed = 0;
let failed = 0;

async function t(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log("  ✓ " + label);
  } catch (e) {
    failed += 1;
    console.error("  ✗ " + label);
    console.error("      " + (e && e.message ? e.message : String(e)));
  }
}

// 造一套假依赖：默认全部成功，over 里可以换掉任意一个（含抛错版）。
// calls / order 用来验证「某动作到底被调过几次、按什么顺序调」—— 这是本文件最关键的证据。
function makeDeps(over = {}) {
  const calls = {
    connectBrowser: 0,
    checkLogin: 0,
    replenish: 0,
    syncFeedback: 0,
    replyDueChats: 0,
    autoApprove: 0,
    applyQueue: 0,
    writeSummaries: 0,
  };
  const order = [];
  const deps = {
    isBrowserConnected: () => true,
    connectBrowser: async () => ({ ok: true }),
    checkLogin: async () => true,
    // 补库存 / 自动放行默认成功且有产出，好让"注入了就会跑"在正常轮里可观测。
    replenish: async () => ({ searched: 3, enriched: 2 }),
    syncFeedback: async () => ({ replied: 2 }),
    replyDueChats: async () => ({ replied: 1, pending: 3 }),
    autoApprove: async () => ({ approved: 1 }),
    applyQueue: async () => ({ sent: 5, remaining: 4 }),
    writeSummaries: async () => ({ written: 2 }),
    log: () => {}, // 自检不想刷屏，静默
    sleep: async () => {
      await new Promise((r) => setImmediate(r));
    },
  };
  Object.assign(deps, over);
  for (const k of Object.keys(calls)) {
    const fn = deps[k];
    deps[k] = async (...a) => {
      calls[k] += 1;
      order.push(k);
      return await fn(...a);
    };
  }
  return { deps, calls, order };
}

console.log("autopilot 自检开始\n");

// —— 1. 正常一轮：全成功 → working，stats 累加正确 ——
await t("正常一轮返回 working，且 stats 累加正确", async () => {
  const { deps, calls, order } = makeDeps();
  const ap = createAutopilot(deps);
  const s0 = ap.status();
  assert.equal(s0.intervalMs, 10 * 60 * 1000, "默认正常间隔应为 10 分钟");
  assert.equal(s0.idleIntervalMs, 30 * 60 * 1000, "默认空闲间隔应为 30 分钟");

  const r1 = await ap.tick();
  assert.equal(r1.phase, "working", "全成功且有剩余任务时 phase 应为 working");
  assert.equal(r1.round, 1, "首轮 round 应为 1");
  assert.equal(r1.replied, 1, "replied 应取 replyDueChats 的 replied");
  assert.equal(r1.sent, 5, "sent 应取 applyQueue 的 sent");
  assert.equal(r1.remaining, 4, "remaining 应取 applyQueue 的 remaining");
  assert.equal(r1.pending, 3, "pending 应取 replyDueChats 的 pending");
  assert.equal(r1.summaries, 2, "summaries 应取 writeSummaries 的 written");
  assert.equal(r1.replenished, 5, "replenished 应取 replenish 的 searched+enriched（3+2）");
  assert.equal(r1.autoApproved, 1, "autoApproved 应取 autoApprove 的 approved");
  assert.ok(typeof r1.ms === "number" && r1.ms >= 0, "ms 应为非负数字");

  const st1 = ap.status().stats;
  assert.equal(st1.rounds, 1, "stats.rounds 应累加到 1");
  assert.equal(st1.replied, 1, "stats.replied 应累加到 1");
  assert.equal(st1.sent, 5, "stats.sent 应累加到 5");
  assert.equal(st1.summaries, 2, "stats.summaries 应累加到 2");
  assert.equal(st1.replenished, 5, "stats.replenished 应累加到 5");
  assert.equal(st1.autoApproved, 1, "stats.autoApproved 应累加到 1");
  assert.equal(st1.errors, 0, "全成功时 stats.errors 应为 0");

  assert.deepEqual(
    order,
    ["checkLogin", "replenish", "syncFeedback", "replyDueChats", "autoApprove", "applyQueue", "writeSummaries"],
    "动作顺序应为 登录检查 → 补库存 → 同步反馈 → 回消息 → 自动放行 → 发招呼 → 写摘要"
  );

  // 第二轮继续累加（队列还有剩余，所以 applyQueue 会再跑一次）
  await ap.tick();
  const st2 = ap.status().stats;
  assert.equal(st2.rounds, 2, "stats.rounds 第二轮应累加到 2");
  assert.equal(st2.sent, 10, "stats.sent 两轮应累加到 10");
  assert.equal(st2.replied, 2, "stats.replied 两轮应累加到 2");
  assert.equal(st2.summaries, 4, "stats.summaries 两轮应累加到 4");
  assert.equal(st2.replenished, 10, "stats.replenished 两轮应累加到 10");
  assert.equal(st2.autoApproved, 2, "stats.autoApproved 两轮应累加到 2");
  assert.equal(calls.applyQueue, 2, "队列仍有剩余时每轮都应调用 applyQueue");
});

// —— 2. 未登录：只探测登录，别的动作一次都不许碰 ——
await t("未登录返回 need_login，且不触发任何投递动作", async () => {
  const { deps, calls } = makeDeps({ checkLogin: async () => false });
  const ap = createAutopilot(deps);

  const r1 = await ap.tick();
  assert.equal(r1.phase, "need_login", "未登录时 phase 应为 need_login");
  assert.equal(ap.status().needLogin, true, "未登录后 status().needLogin 应为 true");
  assert.equal(calls.applyQueue, 0, "未登录时 applyQueue 一次都不该被调用");
  assert.equal(calls.syncFeedback, 0, "未登录时 syncFeedback 一次都不该被调用");
  assert.equal(calls.replyDueChats, 0, "未登录时 replyDueChats 一次都不该被调用");
  assert.ok(
    ap.status().logs.some((l) => l.msg.includes("请扫码登录")),
    "未登录时应留下含「请扫码登录」的醒目日志"
  );

  // needLogin 已置位后再 tick：仍然只探测，且不重置 needLogin
  const r2 = await ap.tick();
  assert.equal(r2.phase, "need_login", "needLogin 保持时仍应是 need_login");
  assert.equal(r2.skipped, true, "needLogin 保持时本轮应标记 skipped");
  assert.equal(ap.status().needLogin, true, "探测失败时不得重置 needLogin");
  assert.equal(calls.applyQueue, 0, "needLogin 空转轮仍不得调用 applyQueue");
  assert.equal(calls.connectBrowser, 0, "needLogin 空转轮不该去连浏览器");
});

// —— 3. 登录恢复：needLogin 后改回已登录，应恢复巡航 ——
await t("登录恢复后从 need_login 回到 working", async () => {
  let logged = false;
  const { deps, calls } = makeDeps({ checkLogin: async () => logged });
  const ap = createAutopilot(deps);

  await ap.tick();
  assert.equal(ap.status().needLogin, true, "先进入需要登录状态");

  logged = true;
  const r = await ap.tick();
  assert.equal(r.phase, "working", "登录恢复后 phase 应恢复为 working");
  assert.equal(ap.status().needLogin, false, "登录恢复后 needLogin 应被清掉");
  assert.equal(calls.syncFeedback, 1, "恢复后应执行 syncFeedback");
  assert.equal(calls.replyDueChats, 1, "恢复后应执行 replyDueChats");
  assert.equal(calls.applyQueue, 1, "恢复后应执行 applyQueue");
  assert.equal(calls.writeSummaries, 1, "恢复后应执行 writeSummaries");
});

// —— 4. 浏览器连不上：记 lastError，且不抛异常 ——
await t("connectBrowser 失败返回 browser_error 且不抛异常", async () => {
  const { deps, calls } = makeDeps({
    isBrowserConnected: () => false,
    connectBrowser: async () => {
      throw new Error("CDP 端口没起来");
    },
  });
  const ap = createAutopilot(deps);

  let r = null;
  try {
    r = await ap.tick(); // 能走到下一行本身就是「不抛异常」的证据
  } catch (e) {
    assert.fail("tick() 不该抛异常，却抛了：" + e.message);
  }
  assert.equal(r.phase, "browser_error", "浏览器连不上时 phase 应为 browser_error");
  assert.ok(ap.status().lastError, "浏览器连不上时 lastError 应有值");
  assert.ok(
    ap.status().lastError.includes("CDP 端口没起来"),
    "lastError 应带上原始错误信息，便于排查"
  );
  assert.equal(calls.connectBrowser, 1, "浏览器没连时应尝试连接一次");
  assert.equal(calls.syncFeedback, 0, "浏览器连不上时不该继续跑后续动作");
});

// —— 5. 单步失败不阻断：syncFeedback 抛错，后面照样跑 ——
await t("某一步失败不阻断后续步骤，errors 计数 +1", async () => {
  const { deps, calls } = makeDeps({
    syncFeedback: async () => {
      throw new Error("页面选择器失效");
    },
  });
  const ap = createAutopilot(deps);

  const r = await ap.tick();
  assert.equal(r.phase, "working", "单步失败时本轮仍应算 working");
  assert.equal(calls.applyQueue, 1, "syncFeedback 抛错后 applyQueue 仍应被调用");
  assert.equal(calls.writeSummaries, 1, "syncFeedback 抛错后 writeSummaries 仍应被调用");
  assert.equal(ap.status().stats.errors, 1, "一次步骤失败应让 stats.errors +1");
  assert.ok(
    ap.status().lastError.includes("syncFeedback"),
    "lastError 应标明是哪一步失败的"
  );
  assert.equal(r.errors.length, 1, "本轮结果里应能看到 1 条步骤错误");
});

// —— 6. 空闲判定：remaining=0 且 pending=0 → idle ——
await t("队列与待回消息都排空后进入 idle", async () => {
  const { deps, calls } = makeDeps({
    replyDueChats: async () => ({ replied: 0, pending: 0 }),
    applyQueue: async () => ({ sent: 3, remaining: 0 }),
  });
  const ap = createAutopilot(deps);

  const r1 = await ap.tick();
  assert.equal(r1.phase, "idle", "remaining=0 且 pending=0 时 phase 应为 idle");
  assert.equal(ap.status().phase, "idle", "status().phase 也应为 idle");

  const r2 = await ap.tick(); // 空闲不是退出，还要继续低频巡检
  assert.equal(r2.phase, "idle", "空闲后下一轮仍是 idle（不许退出循环）");
  assert.equal(calls.replyDueChats, 2, "空闲轮仍应执行 replyDueChats");
  assert.equal(calls.syncFeedback, 2, "空闲轮仍应执行 syncFeedback");
  // 2026-09-19 修改：空闲轮也要探一次队列。原因见 autopilot.js 4.3 的注释——
  // "排空后不再调用"会导致用户中途新搜到的岗位永远发不出去（与"一直跑到完成"冲突）。
  // 宿主适配器在无可发时是廉价空操作，所以每轮探一次是安全的。
  assert.equal(calls.applyQueue, 2, "空闲轮也要探一次队列（新入队岗位必须还能被发出去）");
  assert.equal(ap.status().stats.rounds, 2, "空闲轮也要计入 stats.rounds");

  // 反向验证：只要有待回消息就不算空闲
  const other = makeDeps({ replyDueChats: async () => ({ replied: 0, pending: 1 }) });
  const ap2 = createAutopilot(other.deps);
  const r3 = await ap2.tick();
  assert.equal(r3.phase, "working", "pending>0 时不应判定为空闲");
});

// —— 7. start 重入保护 / stop 语义 ——
await t("start 重入保护与 stop 后不再执行任何一轮", async () => {
  const { deps } = makeDeps();
  const ap = createAutopilot(deps);

  const r1 = ap.start({ intervalMs: 10, idleIntervalMs: 10, maxRounds: 5 });
  assert.equal(r1.started, true, "首次 start 应返回 started:true");
  assert.equal(ap.status().running, true, "start 后 running 应为 true");
  assert.equal(ap.status().intervalMs, 10, "start(opts) 应生效自定义 intervalMs");
  assert.equal(ap.status().idleIntervalMs, 10, "start(opts) 应生效自定义 idleIntervalMs");

  const r2 = ap.start();
  assert.equal(r2.started, false, "重复 start 应返回 started:false");
  assert.equal(r2.reason, "already_running", "重复 start 的 reason 应为 already_running");

  const s = ap.stop();
  assert.equal(s.stopped, true, "stop 应返回 stopped:true");
  assert.equal(ap.status().running, false, "stop 后 running 应为 false");
  assert.ok(ap.status().stoppedAt > 0, "stop 后应记录 stoppedAt");
  assert.equal(ap.stop().stopped, false, "重复 stop 应返回 stopped:false");

  // 关键：stop() 之后必须有「真的不再跑」的行为证据，不能只看标志位
  const roundAtStop = ap.status().round;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(
    ap.status().round,
    roundAtStop,
    "stop() 之后不得再执行任何一轮（round 不许再增长）"
  );

  // 到 maxRounds 自动停
  const ap3 = createAutopilot(makeDeps().deps);
  ap3.start({ intervalMs: 5, maxRounds: 2 });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(ap3.status().running, false, "达到 maxRounds 后应自动 stop");
  assert.ok(ap3.status().round <= 3, "达到 maxRounds 后不应继续跑轮次");
});

// —— 7.5 单轮重入保护：上一轮还没跑完时再次 tick 必须被挡住 ——
await t("上一轮没跑完时再次 tick 不会重入", async () => {
  let release = () => {};
  const gate = new Promise((r) => {
    release = r;
  });
  const { deps, calls } = makeDeps({
    syncFeedback: async () => {
      await gate;
      return { replied: 0 };
    },
  });
  const ap = createAutopilot(deps);

  const first = ap.tick(); // 故意不 await：让它卡在 syncFeedback 上
  const second = await ap.tick();
  assert.equal(second.skipped, true, "上一轮未结束时再次 tick 应被挡下");
  assert.equal(second.reason, "round_in_progress", "被挡下的 reason 应为 round_in_progress");

  release();
  const r1 = await first;
  assert.equal(r1.phase, "working", "被挡下的那次不该影响正常这轮的结果");
  assert.equal(calls.syncFeedback, 1, "重入被挡时 syncFeedback 只应执行一次");
});

// —— 8. status() 返回副本 ——
await t("status() 返回的是副本，改返回值不影响下一次状态", async () => {
  const { deps } = makeDeps();
  const ap = createAutopilot(deps);
  await ap.tick();

  const before = ap.status();
  assert.ok(before.logs.length > 0, "跑过一轮后应至少有 1 条日志");

  const mutated = ap.status();
  mutated.running = true;
  mutated.phase = "hacked";
  mutated.needLogin = true;
  mutated.stats.rounds = 999;
  mutated.logs.push({ t: 0, msg: "外来日志" });
  mutated.logs[0].msg = "被改掉的日志";

  const after = ap.status();
  assert.equal(after.running, false, "改返回值里的 running 不应影响内部状态");
  assert.equal(after.phase, before.phase, "改返回值里的 phase 不应影响内部状态");
  assert.equal(after.needLogin, false, "改返回值里的 needLogin 不应影响内部状态");
  assert.equal(after.stats.rounds, 1, "改返回值里的 stats 不应影响内部累加");
  assert.equal(after.logs.length, before.logs.length, "往返回值 logs 里 push 不应污染内部日志");
  assert.equal(after.logs[0].msg, before.logs[0].msg, "改返回值 logs 里的条目不应污染内部日志");
  assert.notEqual(after.stats, mutated.stats, "两次 status() 的 stats 应是不同对象");
});

// —— 9. 存在性守卫：不注入 replenish/autoApprove 时，管线与"新增该两步之前"逐字节一致 ——
await t("未注入 replenish/autoApprove 时保持原管线（向后兼容）", async () => {
  const order = [];
  const deps = {
    isBrowserConnected: () => true,
    connectBrowser: async () => ({ ok: true }),
    checkLogin: async () => { order.push("checkLogin"); return true; },
    syncFeedback: async () => { order.push("syncFeedback"); return { replied: 0 }; },
    replyDueChats: async () => { order.push("replyDueChats"); return { replied: 0, pending: 0 }; },
    applyQueue: async () => { order.push("applyQueue"); return { sent: 0, remaining: 0 }; },
    writeSummaries: async () => { order.push("writeSummaries"); return { written: 0 }; },
    log: () => {},
    sleep: async () => { await new Promise((r) => setImmediate(r)); },
    // 注意：故意不提供 replenish / autoApprove。
  };
  const ap = createAutopilot(deps);
  const r = await ap.tick();
  assert.equal(
    order.join(","),
    "checkLogin,syncFeedback,replyDueChats,applyQueue,writeSummaries",
    "未注入两步时不得出现 replenish/autoApprove"
  );
  assert.equal(r.replenished, 0, "未注入时本轮 replenished 应为 0");
  assert.equal(r.autoApproved, 0, "未注入时本轮 autoApproved 应为 0");
  assert.equal(ap.status().stats.replenished, 0, "未注入时 stats.replenished 应恒为 0");
  assert.equal(r.phase, "idle", "队列与待回都排空仍应 idle（两步缺席不影响空闲判定）");
});

// —— 10. 补库存/自动放行抛错不阻断后续，且各自计入 errors ——
await t("replenish/autoApprove 抛错不阻断后续步骤，errors 各 +1", async () => {
  const { deps, calls } = makeDeps({
    replenish: async () => { throw new Error("搜索被风控掐断"); },
    autoApprove: async () => { throw new Error("放行闸门读库失败"); },
  });
  const ap = createAutopilot(deps);
  const r = await ap.tick();
  assert.equal(r.phase, "working", "两步失败时本轮仍应算 working");
  assert.equal(calls.syncFeedback, 1, "replenish 抛错后 syncFeedback 仍应被调用");
  assert.equal(calls.applyQueue, 1, "autoApprove 抛错后 applyQueue 仍应被调用");
  assert.equal(calls.writeSummaries, 1, "autoApprove 抛错后 writeSummaries 仍应被调用");
  assert.ok(ap.status().stats.errors >= 2, "两次步骤失败应让 stats.errors 至少 +2");
  assert.ok(r.errors.some((m) => m.includes("replenish")), "errors 应含 replenish 的失败信息");
  assert.ok(r.errors.some((m) => m.includes("autoApprove")), "errors 应含 autoApprove 的失败信息");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
