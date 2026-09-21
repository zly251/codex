import * as jobDb from "./db/job.js";
import { getDb } from "./db/index.js";
import * as companyDb from "./db/company.js";
import * as applicationDb from "./db/application.js";
import * as resumeDb from "./db/resume.js";
import * as reviewQueue from "./db/reviewQueue.js";
import {
  planSchedule,
  dryRunReport,
  throttleOptions,
  schedulerConfig,
  countAppliedToday,
} from "./applyScheduler.js";
import { BrowserManager } from "./browser/browserManager.js";
import * as liveLog from "./log.js";
import {
  findEdgePath,
  DEFAULT_PROFILE,
  FALLBACK_PROFILE,
} from "./edgeLauncher.js";
import { scoreJob, decideJob, sortJobsForApplyWithDistance, directionKeywords, matchesDirection, experienceRelevance } from "./scoring.js";
import { applyDistanceToJob } from "./distance.js";
import { enrichJobFromDetail, enrichmentPatch } from "./enrich.js";
import { getPlatform } from "./platforms/index.js";
import { loadResumeEditor } from "./resumeExport.js";
import {
  buildSafeResumeText,
  getProviderConfig,
} from "./llmProvider.js";
import { DATA_ROOT, PROFILE_PATH, CHAT_PATH } from "./paths.js";
import fs from "node:fs";
import path from "node:path";

let browserManager = null;
let scraper = null;
let bot = null;

var messages = [];
try {
  var _msgPath = CHAT_PATH;
  if (fs.existsSync(_msgPath)) messages = JSON.parse(fs.readFileSync(_msgPath, "utf8"));
} catch (e) {}

var state = {
  status: "idle",
  lastSearch: null,
  lastError: null,
  appliedCount: 0,
  chatActive: false,
  replying: false,
  applyStatus: null,
  running: false,
  progress: null,
};
const platform = getPlatform();
var cookieWatcher = null;

// —— 无人值守补库存（replenish）节流状态：单进程内即可，无需持久化 ——
// 反爬靠冷却：搜索默认 ≥3 小时一次、增补默认 ≥45 分钟一次；force=1 可忽略冷却。
let lastReplenishSearchAt = 0;
let lastReplenishEnrichAt = 0;
let replenishKeywordIdx = 0;
const REPLENISH_KEYWORDS = String(process.env.JOB_AGENT_REPLENISH_KEYWORDS || "外贸业务员,销售,客服,业务助理,跟单文员")
  .split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
function minutesAgo(ts) { return ts ? (Date.now() - ts) / 60000 : Infinity; }

async function savePlatformCookies() {
  try {
    const result = await platform.saveCookies(getManager(), DATA_ROOT);
    if (result?.saved) liveLog.add(`${platform.name} 登录 Cookie 已备份 (${result.count} 条)`);
  } catch (e) {}
}

async function restorePlatformCookies() {
  try {
    const result = await platform.restoreCookies(getManager(), DATA_ROOT);
    if (result?.restored) liveLog.add(`已恢复 ${platform.name} 登录 Cookie (${result.count} 条)`);
    return result?.restored ? result.count : 0;
  } catch (e) {
    return 0;
  }
}

function startCookieWatcher() {
  if (cookieWatcher) return;
  cookieWatcher = setInterval(function () {
    savePlatformCookies().catch(function () {});
  }, 15000);
}

async function afterBrowserConnect() {
  state.status = "connected";
  await closeExtraJobPages();
  await restorePlatformCookies();
  await savePlatformCookies();
  startCookieWatcher();
  try {
    const page = await platform.findJobPage(getManager());
    if (page && !(await platform.isLoggedIn(page))) {
      liveLog.add(`${platform.name} 未登录，打开登录页`);
      try { await page.goto(platform.loginUrl, { waitUntil: "domcontentloaded", timeout: 15000 }); } catch (e) {}
    }
  } catch (e) {}
}

// 给自动巡航（autopilot）用的登录态检查：浏览器没连/没页面/未登录都算 false。
export async function checkLoggedIn() {
  try {
    const mgr = getManager();
    if (!mgr.browser?.connected) return false;
    const page = await platform.findJobPage(mgr);
    if (!page) return false;
    return !!(await platform.isLoggedIn(page));
  } catch (e) {
    return false;
  }
}

// 仅供自动巡航/状态面板：当前有多少会话被标记为"需要人工"（Offer/合同/外包类）
export function manualPendingCount() {
  try {
    return chatState.listManualPending ? chatState.listManualPending().length : 0;
  } catch (e) {
    return 0;
  }
}

// —— 自动巡航（autopilot）用的三个取数口 ——
export function isBrowserConnected() {
  try {
    return !!getManager().browser?.connected;
  } catch (e) {
    return false;
  }
}

export async function ensureBrowserConnected() {
  const mgr = getManager();
  if (!mgr.browser?.connected) await ensureBrowserLaunched();
  await afterBrowserConnect();
}

// 已放行但还没投出去的岗位数（autopilot 用它判断队列是否排空）
export function approvedPendingCount() {
  try {
    reviewQueue.ensureTable();
    return reviewQueue.findApproved().length;
  } catch (e) {
    return 0;
  }
}

// 最近的页面日志消息（摘要模块用来还原会话上下文）
export function recentMessages(limit = 300) {
  const n = Math.max(1, Math.min(Number(limit) || 300, 2000));
  return messages.slice(-n);
}

// 会话消息按"会话名"分组，喂给 chatSummary.buildSummaries
export function groupMessagesByChat(list) {
  const map = new Map();
  for (const m of list || []) {
    const key = String(m?.chat || m?.name || m?.company || "").trim();
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({
      role: m?.role === "me" ? "me" : "hr",
      text: String(m?.text || m?.msg || ""),
      time: String(m?.time || m?.t || ""),
    });
  }
  return Array.from(map.entries()).map(function (e) {
    return { chatName: e[0], messages: e[1] };
  });
}

// —— 会话原话留档（给"面试要点摘要"用）——
// 为什么单独存：页面扫到的会话正文（chat.text）原本只活在内存里，回完就没了；
// 摘要需要它才能抽出"面试时间/地点/薪资/要准备什么"。
const CHAT_TRANSCRIPT_PATH =
  process.env.JOB_AGENT_CHAT_TRANSCRIPT_PATH ||
  path.join(DATA_ROOT, "data", "chat-transcripts.json");
const TRANSCRIPT_MAX = 200;

export function recordChatTranscript(chat) {
  try {
    const key = String(chat?.name || chat?.company || "").trim();
    const text = String(chat?.text || chat?.msg || "").trim();
    if (!key || !text) return { saved: false, reason: "empty" };
    let store = { updatedAt: "", items: [] };
    try { store = JSON.parse(fs.readFileSync(CHAT_TRANSCRIPT_PATH, "utf8")) || store; } catch (e) {}
    const items = Array.isArray(store.items) ? store.items : [];
    const last = items[items.length - 1];
    if (last && last.chatName === key && last.text === text) return { saved: false, reason: "unchanged" };
    items.push({ chatName: key, company: String(chat?.company || ""), text: text.slice(0, 6000), lastHrMsg: String(chat?.msg || "").slice(0, 500), at: new Date().toISOString() });
    store.items = items.slice(-TRANSCRIPT_MAX);
    store.updatedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(CHAT_TRANSCRIPT_PATH), { recursive: true });
    fs.writeFileSync(CHAT_TRANSCRIPT_PATH, JSON.stringify(store, null, 2), "utf8");
    return { saved: true };
  } catch (e) {
    return { saved: false, reason: e.message };
  }
}

