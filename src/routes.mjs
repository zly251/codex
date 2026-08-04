import * as jobDb from "./db/job.js";
import * as companyDb from "./db/company.js";
import * as applicationDb from "./db/application.js";
import * as resumeDb from "./db/resume.js";
import { BrowserManager } from "./browser/browserManager.js";
import * as liveLog from "./log.js";
import { findEdgePath, launchEdge, waitForCDP, DEFAULT_PROFILE, FALLBACK_PROFILE } from "./edgeLauncher.js";
import { scoreJob, decideJob } from "./scoring.js";
import { getPlatform } from "./platforms/index.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = (function(){ try { return path.dirname(fileURLToPath(import.meta.url)); } catch (e) { return process.cwd(); } })();
const PROJECT_ROOT = process.env.JOB_AGENT_ROOT || path.join(__dirname, "..");

let browserManager = null;
let scraper = null;
let bot = null;

var messages = [];
try {
  var _msgPath = path.join(PROJECT_ROOT, "data", "chat.json");
  if (fs.existsSync(_msgPath)) messages = JSON.parse(fs.readFileSync(_msgPath, "utf8"));
} catch (e) {}

var state = {
  status: "idle",
  lastSearch: null,
  lastError: null,
  appliedCount: 0,
  chatActive: false,
  applyStatus: null,
  running: false,
  progress: null,
};
var PROFILE_PATH = process.env.JOB_AGENT_PROFILE_PATH || path.join(PROJECT_ROOT, "data", "profile.json");
const platform = getPlatform();
var cookieWatcher = null;

async function savePlatformCookies() {
  try {
    const result = await platform.saveCookies(getManager(), PROJECT_ROOT);
    if (result?.saved) liveLog.add(`${platform.name} 登录 Cookie 已备份 (${result.count} 条)`);
  } catch (e) {}
}

