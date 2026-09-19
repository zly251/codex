// Autonomous Job Search Agent
// M2: 投递节奏控制器 —— 把 AUTO_APPLY 岗位数组摊成当日随机时间轴计划
// 纯函数设计：now 与 rng 可注入，测试确定性；不做任何真实网络/浏览器动作。
//
// 规则（需求 B）：
// - 当日硬配额 APPLY_DAILY_QUOTA（默认 150），当日已投数从 applications 表当天 created 统计扣除。
// - 执行窗口随机 2~4 小时。
// - 单条间隔基础随机（默认 30~90 秒），每 ~20 单插入 5~15 分钟随机长休息。
// - 计划时间不得越过当日 22:00。

export const DEFAULT_QUOTA = 150;
export const WINDOW_MIN_MS = 2 * 3600 * 1000;
export const WINDOW_MAX_MS = 4 * 3600 * 1000;
export const GAP_MIN_MS = 30 * 1000;
export const GAP_MAX_MS = 90 * 1000;
export const LONG_REST_EVERY = 20;           // 每 ~20 单
export const LONG_REST_MIN_MS = 5 * 60 * 1000;   // 5 分钟
export const LONG_REST_MAX_MS = 15 * 60 * 1000;  // 15 分钟
export const DAY_DEADLINE_HOUR = 22;         // 不越过当日 22:00

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** 从 .env（经由 process.env，dotenv 在 server.mjs 已加载）读取配置，读不到用默认。只读不写。 */
export function schedulerConfig(overrides) {
  const o = overrides || {};
  return {
    quota: Number.isFinite(o.quota) && o.quota > 0 ? Math.floor(o.quota) : envInt("APPLY_DAILY_QUOTA", DEFAULT_QUOTA),
    appliedToday: Number.isFinite(o.appliedToday) && o.appliedToday >= 0 ? Math.floor(o.appliedToday) : 0,
    windowMinMs: Number.isFinite(o.windowMinMs) ? o.windowMinMs : WINDOW_MIN_MS,
    windowMaxMs: Number.isFinite(o.windowMaxMs) ? o.windowMaxMs : WINDOW_MAX_MS,
    gapMinMs: Number.isFinite(o.gapMinMs) ? o.gapMinMs : GAP_MIN_MS,
    gapMaxMs: Number.isFinite(o.gapMaxMs) ? o.gapMaxMs : GAP_MAX_MS,
    longRestEvery: Number.isFinite(o.longRestEvery) && o.longRestEvery > 0 ? Math.floor(o.longRestEvery) : LONG_REST_EVERY,
    longRestMinMs: Number.isFinite(o.longRestMinMs) ? o.longRestMinMs : LONG_REST_MIN_MS,
    longRestMaxMs: Number.isFinite(o.longRestMaxMs) ? o.longRestMaxMs : LONG_REST_MAX_MS,
    deadlineHour: Number.isFinite(o.deadlineHour) ? o.deadlineHour : DAY_DEADLINE_HOUR,
  };
}

function dayDeadline(nowMs, deadlineHour) {
  const d = new Date(nowMs);
  d.setHours(deadlineHour, 0, 0, 0);
  return d.getTime();
}

/** 当日剩余配额 = quota - 已投（不为负）。 */
export function remainingQuota(cfg) {
  return Math.max(0, cfg.quota - cfg.appliedToday);
}

/**
 * 统计当日已投数（按 created 是当天）。
 * 说明：Application.createdAt 由 SQLite datetime('now')/CURRENT_TIMESTAMP 写入，为 UTC
 * 字符串 "YYYY-MM-DD HH:MM:SS"；项目既有代码（server.mjs apiCloseStaleJobs）也按 UTC 日期
 * 串比较，故这里按 UTC 日期前缀匹配，与库内约定一致。
 * apps: [{ createdAt|appliedAt: "YYYY-MM-DD HH:MM:SS" | ISO 串 }]
 */
export function countAppliedToday(apps, nowMs) {
  const now = nowMs instanceof Date ? nowMs.getTime() : (Number.isFinite(nowMs) ? Number(nowMs) : Date.now());
  const prefix = new Date(now).toISOString().slice(0, 10);
  let n = 0;
  for (const a of apps || []) {
    const t = String(a?.createdAt || a?.appliedAt || "");
    if (t.startsWith(prefix)) n++;
  }
  return n;
}