// 每个会话取最后一次留档的原话，转成摘要模块要的 {chatName, messages} 形状
export function recentChatTranscripts(limit = 30) {
  try {
    const store = JSON.parse(fs.readFileSync(CHAT_TRANSCRIPT_PATH, "utf8"));
    const items = Array.isArray(store.items) ? store.items : [];
    const latest = new Map();
    for (const it of items) latest.set(it.chatName, it);
    return Array.from(latest.values())
      .slice(-Math.max(1, Math.min(Number(limit) || 30, 200)))
      .map(function (it) {
        return {
          chatName: it.chatName,
          messages: [
            { role: "hr", text: String(it.text || ""), time: String(it.at || "") },
            ...(it.lastHrMsg ? [{ role: "hr", text: String(it.lastHrMsg), time: String(it.at || "") }] : []),
          ],
        };
      });
  } catch (e) {
    return [];
  }
}

function getJobCompanyName(j) {
  if (j.companyId) {
    try {
      const c = companyDb.findById(j.companyId);
      if (c && c.name) return c.name;
    } catch (e) {}
  }
  return j.companyName || "";
}

function isBlockedCompany(j) {
  const name = getJobCompanyName(j);
  return (platform.blockedCompanies || []).some((b) => name.includes(b));
}

function getProfile() {
  try { return JSON.parse(fs.readFileSync(PROFILE_PATH, "utf8")); } catch (e) { return {}; }
}

function getManager() {
  if (!browserManager) browserManager = new BrowserManager();
  return browserManager;
}

function getScraper() {
  if (!scraper) scraper = platform.createScraper(getManager());
  return scraper;
}

function getBot() {
  if (!bot) bot = platform.createBot(getManager());
  return bot;
}

async function closeExtraJobPages() {
  const b = getManager().browser;
  if (!b?.connected) return;
  let pages = [];
  try {
    pages = await b.pages();
  } catch (e) {
    return;
  }
  const jobPages = [];
  let hasLoginPage = false;
  for (const p of pages) {
    try {
      if (p.isClosed()) continue;
      const u = p.url();
      if (!u.includes("zhipin.com") || u.includes("about:")) continue;
      jobPages.push(p);
      const text = await p.evaluate(function () {
        return document.body ? document.body.innerText : "";
      }).catch(function () { return ""; });
      if (String(text || "").indexOf("登录/注册") >= 0) hasLoginPage = true;
    } catch (e) {}
  }
  // 有页面正在登录时不要关闭任何 BOSS 标签页，避免把登录页杀掉。
  if (hasLoginPage) {
    liveLog.add("检测到 BOSS 登录页，暂不关闭多余标签页");
    return;
  }
  while (jobPages.length > 1) {
    const extra = jobPages.pop();
    try {
      await extra.close();
      liveLog.add("已关闭多余 BOSS 标签页");
    } catch (e) {}
  }
}

export function getStatus() {
  return {
    ...state,
    browserConnected: browserManager?.browser?.connected || false,
    logs: liveLog.list(60),
  };
}

async function ensureBrowserLaunched() {
  const exe = findEdgePath();
  if (!exe) throw new Error("未找到浏览器，请安装 Edge 或 Chrome，或设置 BROWSER_PATH 环境变量");
  let lastErr = null;
  const profiles = [DEFAULT_PROFILE, FALLBACK_PROFILE];
  for (const dir of profiles) {
    try {
      liveLog.add("自动启动浏览器: " + exe);
      await getManager().ensureEdge({ profileDir: dir });
      liveLog.add("浏览器已启动并连接");
      return true;
    } catch (e) {
      lastErr = e;
      liveLog.add("浏览器启动失败: " + (e?.message || e));
    }
  }
  throw new Error("浏览器启动失败: " + (lastErr?.message || ""));
}

export async function handleLaunch(req, res, body) {
  try {
    const mgr = getManager();
    if (mgr.browser?.connected) {
      json(res, { ok: true, launched: false, message: "浏览器已连接" });
      return;
    }
    await ensureBrowserLaunched();
    await afterBrowserConnect();
    state.status = "connected";
    // 确保 BOSS 页面已打开（用 CDP HTTP API 开新标签，避免 puppeteer newPage 卡顿）
    try {
      const pages = await mgr.browser.pages();
      const jobPage = pages.find(function (p) {
        try { return String(p.url()).includes("zhipin.com"); } catch (e) { return false; }
      });
      if (jobPage) {
        await jobPage.bringToFront().catch(function () {});
      } else {
        await fetch("http://127.0.0.1:9222/json/new?" + encodeURIComponent("https://www.zhipin.com"), {
          method: "PUT",
          signal: AbortSignal.timeout(10000),
        }).catch(function () {
          // 兜底：直接在当前页导航
          const pg = pages.find(function (p) {
            try { return String(p.url()).startsWith("about:") || String(p.url()).startsWith("edge://"); } catch (e) { return false; }
          }) || pages[0];
          if (pg) pg.goto("https://www.zhipin.com", { waitUntil: "domcontentloaded", timeout: 20000 }).catch(function () {});
        });
      }
    } catch (e) {
      liveLog.add("打开 BOSS 页面失败: " + (e?.message || e));
    }
    json(res, { ok: true, launched: true, message: "浏览器已启动并连接" });
  } catch (e) {
    state.lastError = e.message;
    json(res, { ok: false, error: e.message }, 400);
  }
}

export async function handleConnect(req, res, body) {
  try {
    const mgr = getManager();
    if (!mgr.browser?.connected) {
      liveLog.add("启动浏览器");
      await ensureBrowserLaunched();
    }
    await afterBrowserConnect();
    state.status = "connected";
    json(res, { ok: true, message: "连接成功" });
  } catch (e) {
    state.lastError = e.message;
    json(res, { ok: false, error: e.message }, 400);
  }
}

// 搜索核心：被 handleSearch 与无人值守补库存（handleReplenish）共用，单一事实来源。
// 未连接浏览器时抛错（含"浏览器未连接"），由调用方决定回 400 还是记入巡航错误。
export async function runSearchJobs({ keyword, city, pages } = {}) {
  const s = getScraper();
  const mgr = getManager();
  if (!mgr.browser?.connected) throw new Error("浏览器未连接，请先连接 Edge");
  state.status = "searching";
  const kw = keyword || "C++";
  const ct = city || "";
  const pg = pages || 3;
  liveLog.add(`开始搜索: ${kw} ${ct || "全国"} ${pg} 页`);
  const jobs = await s.searchJobs({ keyword: kw, city: ct, pages: pg });
  if (jobs.length > 0) {
    await s.saveJobs(jobs, jobDb, companyDb);
    // M1 接线：落库后立即按坐标/区县回填距离档（纯 DB 计算，不碰网络）
    let distOk = 0;
    for (const j of jobs) {
      try {
        const row = jobDb.findByUrl(j.url);
        if (row) { applyDistanceToJob(row); distOk++; }
      } catch (e) {}
    }
    if (distOk > 0) liveLog.add(`距离回填: ${distOk}/${jobs.length} 个职位已分档`);
  }
  state.lastSearch = { keyword: kw, city: ct, pages: pg, count: jobs.length };
  state.status = jobs.length > 0 ? "found" : "empty";
  liveLog.add(`搜索完成: 找到 ${jobs.length} 个职位`);
  return { count: jobs.length, jobs };
}

