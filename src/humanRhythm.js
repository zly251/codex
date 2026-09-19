// 人味节奏闸门（humanRhythm）
// ─────────────────────────────────────────────────────────────
// 为什么要有它：BOSS 直聘会看"操作间隔的规律性"来判机器人——真人点一下要犹豫几百毫秒到几秒，
// 而且偶尔会停很久（看内容/接电话）；脚本则是毫秒级连点、间隔恒定。项目里原本只在少数几处
// 加了随机等待，还有 11 处 `el.click()` 是页面内瞬时点击，节奏一眼假。
//
// 为什么不逐个改那些点击点：逐个改会漏（今天是 11 处，明天新增就忘），而且要拿到坐标才能
// 走 puppeteer 的鼠标路径。这里改在**取 page 的唯一出口**（BrowserManager.getPage），
// 给 page 包一层代理：所有交互方法调用前先按"像人"的间隔停一下，页面内点击靠识别
// evaluate 源码里的点击/提交特征来判定。一处生效，新增交互点自动被覆盖。
//
// 关掉：.env JOB_AGENT_HUMAN_RHYTHM=0
// ─────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 判定一段 evaluate 源码里是否含"会改变页面状态的动作"
const ACTION_MARKERS = [
  ".click(",
  ".focus(",
  "dispatchEvent",
  "requestSubmit",
  ".submit(",
  "insertText",
  "KeyboardEvent",
  "MouseEvent",
];

export function isActionSource(src) {
  const s = typeof src === "string" ? src : String(src || "");
  return ACTION_MARKERS.some((m) => s.includes(m));
}

// 间隔区间（毫秒）。action=会被人看见的动作（点击/输入/回车），read=只读扫描。
export function delayRange(kind) {
  if (kind === "action") return [700, 2200];
  if (kind === "nav") return [1400, 3200];
  return [120, 420];
}

/**
 * 抽一个"像人"的间隔。
 * 10% 概率出现明显更长的停顿（看内容/分心），真人节奏里这是最强的特征之一——
 * 恒定区间比随机区间更容易被识别成脚本。
 */
export function nextDelay(kind, rng = Math.random) {
  const [min, max] = delayRange(kind);
  let ms = min + rng() * (max - min);
  if (rng() < (kind === "read" ? 0.05 : 0.1)) ms *= 1.8 + rng() * 0.8;
  const cap = kind === "read" ? 900 : 6500;
  return Math.min(cap, Math.round(ms));
}

/**
 * 给 page 包一层节奏代理（幂等）。opts:
 *   sleepFn  注入用（测试）
 *   rng      注入用（测试）
 *   log      记录用
 *   enabled  默认读 env JOB_AGENT_HUMAN_RHYTHM（'0'/'false' 关闭）
 *   applyDelay 额外回调（测试里统计延迟次数）
 */
export function withHumanRhythm(page, opts = {}) {
  if (!page) return page;
  const env = opts.env || process.env;
  const enabled = opts.enabled !== undefined
    ? !!opts.enabled
    : !/^(0|false|no|off)$/i.test(String(env.JOB_AGENT_HUMAN_RHYTHM ?? "1").trim());
  if (!enabled) return page;
  if (page.__humanRhythmWrapped) return page;

  const sleepFn = typeof opts.sleepFn === "function" ? opts.sleepFn : sleep;
  const rng = typeof opts.rng === "function" ? opts.rng : Math.random;
  const log = typeof opts.log === "function" ? opts.log : null;

  async function pause(kind) {
    const ms = nextDelay(kind, rng);
    if (typeof opts.applyDelay === "function") {
      try { opts.applyDelay(kind, ms); } catch (e) {}
    }
    if (log) { try { log(`[rhythm] ${kind} 停顿 ${(ms / 1000).toFixed(1)}s`); } catch (e) {} }
    await sleepFn(ms);
  }

  // 交互类方法：调用前先停顿
  const ACTION_METHODS = ["click", "type", "hover", "tap", "select", "focus", "press", "sendCharacter"];
  for (const name of ACTION_METHODS) {
    if (typeof page[name] !== "function") continue;
    const orig = page[name].bind(page);
    page[name] = async function (...args) {
      const sel = typeof args[0] === "string" ? args[0] : "";
      // 输入框打字：真人不会一次贴完，交给 type 的 delay 抖动（下面单独处理）
      if (name === "type" && args[1] !== undefined && !args[2]) args[2] = { delay: 60 + Math.floor(rng() * 120) };
      await pause("action");
      return orig(...args);
    };
  }

  // keyboard：回车/打字同样算"被人看见的动作"
  if (page.keyboard && typeof page.keyboard === "object") {
    for (const name of ["press", "type", "down", "up"]) {
      if (typeof page.keyboard[name] !== "function") continue;
      const orig = page.keyboard[name].bind(page.keyboard);
      page.keyboard[name] = async function (...args) {
        if (name === "type" && args[1] === undefined) args[1] = { delay: 60 + Math.floor(rng() * 120) };
        await pause("action");
        return orig(...args);
      };
    }
  }

  // evaluate：页面内点击（el.click()）在这里被识别并加上动作级停顿；只读扫描只加很短抖动
  if (typeof page.evaluate === "function") {
    const origEval = page.evaluate.bind(page);
    page.evaluate = async function (fn, ...rest) {
      const src = typeof fn === "function" ? fn.toString() : String(fn || "");
      await pause(isActionSource(src) ? "action" : "read");
      return origEval(fn, ...rest);
    };
  }

  if (typeof page.goto === "function") {
    const origGoto = page.goto.bind(page);
    page.goto = async function (...args) {
      await pause("nav");
      return origGoto(...args);
    };
  }

  try {
    Object.defineProperty(page, "__humanRhythmWrapped", { value: true, enumerable: false });
  } catch (e) {
    page.__humanRhythmWrapped = true;
  }
  return page;
}