async function restorePlatformCookies() {
  try {
    const result = await platform.restoreCookies(getManager(), PROJECT_ROOT);
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

export function getStatus() {
  return {
    ...state,
    browserConnected: browserManager?.browser?.connected || false,
    logs: liveLog.list(60),
  };
}

async function ensureEdgeLaunched(host, port) {
  const exe = findEdgePath();
  if (!exe) throw new Error("未找到 Edge，请先安装 Microsoft Edge");
  try {
    await waitForCDP(host, port, 2000);
    return true;
  } catch (e) {}
  const profiles = [DEFAULT_PROFILE, FALLBACK_PROFILE].filter(function (dir) {
    try {
      return fs.existsSync(path.join(dir, "Default", "Cookies")) ||
        fs.existsSync(path.join(dir, "Default", "Network", "Cookies"));
    } catch (e) { return false; }
  });
  if (profiles.length === 0) profiles.push(DEFAULT_PROFILE);
  let lastErr = null;
  for (const dir of profiles) {
    try {
      liveLog.add("自动启动浏览器: " + exe);
      await launchEdge({ profileDir: dir, host, port });
      await waitForCDP(host, port, 20000);
      liveLog.add("浏览器 CDP 端口已就绪");
      return true;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error("浏览器启动失败: " + (lastErr?.message || ""));
}

export async function handleLaunch(req, res, body) {
  try {
    const mgr = getManager();
    const host = body?.host || "127.0.0.1";
    const port = body?.port || 9222;
    if (mgr.browser?.connected) {
      json(res, { ok: true, launched: false, message: "Edge 已连接" });
      return;
    }
    try {
      await mgr.connect(host, port);
      await afterBrowserConnect();
      json(res, { ok: true, launched: false, message: "Edge 已连接" });
      return;
    } catch (e) {}
    await ensureEdgeLaunched(host, port);
    await mgr.connect(host, port);
    await afterBrowserConnect();
    state.status = "connected";
    json(res, { ok: true, launched: true, message: "Edge 已启动并连接" });
  } catch (e) {
    state.lastError = e.message;
    json(res, { ok: false, error: e.message }, 400);
  }
}

export async function handleConnect(req, res, body) {
  try {
    const mgr = getManager();
    const host = body?.host || "127.0.0.1";
    const port = body?.port || 9222;
    let connected = false;
    for (let i = 0; i < 5; i++) {
      try {
        await mgr.connect(host, port);
        connected = true;
        break;
      } catch (e) {
        if (i < 4) await new Promise((r) => setTimeout(r, 1500));
      }
    }
    if (!connected) {
      liveLog.add("CDP 未就绪，自动启动 Edge");
      await ensureEdgeLaunched(host, port);
      await mgr.connect(host, port);
    }
    await afterBrowserConnect();
    state.status = "connected";
    json(res, { ok: true, message: "连接成功" });
  } catch (e) {
    state.lastError = e.message;
    json(res, { ok: false, error: e.message }, 400);
  }
}

export async function handleSearch(req, res, body) {
  try {
    const s = getScraper();
    const mgr = getManager();
    if (!mgr.browser?.connected) {
      json(res, { ok: false, error: "浏览器未连接，请先连接 Edge", hint: "请先连接浏览器" }, 400);
      return;
    }
    state.status = "searching";
    const keyword = body?.keyword || "C++";
    const city = body?.city || "";
    const pages = body?.pages || 3;
    liveLog.add(`开始搜索: ${keyword} ${city || "全国"} ${pages} 页`);
    const jobs = await s.searchJobs({ keyword, city, pages });
    if (jobs.length > 0) {
      await s.saveJobs(jobs, jobDb, companyDb);
    }
    state.lastSearch = { keyword, city, pages, count: jobs.length };
    state.status = jobs.length > 0 ? "found" : "empty";
    liveLog.add(`搜索完成: 找到 ${jobs.length} 个职位`);
    json(res, { ok: true, count: jobs.length, jobs: jobs.slice(0, 50) });
  } catch (e) {
    state.status = "error";
    state.lastError = e.message;
    liveLog.add("搜索失败: " + (e.message || "").slice(0, 120));
    json(res, { ok: false, error: e.message }, 500);
  }
}

export async function handleApply(req, res, body) {
  try {
    const mgr = getManager();
    const b = getBot();
    if (b.running || state.running || state.chatActive) {
      json(res, { ok: false, error: "已有投递任务运行中，请先停止", busy: true }, 409);
      return;
    }
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
    const jobId = body?.jobId ? Number(body.jobId) : null;
    const limit = body?.limit || 99;
    const minMatch = (body?.minMatch ?? 0) / 100;
    const filterCity = body?.city || "";
    const filterDistrict = body?.district || "";
    const filterKeywords = body?.keywords || "";
    const delayMin = Number(body?.delayMin ?? 8) || 8;
    const delayMax = Number(body?.delayMax ?? 25) || 25;

    let allJobs = [];
    if (jobId) {
      const one = jobDb.findById(jobId);
      if (one) allJobs = [one];
    } else {
      allJobs = jobDb.search({ limit: 200 }).filter(function (j) { return !j.status || j.status === "active"; });
      allJobs = allJobs.filter(function (j) { return !isBlockedCompany(j); });
      if (filterCity) allJobs = allJobs.filter(function (j) { return (j.city || "").includes(filterCity); });
    }

    if (allJobs.length === 0 && !jobId) {
      liveLog.add(`数据库为空，实时搜索 ${platform.name}...`);
      try {
        const s = getScraper();
        const kw = filterKeywords.split(/[,\u3001\/]/).map(function (x) { return x.trim(); }).filter(function (x) { return x; })[0] || "C++";
        const liveJobs = await s.searchJobs({ keyword: kw, pages: 3 });
        const liveJobsFiltered = liveJobs.filter(function (j) { return !isBlockedCompany(j); });
        if (liveJobsFiltered.length > 0) {
          await s.saveJobs(liveJobsFiltered, jobDb, companyDb);
          allJobs = jobDb.search({ limit: 200 }).filter(function (j) { return !j.status || j.status === "active"; });
          allJobs = allJobs.filter(function (j) { return !isBlockedCompany(j); });
          if (filterCity) allJobs = allJobs.filter(function (j) { return (j.city || "").includes(filterCity); });
        }
      } catch (e) {
        liveLog.add("实时搜索失败: " + (e.message || "").slice(0, 80));
      }
    }

    if (allJobs.length === 0 && filterCity && !jobId) {
      liveLog.add("当前城市无职位，回退到全部城市");
      allJobs = jobDb.search({ limit: 200 }).filter(function (j) { return !j.status || j.status === "active"; });
      allJobs = allJobs.filter(function (j) { return !isBlockedCompany(j); });
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
    }

    const profile = getProfile();
    const scored = allJobs.map(function (j) {
      const s = scoreJob(j, profile);
      try { jobDb.update(j.id, { score: s.score }); } catch (e) {}
      return { job: j, match: s.score / 100, score: s.score };
    });

    const decisions = { AUTO_APPLY: 0, REVIEW: 0, IGNORE: 0 };
    scored.forEach(function (s) {
      decisions[decideJob(s.score, minMatch * 100)]++;
    });

    const jobs = scored
      .filter(function (s) { return s.match >= minMatch; })
      .sort(function (a, b) { return b.match - a.match; })
      .slice(0, limit)
      .map(function (s) {
        const techs = (s.job.technologies || "").split(",").map(function (x) { return x.trim(); }).filter(Boolean);
        const resume = resumeDb.findBestMatch(techs);
        return Object.assign({}, s.job, { resumeId: resume ? resume.id : null });
      });

    if (jobs.length === 0) {
      json(res, { ok: true, applied: 0, total: 0, message: "没有匹配的职位（城市=" + filterCity + " 区域=" + filterDistrict + " 关键词=" + filterKeywords + "）" });
      return;
    }

    liveLog.add(`已排除黑名单公司: ${(platform.blockedCompanies || []).join(", ")}`);
    liveLog.add(`筛选出 ${jobs.length} 个职位，随机延迟 ${delayMin}-${delayMax} 秒，开始投递`);
    liveLog.add(`决策: 自动投递 ${decisions.AUTO_APPLY} / 待确认 ${decisions.REVIEW} / 忽略 ${decisions.IGNORE}`);

    b.running = true;
    state.running = true;
    state.progress = { current: 0, total: jobs.length, title: "", step: "准备中" };
    try {
      const result = await b.autoApply(jobs, {
        minMatch: minMatch,
        delayMin: delayMin,
        delayMax: delayMax,
        onProgress: function (p) { state.progress = p; },
      });
      state.appliedCount += (result.applied || 0);
      json(res, {
        ok: true,
        applied: result.applied || 0,
        failed: result.failed || 0,
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

export async function handleChatStart(req, res, body) {
  try {
    const mgr = getManager();
    if (!mgr.browser?.connected) {
      json(res, { ok: false, error: "浏览器未连接" }, 400);
      return;
    }
    const b = getBot();
    if (b.running || state.running || state.chatActive) {
      json(res, { ok: false, error: "已有任务运行中，请先停止", busy: true }, 409);
      return;
    }
    b.running = true;
    state.chatActive = true;
    b.monitorChat(async (chat) => {
      const profile = getProfile();
      const skills = profile?.skills || "";
      const name = profile?.name || "用户";
      const reply = await b.generateReply(chat.msg, name, skills);
      await b.sendReply(chat.name, reply);
    }, body?.interval || 30000).catch((e) => {
      state.lastError = e.message;
      state.chatActive = false;
    });
    json(res, { ok: true, message: "连接成功" });
  } catch (e) {
    json(res, { ok: false, error: e.message }, 500);
  }
}

export function handleChatStop(req, res) {
  if (bot) bot.stop();
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
    if (b.running || state.running || state.chatActive) {
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
  res.writeHead(status || 200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data));
}

export function handleGetMessages(req, res) {
  var idx = parseInt(new URL(req.url, "http://localhost").searchParams.get("after") || "0");
  var newMsgs = messages.filter(function (m) { return m.id > idx; });
  json(res, { messages: newMsgs, lastId: messages.length ? messages[messages.length - 1].id : 0 });
}

export async function handleSendMessage(req, res, body) {
  var text = (body && body.text || "").trim();
  if (!text) { json(res, { error: "消息为空" }, 400); return; }
  var msg = { id: messages.length + 1, text: text, from: "user", time: new Date().toISOString() };
  messages.push(msg);
  json(res, { ok: true, id: msg.id });
}