/**
 * 生成当日投递计划。
 * @param {Array} jobs  AUTO_APPLY 岗位数组（对象，含 id/title 即可）
 * @param {object} opts { now?: Date|number, rng?: ()=>[0,1), cfg overrides... }
 * @returns {{ items: Array<{job,atMs,atISO,gapMs,longRestBefore}>, startMs, endMs, planned, skippedQuota, config }}
 */
export function planSchedule(jobs, opts = {}) {
  const cfg = schedulerConfig(opts);
  const nowMs = opts.now instanceof Date ? opts.now.getTime() : (Number.isFinite(opts.now) ? Number(opts.now) : Date.now());
  const rng = typeof opts.rng === "function" ? opts.rng : Math.random;
  const list = Array.isArray(jobs) ? jobs.filter(Boolean) : [];
  const remaining = remainingQuota(cfg);
  const planned = Math.min(list.length, remaining);
  const out = {
    items: [],
    startMs: null,
    endMs: null,
    planned,
    skippedQuota: Math.max(0, list.length - planned),
    windowMs: 0,
    config: cfg,
  };
  if (planned === 0) return out;

  const deadlineMs = dayDeadline(nowMs, cfg.deadlineHour);
  if (deadlineMs <= nowMs) {
    // 已过 22:00：当日不再排投递
    out.skippedQuota = list.length;
    out.items = [];
    out.planned = 0;
    return out;
  }

  // 窗口随机 2~4h；剩余时间不足时压缩到 [now, deadline]
  const randWindow = cfg.windowMinMs + rng() * (cfg.windowMaxMs - cfg.windowMinMs);
  let windowMs = Math.min(randWindow, deadlineMs - nowMs - (planned > 1 ? cfg.gapMinMs : 0));
  if (windowMs < cfg.gapMinMs) windowMs = cfg.gapMinMs;

  // 把 planned 单尽量均匀铺进窗口：基准步长 + 随机抖动，长休息单额外插入。
  // 采用“预算制”：先按最小间隔预留长休息时间，剩余窗口均分给普通间隔。
  const longRestCount = planned > 1 ? Math.floor((planned - 1) / cfg.longRestEvery) : 0;
  let avgRestMs = (cfg.longRestMinMs + cfg.longRestMaxMs) / 2;
  let budget = windowMs - longRestCount * avgRestMs;
  if (budget < cfg.gapMinMs * (planned - 1)) {
    // 窗口装不下：收缩长休息预算（时间仍不越 deadline，间隔取下限）
    budget = Math.max(cfg.gapMinMs * (planned - 1), windowMs * 0.6);
    avgRestMs = Math.max(cfg.longRestMinMs, (windowMs - budget) / Math.max(1, longRestCount));
  }
  const baseStep = planned > 1 ? Math.max(cfg.gapMinMs, budget / (planned - 1)) : 0;

  let cursor = nowMs;
  for (let i = 0; i < planned; i++) {
    let gapMs = 0;
    let longRestBefore = false;
    if (i > 0) {
      const isLongRestSlot = i % cfg.longRestEvery === 0; // 第 20、40… 单前
      if (isLongRestSlot) {
        gapMs = Math.round(avgRestMs * (0.8 + rng() * 0.4)); // 在预算附近抖动
        if (gapMs < cfg.longRestMinMs) gapMs = cfg.longRestMinMs;
        if (gapMs > cfg.longRestMaxMs) gapMs = cfg.longRestMaxMs;
        longRestBefore = true;
      } else {
        // 基础随机间隔：30~90s（若均分步长更大则用步长 + 小幅抖动，保证摊开）
        const jitter = cfg.gapMinMs + rng() * (cfg.gapMaxMs - cfg.gapMinMs);
        gapMs = Math.round(Math.max(cfg.gapMinMs, Math.min(jitter, baseStep * 1.5)));
        if (baseStep > cfg.gapMaxMs) gapMs = Math.round(baseStep * (0.7 + rng() * 0.6));
        if (gapMs < cfg.gapMinMs) gapMs = cfg.gapMinMs;
      }
      cursor += gapMs;
      if (cursor > deadlineMs) {
        // 越界：本单及之后不再排（本单尚未 push），保证计划不越过 22:00
        break;
      }
    }
    out.items.push({
      job: list[i],
      atMs: cursor,
      atISO: new Date(cursor).toISOString(),
      gapMs,
      longRestBefore,
    });
  }

  out.planned = out.items.length;
  out.skippedQuota = Math.max(0, list.length - out.items.length);
  if (out.items.length > 0) {
    out.startMs = out.items[0].atMs;
    out.endMs = out.items[out.items.length - 1].atMs;
    out.windowMs = out.endMs - out.startMs;
  }
  return out;
}

