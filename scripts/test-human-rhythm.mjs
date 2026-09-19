// 人味节奏闸门自检：不需要浏览器，用假 page 对象验证"每次交互之间确实按人的节奏停顿"
import assert from "node:assert";
import {
  delayRange,
  nextDelay,
  isActionSource,
  withHumanRhythm,
} from "../src/humanRhythm.js";

let passed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { passed++; console.log("  ✓ " + msg); }
  else { failures.push(msg); console.error("  ✗ " + msg); }
}

// ─────────────────────────────────────────────
console.log("\n[A. 间隔区间]");
{
  const [amin, amax] = delayRange("action");
  const [rmin, rmax] = delayRange("read");
  ok(amin >= 500 && amax <= 7000, `动作间隔落在合理区间 ${amin}~${amax}ms（点击要有几百毫秒以上犹豫）`);
  ok(rmin < amin, "只读扫描的间隔明显短于动作（否则一轮扫描会慢到不可用）");

  // 固定 rng=0.5 → 落在区间中值；验证 cap 生效
  const mid = nextDelay("action", () => 0.5);
  ok(mid >= amin && mid <= amax, `nextDelay(action) 落在区间内（${mid}）`);
  ok(nextDelay("read", () => 0.5) <= 900, "只读间隔有上限（不拖慢扫描）");

  // 10% 长停顿：rng 序列 [0.5(取值), 0.05(<0.1 触发长停顿), 0.5(倍数)]
  const seq = [0.5, 0.05, 0.5];
  let i = 0;
  const longMs = nextDelay("action", () => seq[Math.min(i++, seq.length - 1)]);
  ok(longMs > mid, `偶发长停顿比常规间隔长（${longMs} > ${mid}）——真人会分心，恒定节奏最像脚本`);
  ok(longMs <= 6500, "长停顿也有上限，不会卡死巡航");
}

// ─────────────────────────────────────────────
console.log("\n[B. 识别页面内的点击/提交]");
{
  ok(isActionSource("() => { document.querySelector('.btn').click(); }"), "识别页面内 el.click()");
  ok(isActionSource("() => { el.dispatchEvent(new MouseEvent('click')); }"), "识别 dispatchEvent");
  ok(isActionSource("() => { form.requestSubmit(); }"), "识别表单提交");
  ok(!isActionSource("() => document.body.innerText"), "只读取文本不算动作");
  ok(!isActionSource("() => { return document.querySelectorAll('.x').length; }"), "只读计数不算动作");
  ok(!isActionSource(null), "空输入安全");
}

// ─────────────────────────────────────────────
console.log("\n[C. 代理生效：动作/只读/键盘/导航都被加上间隔]");
{
  const waits = [];
  const fake = {
    async click() { return "clicked"; },
    async type() { return "typed"; },
    async evaluate(fn) { return typeof fn === "function" ? fn() : fn; },
    async goto() { return "gone"; },
    keyboard: { async press() { return "pressed"; }, async type() { return "ktyped"; } },
  };
  const wrapped = withHumanRhythm(fake, {
    sleepFn: async (ms) => { waits.push(ms); },
    rng: () => 0.5,
    log: null,
  });
  ok(wrapped === fake, "原地包装并返回同一个 page 对象（调用方无需改代码）");

  await wrapped.click(".btn");
  ok(waits.length === 1, "page.click 之前有停顿");
  await wrapped.evaluate("() => document.body.innerText");
  ok(waits.length === 2 && waits[1] === nextDelay("read", () => 0.5), "只读 evaluate 用短间隔");
  await wrapped.evaluate("() => document.querySelector('.b').click()");
  ok(waits.length === 3 && waits[2] === nextDelay("action", () => 0.5), "页面内点击的 evaluate 用动作级间隔");
  await wrapped.keyboard.press("Enter");
  ok(waits.length === 4, "键盘回车也算动作，前面有停顿");
  await wrapped.goto("https://x");
  ok(waits.length === 5 && waits[4] >= delayRange("nav")[0], "导航前用更长的间隔");

  // 打字延迟：真人逐字敲，不是一次贴完
  let typedOpts = null;
  const fake2 = { async type(sel, text, opts) { typedOpts = opts; } };
  const w2 = withHumanRhythm(fake2, { sleepFn: async () => {}, rng: () => 0.5 });
  await w2.type("#input", "你好，请问还在招人吗");
  ok(typedOpts && typedOpts.delay >= 60 && typedOpts.delay <= 180, `逐字输入带抖动延迟（delay=${typedOpts && typedOpts.delay}ms）`);

  // 幂等：重复包装不会叠加延迟
  const before = waits.length;
  withHumanRhythm(wrapped, { sleepFn: async (ms) => { waits.push(ms); }, rng: () => 0.5 });
  await wrapped.click(".btn");
  ok(waits.length === before + 1, "重复包装不会叠加成两次停顿（幂等）");
}

// ─────────────────────────────────────────────
console.log("\n[D. 开关与容错]");
{
  const fake = { async click() { return 1; } };
  const off = withHumanRhythm(fake, { enabled: false, sleepFn: async () => { throw new Error("不该被调用"); } });
  ok(off === fake, "JOB_AGENT_HUMAN_RHYTHM=0 时原样返回（不包代理）");
  ok(withHumanRhythm(null) === null, "page=null 安全返回");

  const waits = [];
  const partial = { async evaluate(fn) { return typeof fn === "function" ? fn() : fn; } }; // 没有 click/keyboard/goto
  const wp = withHumanRhythm(partial, { sleepFn: async (ms) => { waits.push(ms); }, rng: () => 0.5 });
  await wp.evaluate("() => 1");
  ok(waits.length === 1, "page 缺方法时只包装存在的那些，不抛错");
}

console.log("\n════════════════════════════════");
console.log(`人味节奏闸门: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("失败项：\n  " + failures.join("\n  "));
  process.exit(1);
}