export async function handleSearch(req, res, body) {
  try {
    const mgr = getManager();
    if (!mgr.browser?.connected) {
      json(res, { ok: false, error: "浏览器未连接，请先连接 Edge", hint: "请先连接浏览器" }, 400);
      return;
    }
    const r = await runSearchJobs(body || {});
    json(res, { ok: true, count: r.count, jobs: r.jobs.slice(0, 50) });
  } catch (e) {
    state.status = "error";
    state.lastError = e.message;
    liveLog.add("搜索失败: " + (e.message || "").slice(0, 120));
    json(res, { ok: false, error: e.message }, 500);
  }
}

// ── M1 接线：职位详情页增补（JD/福利标签/坐标 → 距离档） ──────────────
// 详情增补核心：被 handleEnrich 与无人值守补库存（handleReplenish）共用，单一事实来源。
// 抛出的 Error 带 .httpStatus，让 handleEnrich 保持原有的 400/404/500 语义。
export async function runEnrichBatch({ jobId, limit, maxMs } = {}) {
  const httpErr = function (msg, status) { const e = new Error(msg); e.httpStatus = status; return e; };
  const mgr = getManager();
  if (!mgr.browser?.connected) throw httpErr("浏览器未连接，请先连接 Edge", 400);
  const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  const pick = function (a, b) {
    for (const s of [a, b]) {
      const m = String(s || "").match(/[?&]jobId=([^&#]+)/i);
      if (m) return m[1];
    }
    return "";
  };
  // 待增补：指定 jobId 优先；否则取"缺 JD 或缺宿舍来源"的活跃岗位
  let targets = [];
  if (jobId) {
    const one = jobDb.findById(Number(jobId));
    if (!one) throw httpErr("岗位不存在", 404);
    targets = [one];
  } else {
    targets = getDbEnrichCandidates();
  }
  const lim = Math.max(1, Math.min(Number(limit) || 20, 100));
  targets = targets.slice(0, lim);
  const budgetMs = Math.max(10000, Math.min(Number(maxMs) || 120000, 600000));
  const startedAt = Date.now();

  let page = null;
  try { page = await mgr.getPage(); } catch (e) {
    throw httpErr("获取页面失败: " + (e.message || "").slice(0, 80), 500);
  }

  let enriched = 0, failed = 0, skipped = 0;
  const details = [];
  for (const job of targets) {
    if (Date.now() - startedAt > budgetMs) { liveLog.add("增补达到时间预算，剩余岗位下次再跑"); break; }
    if (!job.url || !/zhipin\.com/.test(job.url)) { skipped++; continue; }
    try {
      await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 20000 });
      // 必须真落在详情页：BOSS 会把失效/风控页重定向到城市首页，此时正文/地址/坐标
      // 全是别的页面的内容，写库即污染（2026-09-19 实测：重定向页写出 lat/lng=0,0）。
      const landed = String(page.url() || "");
      if (!/job_detail/.test(landed)) {
        skipped++;
        liveLog.add("增补跳过(job " + job.id + "): 未落在详情页 " + landed.slice(0, 60));
        continue;
      }
      await sleep(1500 + Math.random() * 1500);
      const result = await enrichJobFromDetail(page);
      // 空提取（页面是空白页/风控页/DOM 变了）不算成功：写库只会把 hasDormitory 抹成 0，
      // 还会让"成功数"虚高掩盖真实故障。
      if (!result.description && !result.address) {
        skipped++;
        liveLog.add("增补跳过(job " + job.id + "): 详情页未取到正文与地址");
        continue;
      }
      const patch = enrichmentPatch(result);
      const jobIdMatch = pick(job.url, job.rawData);
      const cardText = jobIdMatch ? String(job.rawData || "") : "";
      if (jobIdMatch && !cardText.includes('"encryptJobId":"' + jobIdMatch)) {
        liveLog.add("增补坐标跳过: 页面 encryptJobId 与库记录不匹配，防串写: job " + job.id);
      } else {
        jobDb.updateEnrichment(job.id, patch);
        applyDistanceToJob(jobDb.findById(job.id));
        enriched++;
        details.push({ id: job.id, hasDormitory: patch.hasDormitory || 0, descLen: (patch.description || "").length });
      }
    } catch (e) {
      failed++;
      liveLog.add("增补失败(job " + job.id + "): " + (e.message || "").slice(0, 100));
    }
    // 岗位间随机停顿，避免访问节奏过密
    await sleep(2500 + Math.random() * 3500);
  }
  liveLog.add(`详情增补完成: 成功 ${enriched} / 失败 ${failed} / 跳过 ${skipped}（共处理 ${Math.min(targets.length, enriched + failed + skipped)}）`);
  return { enriched, failed, skipped, details: details.slice(0, 50) };
}

// POST /api/boss/enrich  { jobId?, limit?, maxMs? }
export async function handleEnrich(req, res, body) {
  try {
    const r = await runEnrichBatch(body || {});
    json(res, { ok: true, enriched: r.enriched, failed: r.failed, skipped: r.skipped, details: r.details });
  } catch (e) {
    if (!e.httpStatus) liveLog.add("增补异常: " + (e.message || "").slice(0, 120));
    json(res, { ok: false, error: e.message }, e.httpStatus || 500);
  }
}

function getDbEnrichCandidates() {
  // 缺 JD 正文 或 从未有宿舍来源 的活跃岗位（enrich 跑过但没找到宿舍时 dormitorySource 为空串/null，
  // 为避免反复重跑同批无果岗位，只挑 description 为空的作为主信号）。
  // 排序按"抓取时间"而不是 updatedAt：启动时的 refreshJobScores() 会把整表 updatedAt 刷成同一时刻，
  // 一旦并列 SQLite 就退回 rowid 升序 ⇒ 刚搜到的新岗位（用户真正要投的那些）永远排在队尾，
  // 增补只会去补三周前的老岗位（2026-09-19 实测：搜完外贸/客服后增补抓的是 id 25~76 的旧岗）。
  try {
    return getDb().prepare(
      "SELECT * FROM Job WHERE (description IS NULL OR description = '') AND (status IS NULL OR status = 'active') ORDER BY COALESCE(scrapedAt, updatedAt, '') DESC, id DESC"
    ).all();
  } catch (e) {
    return [];
  }
}

// POST /api/boss/replenish  { force?, enrichLimit?, maxMs? }
// 无人值守补库存：轮换搜索一个方向关键词 + 增补若干缺 JD 的岗位，让巡航自己找活。
// 反爬靠冷却：搜索默认 ≥3 小时/次（JOB_AGENT_REPLENISH_SEARCH_MIN 分钟）、
// 增补默认 ≥45 分钟/次（JOB_AGENT_REPLENISH_ENRICH_MIN 分钟）、单次 ≤10 条；force=1 忽略冷却。
export async function handleReplenish(req, res, body) {
  try {
    const b = body || {};
    const force = !!b.force;
    const searchMin = Number(process.env.JOB_AGENT_REPLENISH_SEARCH_MIN) || 180;
    const enrichMin = Number(process.env.JOB_AGENT_REPLENISH_ENRICH_MIN) || 45;
    const city = String(process.env.JOB_AGENT_REPLENISH_CITY || "台州");
    const pages = Number(process.env.JOB_AGENT_REPLENISH_PAGES) || 2;
    let searched = 0, enriched = 0, failed = 0, skipped = 0;
    // 1) 搜索：轮换关键词，受冷却闸门控制（首轮 lastReplenishSearchAt=0 ⇒ minutesAgo=Infinity ⇒ 立刻跑一次）
    if (REPLENISH_KEYWORDS.length && (force || minutesAgo(lastReplenishSearchAt) >= searchMin)) {
      const keyword = REPLENISH_KEYWORDS[replenishKeywordIdx % REPLENISH_KEYWORDS.length];
      replenishKeywordIdx = (replenishKeywordIdx + 1) % REPLENISH_KEYWORDS.length;
      lastReplenishSearchAt = Date.now();
      const r = await runSearchJobs({ keyword, city, pages });
      searched = r.count;
      liveLog.add(`补库存搜索: ${keyword} ${city} -> ${searched} 个职位`);
    } else {
      liveLog.add("补库存：搜索冷却未到，本轮跳过搜索");
    }
    // 2) 增补：只补新落库/仍缺 JD 的岗位，单次 ≤10，受冷却闸门控制
    if (force || minutesAgo(lastReplenishEnrichAt) >= enrichMin) {
      lastReplenishEnrichAt = Date.now();
      const e = await runEnrichBatch({ limit: Math.min(Number(b.enrichLimit) || 10, 10), maxMs: Number(b.maxMs) || 150000 });
      enriched = e.enriched; failed = e.failed; skipped = e.skipped;
    } else {
      liveLog.add("补库存：增补冷却未到，本轮跳过增补");
    }
    json(res, { ok: true, searched, enriched, failed, skipped });
  } catch (e) {
    liveLog.add("补库存异常: " + (e.message || "").slice(0, 120));
    json(res, { ok: false, error: e.message }, e.httpStatus || 500);
  }
}

// APPLY_DRY_RUN：默认 true（读不到 .env 配置时也按 true 处理）。
// true 时投递入口只生成节奏计划并写日志，绝不执行真实打招呼。
export function isApplyDryRun(env) {
  const raw = (env || process.env).APPLY_DRY_RUN;
  if (raw === undefined || raw === null || String(raw).trim() === "") return true;
  return !/^(0|false|no|off)$/i.test(String(raw).trim());
}

// REVIEW 地板分：与 decideJob 的默认 reviewThreshold=30 保持一致（不修改 scoring.js）。
const REVIEW_FLOOR = 30;

/**
 * M2-A 决策分桶（纯函数，可单测）。
 * 对每个 {job, score} 调用 decideJob 分入 AUTO_APPLY / REVIEW / IGNORE。
 * M1 接口（20:07 起）：decideJob(score, reviewThreshold, job) 返回对象
 *   {decision, reason, tier, hasDormitory}；不传 job 则返回纯字符串（旧行为）。
 * 这里必须整体传入 s.job：UNKNOWN 档位封顶 REVIEW、绝不 AUTO（防未 enrich 数据被自动投），
 * 距离档位/宿舍由 decideJob 内部 effectiveTier/hasDormitory 读取，调用方不单独取 distanceTier。
 * reason 直接用 M1 生成的人话理由（含原始判定+档位），不自行拼接。
 */
export function partitionByDecision(scored, reviewThreshold) {
  const buckets = { auto: [], review: [], ignore: [] };
  (scored || []).forEach(function (s) {
    const d = decideJob(s.score, reviewThreshold, s.job);
    const decision = typeof d === "string" ? d : d.decision;
    const reason = typeof d === "string" ? "" : d.reason;
    if (decision === "AUTO_APPLY") {
      buckets.auto.push(Object.assign({}, s, { decision, reason }));
    } else if (decision === "REVIEW") {
      buckets.review.push(Object.assign({}, s, { decision, reason }));
    } else {
      buckets.ignore.push(Object.assign({}, s, { decision, reason }));
    }
  });
  return buckets;
}

export async function handleApply(req, res, body) {
  try {
    const mgr = getManager();
    const b = getBot();
    if (b.running || state.running || state.chatActive || state.replying || b._checking) {
      json(res, { ok: false, error: "已有投递任务运行中，请先停止", busy: true }, 409);
      return;
    }
    // M2-B：APPLY_DRY_RUN（默认 true）时只生成计划+写日志，不触碰浏览器；
    // 真实打招呼路径保持原有的连接+登录硬校验。
    const dryRun = isApplyDryRun();
    if (!dryRun) {
      if (!mgr.browser?.connected) {
        json(res, { ok: false, error: "浏览器未连接，请先连接浏览器" }, 400);
        return;
      }
      const loginPage = await platform.findJobPage(getManager());
      if (!loginPage || !(await platform.isLoggedIn(loginPage))) {
        liveLog.add(`${platform.name} 未登录，请先扫码登录后再投递`);
        try { await loginPage?.bringToFront(); } catch (e) {}
        json(res, { ok: false, error: `${platform.name} 未登录，请先扫码登录`, needLogin: true }, 400);
        return;
      }
    }
    const jobId = body?.jobId ? Number(body.jobId) : null;
    const limit = body?.limit || 99;
    const minMatch = (body?.minMatch ?? 0) / 100;
    const filterCity = body?.city || "";
    const filterDistrict = body?.district || "";
    const filterKeywords = body?.keywords || "";
    const delayMin = Number(body?.delayMin ?? 8) || 8;
    const delayMax = Number(body?.delayMax ?? 25) || 25;
    const skipApplied = body?.skipApplied !== false;

    const searchLiveJobs = async function () {
      const s = getScraper();
      const kw = filterKeywords.split(/[,\u3001\/]/).map(function (x) { return x.trim(); }).filter(function (x) { return x; })[0] || "C++";
      const liveJobs = await s.searchJobs({ keyword: kw, city: filterCity, pages: 3 });
      const liveJobsFiltered = liveJobs.filter(function (j) { return !isBlockedCompany(j); });
      if (liveJobsFiltered.length === 0) return [];
      await s.saveJobs(liveJobsFiltered, jobDb, companyDb);
      return jobDb.search({ limit: 200 }).filter(function (j) { return !j.status || j.status === "active"; })
        .filter(function (j) { return !isBlockedCompany(j); });
    };

    let allJobs = [];
    let liveSearchDone = false;
    if (jobId) {
      const one = jobDb.findById(jobId);
      if (one) allJobs = [one];
    } else {
      allJobs = jobDb.search({ limit: 200 }).filter(function (j) { return !j.status || j.status === "active"; });
      allJobs = allJobs.filter(function (j) { return !isBlockedCompany(j); });
      if (filterCity) allJobs = allJobs.filter(function (j) { return (j.city || "").includes(filterCity); });
    }

    if (allJobs.length === 0 && !jobId && !isApplyDryRun()) {
      liveLog.add(`数据库为空，实时搜索 ${platform.name}...`);
      try {
        allJobs = await searchLiveJobs();
        liveSearchDone = true;
        if (filterCity) allJobs = allJobs.filter(function (j) { return (j.city || "").includes(filterCity); });
      } catch (e) {
        liveSearchDone = true;
        liveLog.add("实时搜索失败: " + (e.message || "").slice(0, 80));
      }
    } else if (allJobs.length === 0 && !jobId && isApplyDryRun()) {
      liveLog.add("[dry-run] 数据库无职位，跳过实时搜索（不触碰浏览器）");
      liveSearchDone = true;
    }

    if (allJobs.length === 0 && filterCity && !jobId) {
      liveLog.add("当前城市无职位，不跨城市投递");
    }

    let skippedApplied = 0;
    const appliedIds = new Set(applicationDb.findAll().map(function (a) { return a.jobId; }));
    if (skipApplied && !jobId) {
      const before = allJobs.length;
      allJobs = allJobs.filter(function (j) { return !appliedIds.has(j.id); });
      skippedApplied = before - allJobs.length;
      if (skippedApplied > 0) liveLog.add(`跳过已投递职位: ${skippedApplied} 个`);
    }

    if (skipApplied && !jobId && allJobs.length === 0 && !liveSearchDone && !dryRun) {
      liveLog.add("当前可投递职位已投递完，实时搜索新职位...");
      try {
        allJobs = await searchLiveJobs();
        if (filterCity) allJobs = allJobs.filter(function (j) { return (j.city || "").includes(filterCity); });
        const before = allJobs.length;
        allJobs = allJobs.filter(function (j) { return !appliedIds.has(j.id); });
        skippedApplied += before - allJobs.length;
      } catch (e) {
        liveLog.add("实时搜索失败: " + (e.message || "").slice(0, 80));
      }
    }

    if (filterDistrict && !jobId) {
      const before = allJobs.length;
      allJobs = allJobs.filter(function (j) {
        return (j.district || "").toLowerCase().includes(filterDistrict.toLowerCase());
      });
      liveLog.add(`区域过滤: ${before} -> ${allJobs.length} (${filterDistrict})`);
    }

    const keywords = filterKeywords.split(/[,，\/]/).map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
    if (keywords.length > 0 && !jobId) {
      const before = allJobs.length;
      allJobs = allJobs.filter(function (j) {
        const combined = ((j.title || "") + " " + (j.technologies || "") + " " + (j.description || "")).toLowerCase();
        return keywords.some(function (kw) { return combined.includes(kw); });
      });
      liveLog.add(`关键词过滤: ${before} -> ${allJobs.length}`);
    } else if (!jobId) {
      // 没传关键词时按"主投方向"兜底（签字口径：过渡岗为主）。否则后厨/护工这类
      // 只因离家近而够分的岗位会挤进待确认队列，一键放行就成了乱投。
      const dir = directionKeywords();
      const before = allJobs.length;
      allJobs = allJobs.filter(function (j) { return matchesDirection(j, dir); });
      liveLog.add(`主投方向兜底过滤: ${before} -> ${allJobs.length}（${dir.join("/")}；可在关键词框或 .env JOB_AGENT_DIRECTION_KEYWORDS 覆盖）`);
    }

    const profile = getProfile();
    const greeting = body?.greeting || profile.greeting || "";
    const scored = allJobs.map(function (j) {
      const s = scoreJob(j, profile);
      try { jobDb.update(j.id, { score: s.score }); } catch (e) {}
      return { job: j, match: s.score / 100, score: s.score, salaryRank: s.salaryRank, salaryStatus: s.salaryStatus, matchedSkills: s.matchedSkills, missingSkills: s.missingSkills };
    });

    // ── M2-A 决策真拦截：按 decideJob 分桶，IGNORE 剔除、REVIEW 入待确认队列 ──
    // 阈值：沿用 decideJob 自身的 REVIEW 地板 30（minMatch=0 时仍能产生 IGNORE），
    // 用户显式抬高 minMatch 时以 minMatch 为准。
    const reviewThreshold = Math.max(Math.round(minMatch * 100), REVIEW_FLOOR);
    // 分桶统一走 partitionByDecision（内部以 3 参调用 decideJob，档位/宿舍由 M1 内部读取）。
    const buckets = partitionByDecision(scored, reviewThreshold);
    const decisions = { AUTO_APPLY: buckets.auto.length, REVIEW: buckets.review.length, IGNORE: buckets.ignore.length };

    if (buckets.ignore.length > 0) {
      liveLog.add(`决策剔除(IGNORE): ${buckets.ignore.length} 个岗位低于 ${reviewThreshold} 分，不进入投递集合`);
      buckets.ignore.slice(0, 10).forEach(function (s) {
        liveLog.add(`  IGNORE #${s.job.id} ${String(s.job.title || "").slice(0, 24)} -> ${s.reason}`);
      });
      if (buckets.ignore.length > 10) liveLog.add(`  ... 其余 ${buckets.ignore.length - 10} 条 IGNORE 理由略`);
    }
    let reviewEnqueued = 0;
    if (!jobId) {
      buckets.review.forEach(function (s) {
        try {
          reviewQueue.enqueue({ jobId: s.job.id, score: s.score, decision: s.decision, reason: s.reason });
          reviewEnqueued++;
        } catch (e) {
          liveLog.add("待确认队列写入失败(job " + s.job.id + "): " + (e.message || "").slice(0, 80));
        }
      });
      if (reviewEnqueued > 0) liveLog.add(`决策转待确认(REVIEW): ${reviewEnqueued} 个岗位进入待确认队列，不自动投递`);
    }

    // 投递集合：批量流 = AUTO_APPLY 桶 + 待确认队列中人工已放行的岗位；
    // 指定 jobId 属人工显式动作，直接投递（分桶仅记录，不拦截）。
    // 放行岗位只"窥视"(findApproved)，真正进入本次执行集合后才 markConsumed，
    // 防止 dry-run 或 limit/配额截断把放行记录吞掉。
    let applyCandidates;
    const candidateIds = new Set();
    if (jobId) {
      applyCandidates = scored.slice();
      applyCandidates.forEach(function (s) { candidateIds.add(s.job.id); });
    } else {
      applyCandidates = buckets.auto.slice();
      buckets.auto.forEach(function (s) { candidateIds.add(s.job.id); });
      const approved = reviewQueue.findApproved();
      let revived = 0;
      approved.forEach(function (row) {
        if (candidateIds.has(row.jobId)) return;
        const j = jobDb.findById(row.jobId);
        if (!j || (j.status && j.status !== "active") || isBlockedCompany(j)) return;
        const s = scoreJob(j, profile);
        applyCandidates.push({ job: j, match: s.score / 100, score: s.score, salaryRank: s.salaryRank, salaryStatus: s.salaryStatus, approvedFromQueue: true, __reviewId: row.id });
        candidateIds.add(j.id);
        revived++;
      });
      if (revived > 0) liveLog.add(`待确认已放行: ${revived} 个岗位转入本次投递集合`);
    }

    const sortedCandidates = sortJobsForApplyWithDistance(applyCandidates).slice(0, limit);
    const jobs = sortedCandidates.map(function (s) {
      const techs = (s.job.technologies || "").split(",").map(function (x) { return x.trim(); }).filter(Boolean);
      const resume = resumeDb.findBestMatch(techs);
      return Object.assign({}, s.job, {
        companyName: getJobCompanyName(s.job),
        resumeId: resume ? resume.id : null,
        __decisionScore: s.score,
        __reviewId: s.__reviewId || null,
      });
    });

    // ── M2-B 节奏控制：当日剩余配额 + 随机时间轴计划（dryRun 已在入口判定）──
    let plan = null;
    let quotaInfo = null;
    if (jobs.length > 0) {
      let appliedToday = 0;
      try { appliedToday = countAppliedToday(applicationDb.findAll()); } catch (e) {}
      quotaInfo = schedulerConfig({ appliedToday });
      plan = planSchedule(jobs, { now: new Date(), quota: quotaInfo.quota, appliedToday: appliedToday });
    }

    if (jobs.length === 0) {
      json(res, { ok: true, applied: 0, total: 0, skippedApplied: skippedApplied, decisions: decisions, message: "没有可自动投递的职位（城市=" + filterCity + " 区域=" + filterDistrict + " 关键词=" + filterKeywords + "）；REVIEW 岗位已入待确认队列 " + reviewEnqueued + " 个" });
      return;
    }

    liveLog.add(`已排除黑名单公司: ${(platform.blockedCompanies || []).join(", ")}`);
    liveLog.add(`决策分桶: 自动投递 ${decisions.AUTO_APPLY} / 待确认 ${decisions.REVIEW} / 忽略 ${decisions.IGNORE}`);

    if (dryRun) {
      const report = plan ? dryRunReport(plan) : "无可投递岗位";
      liveLog.add(`[dry-run] APPLY_DRY_RUN=true，仅生成节奏计划，不执行真实打招呼（候选 ${jobs.length} 单，计划 ${plan ? plan.planned : 0} 单）`);
      report.split("\n").forEach(function (line) { liveLog.add("[dry-run] " + line); });
      json(res, {
        ok: true,
        dryRun: true,
        applied: 0,
        planned: plan ? plan.planned : 0,
        total: jobs.length,
        skippedQuota: plan ? plan.skippedQuota : 0,
        skippedApplied: skippedApplied,
        decisions: decisions,
        quota: quotaInfo ? { total: quotaInfo.quota, appliedToday: quotaInfo.appliedToday, remaining: Math.max(0, quotaInfo.quota - quotaInfo.appliedToday) } : null,
        schedule: plan ? { startMs: plan.startMs, endMs: plan.endMs, items: plan.items.map(function (it) { return { jobId: it.job.id, title: it.job.title, at: it.atISO, gapMs: it.gapMs, longRestBefore: it.longRestBefore }; }) } : null,
        report: report,
      });
      return;
    }

    // 真实投递：需要浏览器已连接（上方入口处已做过连接与登录校验，dry-run 不会走到这里）
    if (!mgr.browser?.connected) {
      json(res, { ok: false, error: "浏览器未连接，请先连接浏览器" }, 400);
      return;
    }

    const throttle = throttleOptions(plan, { delayMin: delayMin, delayMax: delayMax });
    // 真正开始投递：只对进入本次执行计划的放行记录标记 consumed；
    // 被 limit/配额截断在计划之外的保持 approved，下次投递重试。
    if (plan && plan.items && plan.items.length > 0) {
      plan.items.forEach(function (it) {
        const rid = it.job && it.job.__reviewId;
        if (Number.isFinite(rid)) {
          try { reviewQueue.markConsumed(rid); } catch (e) {}
        }
      });
    }
    liveLog.add(`筛选出 ${jobs.length} 个职位，节奏计划 ${plan ? plan.planned : 0} 单，随机延迟 ${throttle.delayMin}-${throttle.delayMax} 秒，开始投递`);
    if (plan && plan.planned > 0) {
      liveLog.add(`节奏: ${new Date(plan.startMs).toLocaleTimeString()} → ${new Date(plan.endMs).toLocaleTimeString()}，长休息 ${plan.items.filter(function (it) { return it.longRestBefore; }).length} 处`);
    }

    b.running = true;
    state.running = true;
    state.progress = { current: 0, total: jobs.length, title: "", step: "准备中" };
    try {
      const result = await b.autoApply(jobs, {
        minMatch: minMatch,
        delayMin: throttle.delayMin,
        delayMax: throttle.delayMax,
        greeting: greeting,
        profile: profile,
        sendResume: body?.sendResume !== false,
        sendResumeScreenshot: body?.sendResumeScreenshot !== false,
        onProgress: function (p) { state.progress = p; },
      });
      state.appliedCount += (result.applied || 0);
      json(res, {
        ok: true,
        applied: result.applied || 0,
        failed: result.failed || 0,
        skippedApplied: (result.skipped || 0) + skippedApplied,
        total: jobs.length,
        decisions: decisions,
        results: result.results || [],
      });
    } finally {
      b.running = false;
      state.running = false;
      await savePlatformCookies().catch(function () {});
    }
  } catch (e) {
    state.lastError = e.message;
    liveLog.add("投递异常: " + (e.message || "").slice(0, 120));
    json(res, { ok: false, error: e.message }, 500);
  }
}

// ─── M2-A 待确认队列 API ───
// GET /api/review：列出 pending（岗位摘要 + 决策理由）与已放行数量
export function handleReviewList(req, res) {
  try {
    reviewQueue.ensureTable();
    const rows = reviewQueue.findPending();
    const profile = getProfile();
    const items = rows.map(function (r) {
      const j = jobDb.findById(r.jobId);
      const s = j ? scoreJob(j, profile) : null;
      return {
        id: r.id,
        jobId: r.jobId,
        score: r.score,
        decision: r.decision,
        reason: r.reason || "",
        status: r.status,
        createdAt: r.createdAt,
        job: j ? {
          id: j.id,
          title: j.title,
          companyName: getJobCompanyName(j),
          city: j.city || "",
          district: j.district || "",
          salaryRaw: j.salaryRaw || "",
          technologies: j.technologies || "",
          url: j.url || "",
          status: j.status || "active",
        } : null,
        liveScore: s ? s.score : null,
        // 经验相关度：来自《个人真实能力地图》的能力词命中数（排序用，不进总分）
        relevance: j ? experienceRelevance(j) : 0,
      };
    });
    // 先按经验相关度、再按分数排，让"跟我经历沾边"的岗位排在最上面
    items.sort(function (a, b) {
      if ((b.relevance || 0) !== (a.relevance || 0)) return (b.relevance || 0) - (a.relevance || 0);
      return (b.liveScore || 0) - (a.liveScore || 0);
    });
    const stats = reviewQueue.countByStatus();
    json(res, { ok: true, review: items, pending: items.length, approved: stats.approved || 0, stats: stats });
  } catch (e) {
    json(res, { ok: false, error: e.message }, 500);
  }
}

// POST /api/review/approve  body {id}：批准后转入下次投递集合
export function handleReviewApprove(req, res, body) {
  try {
    reviewQueue.ensureTable();
    const id = Number(body?.id);
    if (!Number.isFinite(id) || id <= 0) {
      json(res, { ok: false, error: "id 无效" }, 400);
      return;
    }
    const row = reviewQueue.findById(id);
    if (!row) {
      json(res, { ok: false, error: "待确认记录不存在" }, 404);
      return;
    }
    if (row.status !== "pending") {
      json(res, { ok: false, error: "记录状态为 " + row.status + "，不能重复批准" }, 409);
      return;
    }
    reviewQueue.approve(id);
    liveLog.add(`待确认队列: 放行 #${id} (job ${row.jobId}, score ${row.score})，将进入下次投递`);
    json(res, { ok: true, review: reviewQueue.findById(id) });
  } catch (e) {
    json(res, { ok: false, error: e.message }, 500);
  }
}

// POST /api/review/approve-all  body {minScore?}：一键放行全部待确认（用户不想逐条点时用）。
// minScore 给了就只放行分数达标的；返回实际放行条数。
export function handleReviewApproveAll(req, res, body) {
  try {
    reviewQueue.ensureTable();
    const minScore = Number(body?.minScore);
    let rows = reviewQueue.findPending();
    if (Number.isFinite(minScore)) rows = rows.filter((r) => Number(r.score) >= minScore);
    for (const row of rows) reviewQueue.approve(row.id);
    liveLog.add(`待确认队列: 一键放行 ${rows.length} 个，将进入下次投递`);
    json(res, { ok: true, approved: rows.length });
  } catch (e) {
    json(res, { ok: false, error: e.message }, 500);
  }
}

// POST /api/review/auto-approve  body {minScore?, max?}
// 无人值守自动放行：只挑"人大概率会点头"的待确认岗位放进投递集合，是保守闸门而非全量放行。
// 闸门（全部满足才放行）：岗位 active ∧ 距离档 CORE/NEAR（≤15km，可通勤）∧ 命中主投方向关键词
// ∧ 未拉黑公司 ∧ score ≥ 门槛（默认 55，JOB_AGENT_AUTO_APPROVE_MIN 可覆盖）。
// 每轮上限 max（默认 25，JOB_AGENT_AUTO_APPROVE_MAX），避免一次把积压全放行、投递节奏过猛。
// UNKNOWN 档不自动放行（未 enrich 数据本就该人工看）；FAR 不自动放行（通勤成本，尊重用户距离偏好）。
export function handleReviewAutoApprove(req, res, body) {
  try {
    reviewQueue.ensureTable();
    const minScore = Number(body?.minScore ?? process.env.JOB_AGENT_AUTO_APPROVE_MIN) || 55;
    const maxN = Number(body?.max ?? process.env.JOB_AGENT_AUTO_APPROVE_MAX) || 25;
    const dir = directionKeywords();
    const profile = getProfile();
    const rows = reviewQueue.findPending();
    let approved = 0, considered = 0;
    const approvedIds = [];
    for (const row of rows) {
      if (approved >= maxN) break;
      considered++;
      const j = jobDb.findById(row.jobId);
      if (!j || (j.status && j.status !== "active")) continue;
      if (isBlockedCompany(j)) continue;
      const s = scoreJob(j, profile);
      if (s.distanceTier !== "CORE" && s.distanceTier !== "NEAR") continue;
      if (!matchesDirection(j, dir)) continue;
      if (s.score < minScore) continue;
      reviewQueue.approve(row.id);
      approved++;
      approvedIds.push(row.id);
    }
    liveLog.add(`无人值守自动放行: ${approved} 个（考察 ${considered} 个待确认，门槛 CORE/NEAR+方向+≥${minScore} 分、单轮上限 ${maxN}），将进入下次投递`);
    json(res, { ok: true, approved, considered, ids: approvedIds });
  } catch (e) {
    json(res, { ok: false, error: e.message }, 500);
  }
}

// POST /api/review/reject  body {id}
export function handleReviewReject(req, res, body) {
  try {
    reviewQueue.ensureTable();
    const id = Number(body?.id);
    if (!Number.isFinite(id) || id <= 0) {
      json(res, { ok: false, error: "id 无效" }, 400);
      return;
    }
    const row = reviewQueue.findById(id);
    if (!row) {
      json(res, { ok: false, error: "待确认记录不存在" }, 404);
      return;
    }
    if (row.status !== "pending") {
      json(res, { ok: false, error: "记录状态为 " + row.status + "，不能重复处理" }, 409);
      return;
    }
    reviewQueue.reject(id);
    liveLog.add(`待确认队列: 拒绝 #${id} (job ${row.jobId})`);
    json(res, { ok: true, review: reviewQueue.findById(id) });
  } catch (e) {
    json(res, { ok: false, error: e.message }, 500);
  }
}

export async function handleChatStart(req, res, body) {
  try {
    const mgr = getManager();
    if (!mgr.browser?.connected) {
      json(res, { ok: false, error: "浏览器未连接" }, 400);
      return;
    }
    logProviderWarning(liveLog);
    const b = getBot();
    let requestedResume = null;
    if (body?.resumeId) {
      requestedResume = resumeDb.findById(Number(body.resumeId));
      if (!requestedResume) {
        json(res, { ok: false, error: "未找到指定简历" }, 400);
        return;
      }
      resumeDb.update(requestedResume.id, { isDefault: true });
    }
    // b._checking：stop() 只置 running=false，旧轮 check 可能仍在 sendReply 中执行；
    // 此时启动新监控会与旧轮并发驱动同一页面，返回 409 等旧 check 结束再启动。
    if (b.running || state.running || state.chatActive || state.replying || b._checking) {
      json(res, { ok: false, error: "已有任务运行中，请先停止", busy: true }, 409);
      return;
    }
    b.running = true;
    state.chatActive = true;
    const once = body?.once === true;
    const resetChatState = () => {
      b.running = false;
      state.chatActive = false;
      state.replying = false;
      state.status = "idle";
    };
    const startMonitor = () => b.monitorChat(async (chat, ctx) => {
      recordChatTranscript(chat); // 留档原话，供"面试要点摘要"抽取时间/地点/薪资
      const profile = getProfile() || {};
      const skills = profile?.skills || "";
      const name = profile?.name || "用户";
      const app = b._findApplicationForChat(chat);
      const job = app?.jobId ? jobDb.findById(app.jobId) : null;
      const resume = b._findResumeForChat(chat);
      const resumeEditor = loadResumeEditor(profile);
      const expectedSalary = String(resumeEditor?.expectedSalary ?? "");
      const safeResumeText = buildSafeResumeText({
        profile,
        resume,
        resumeEditor,
        expectedSalary,
      });
      const reply = await b.generateReply(chat.msg, name, skills, {
        profile,
        job,
        resume,
        resumeEditor,
        safeResumeText,
        chatText: chat.text || "",
        expectedSalary,
        onWarning: (msg) => liveLog.add(msg),
      });
      if (reply && reply.needManual) return reply;
      // 传入 monitorChat 本轮代际：stop()/重启后旧 sendReply 会在关键步骤间检测到
      // 代际失效而停止驱动页面，避免新旧两轮并发驱动同一页面。
      return await b.sendReply(chat.name, reply, chat, { generation: ctx?.generation });
    }, body?.interval || 30000, {
      autoReply: body?.autoReply !== false,
      sendResume: body?.sendResume !== false,
      sendResumeScreenshot: body?.sendResumeScreenshot !== false,
      once,
      // 运行期致命错误（浏览器断开/页面关闭）：monitorChat 已复位 b.running，这里复位
      // state 各锁并记录日志，否则 state.chatActive 残留 true，后续所有任务入口都会 409。
      onFatal: (e) => {
        b.running = false;
        state.running = false;
        state.chatActive = false;
        state.replying = false;
        state.status = "idle";
        liveLog.add("聊天监控异常终止: " + (e?.message || "").slice(0, 120));
      },
    });

    if (once) {
      try {
        const result = await startMonitor();
        resetChatState();
        const stats = result || { scanned: 0, replied: 0, failed: 0, manual: 0, resumeSent: 0 };
        // 旧服务端（升级中/未重启）可能不带 failed：缺失时按 scanned-replied-manual 估算，
        // 宁可多报也不让"回复 0 条"再冒充"一切正常"。
        const failedN = Number.isFinite(stats.failed)
          ? stats.failed
          : Math.max(0, (stats.scanned || 0) - (stats.replied || 0) - (stats.manual || 0));
        liveLog.add(`[chat] once scan done: scanned=${stats.scanned} replied=${stats.replied} failed=${failedN} manual=${stats.manual} resumeSent=${stats.resumeSent}`);
        json(res, { ok: true, message: "once_chat_scan_done", ...stats, failed: failedN });
      } catch (e) {
        state.lastError = e.message;
        resetChatState();
        liveLog.add("[chat] once scan failed: " + (e.message || "").slice(0, 120));
        json(res, { ok: false, error: e.message }, 500);
      }
      return;
    }

    startMonitor().catch((e) => {
      state.lastError = e.message;
      // 首轮启动失败（如 _getPage 抛错、浏览器中途断开）必须复位全部锁，否则
      // b.running 残留 true，后续所有任务入口都会 409；state.replying 也要复位避免假锁。
      // 同时把状态置回 idle 并记录 liveLog，避免前端误以为监控已启动。
      resetChatState();
      liveLog.add("聊天监控启动失败: " + (e.message || "").slice(0, 120));
    });
    json(res, { ok: true, message: "连接成功" });
  } catch (e) {
    json(res, { ok: false, error: e.message }, 500);
  }
}

export function logProviderWarning(logger = liveLog) {
  const config = getProviderConfig();
  if (config.warning && typeof logger?.add === "function") {
    logger.add(config.warning);
  }
  return config.warning || null;
}

export async function handleChatReply(req, res, body) {
  try {
    const mgr = getManager();
    if (!mgr.browser?.connected) {
      json(res, { ok: false, error: "浏览器未连接" }, 400);
      return;
    }
    const text = String(body?.text || body?.message || "").trim();
    if (!text) {
      json(res, { ok: false, error: "回复内容为空" }, 400);
      return;
    }
    const b = getBot();
    // b._checking：stop() 只置 running=false，旧轮 check 可能仍在 sendReply 中执行；
    // 此时手动回复会与旧轮并发驱动同一页面（旧轮可能正点到发送按钮），返回 409 等旧 check 结束。
    if (b.running || state.running || state.chatActive || state.replying || b._checking) {
      json(res, { ok: false, busy: true, error: "已有任务运行中" }, 409);
      return;
    }
    const hrName = String(body?.hrName || body?.name || "").trim();
    state.replying = true;
    try {
      const result = await b.sendReply(hrName, text, body?.chat || null);
      json(res, { ok: !!result?.ok, ...result });
    } finally {
      state.replying = false;
    }
  } catch (e) {
    json(res, { ok: false, error: e.message }, 500);
  }
}

export async function handleChatSendResume(req, res, body) {
  try {
    const mgr = getManager();
    if (!mgr.browser?.connected) {
      json(res, { ok: false, error: "浏览器未连接" }, 400);
      return;
    }
    const b = getBot();
    if (b.running || state.running || state.chatActive || state.replying || b._checking) {
      json(res, { ok: false, busy: true, error: "已有任务运行中" }, 409);
      return;
    }
    const resume = body?.resumeId
      ? resumeDb.findById(Number(body.resumeId))
      : resumeDb.findDefault() || resumeDb.findAll()[0];
    if (!resume) {
      json(res, { ok: false, error: "未找到可发送的简历" }, 400);
      return;
    }
    resumeDb.update(resume.id, { isDefault: true });
    b.running = true;
    state.replying = true;
    try {
      const result = await b._sendResumeForChat(body?.chat || null, resume, {
        generation: b.generation,
        sendResumeScreenshot: body?.sendResumeScreenshot !== false,
      });
      json(res, { ok: !!result?.ok, ...result });
    } finally {
      b.running = false;
      state.replying = false;
    }
  } catch (e) {
    json(res, { ok: false, error: e.message }, 500);
  }
}

export function handleChatStop(req, res) {
  if (bot) bot.stop();
  // 不复位进行中的回复锁 state.replying：若回复正在浏览器里执行，提前置 false
  // 会让新请求与进行中的回复并发驱动同一页面。state.replying 由 handleChatReply 的
  // finally 复位；这里不复位是为了避免进行中回复与后续请求并发。
  state.chatActive = false;
  state.running = false;
  state.status = "idle";
  json(res, { ok: true });
}

export async function handleFeedbackSync(req, res) {
  try {
    const mgr = getManager();
    if (!mgr.browser?.connected) {
      json(res, { ok: false, error: "浏览器未连接" }, 400);
      return;
    }
    const b = getBot();
    if (b.running || state.running || state.chatActive || state.replying || b._checking) {
      json(res, { ok: false, error: "已有任务运行中，请先停止", busy: true }, 409);
      return;
    }
    const result = await b.syncFeedback();
    liveLog.add(`反馈同步完成: 扫描 ${result.scanned} 个会话，更新 ${result.updatedCount} 条`);
    json(res, { ok: true, ...result });
  } catch (e) {
    state.lastError = e.message;
    liveLog.add("反馈同步异常: " + (e.message || "").slice(0, 120));
    json(res, { ok: false, error: e.message }, 500);
  }
}

function json(res, data, status) {
  res.writeHead(status || 200, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data));
}

export function handleGetMessages(req, res) {
  var idx = parseInt(new URL(req.url, "http://localhost").searchParams.get("after") || "0");
  var newMsgs = messages.filter(function (m) { return m.id > idx; });
  json(res, { messages: newMsgs, lastId: messages.length ? messages[messages.length - 1].id : 0 });
}