function fmt(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return m + "m" + (r ? " " + r + "s" : "");
  return Math.floor(m / 60) + "h " + (m % 60) + "m";
}

/**
 * 人类可读时间轴报告。
 * 输出：起止时刻、单数、平均/最大间隔、长休息插入点数、是否越 22:00。
 */
export function dryRunReport(plan) {
  const items = plan?.items || [];
  const lines = [];
  lines.push("=== 投递节奏计划 (dry-run) ===");
  if (items.length === 0) {
    lines.push("今日无可投递岗位（配额已满或已过 22:00 或无 AUTO_APPLY 岗位）");
    lines.push(`配置: quota=${plan?.config?.quota} 当日已投=${plan?.config?.appliedToday}`);
    return lines.join("\n");
  }
  const gaps = items.slice(1).map((it) => it.gapMs);
  const avgGap = gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : 0;
  const maxGap = gaps.length ? Math.max(...gaps) : 0;
  const longRests = items.filter((it) => it.longRestBefore).length;
  lines.push(`计划投递: ${items.length} 单（配额 ${plan.config.quota}，当日已投 ${plan.config.appliedToday}，因配额/截断未排 ${plan.skippedQuota}）`);
  lines.push(`时间轴: ${fmt(plan.startMs)} → ${fmt(plan.endMs)}（跨 ${fmtDur(plan.windowMs)}）`);
  lines.push(`间隔: 平均 ${fmtDur(avgGap)} / 最大 ${fmtDur(maxGap)} / 最小 ${gaps.length ? fmtDur(Math.min(...gaps)) : "-"}`);
  lines.push(`长休息插入点: ${longRests} 处（每约 ${plan.config.longRestEvery} 单一次 ${fmtDur(plan.config.longRestMinMs)}~${fmtDur(plan.config.longRestMaxMs)}）`);
  const dl = new Date(items[items.length - 1].atMs);
  lines.push(`截止校验: 末单 ${fmt(dl.getTime())}${dl.getHours() < plan.config.deadlineHour || (dl.getHours() === plan.config.deadlineHour && dl.getMinutes() === 0) ? " ✓ 未越 " + plan.config.deadlineHour + ":00" : " ✗ 越线！"}`);
  // 逐条时间轴（超过 30 单时只展示前 5 + 长休息点 + 末单）
  const show = [];
  items.forEach((it, idx) => {
    const title = it.job?.title || it.job?.name || ("job#" + (it.job?.id ?? idx));
    const tag = it.longRestBefore ? "  [长休息 " + fmtDur(it.gapMs) + "]" : "";
    show.push(`  ${String(idx + 1).padStart(3)}. ${fmt(it.atMs)}  ${String(title).slice(0, 30)}${tag}`);
  });
  const view = show.length <= 30 ? show : [...show.slice(0, 5), `  ... 省略 ${show.length - 30} 行 ...`, ...show.filter((l, i) => items[i]?.longRestBefore).slice(0, 8), show[show.length - 1]];
  lines.push(view.join("\n"));
  return lines.join("\n");
}

/**
 * 把计划折算成 chatApply.autoApply 现有节流参数（delayMin/delayMax，单位=秒）。
 * 最小侵入：不改 autoApply，只把计划的平均间隔映射进去，并透出计划元数据供日志。
 */
export function throttleOptions(plan, fallback = { delayMin: 8, delayMax: 25 }) {
  const items = plan?.items || [];
  if (items.length < 2) return { delayMin: fallback.delayMin, delayMax: fallback.delayMax, plan: null };
  const gaps = items.slice(1).map((it) => it.gapMs);
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const minS = Math.max(1, Math.round(Math.min(...gaps) / 1000));
  const maxS = Math.max(minS, Math.round(Math.max(...gaps) / 1000));
  return {
    delayMin: minS,
    delayMax: maxS,
    plan: {
      count: items.length,
      startMs: plan.startMs,
      endMs: plan.endMs,
      avgGapMs: Math.round(avg),
      longRests: items.filter((it) => it.longRestBefore).length,
    },
  };
}
