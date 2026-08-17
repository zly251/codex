import * as jobDb from "./db/job.js";
import * as companyDb from "./db/company.js";
import * as applicationDb from "./db/application.js";
import * as resumeDb from "./db/resume.js";
import { BrowserManager } from "./browser/browserManager.js";
import * as liveLog from "./log.js";
import {
  findEdgePath,
  DEFAULT_PROFILE,
  FALLBACK_PROFILE,
} from "./edgeLauncher.js";
import { scoreJob, decideJob } from "./scoring.js";
import { sortJobsForApply } from "./salary.js";
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
    if (b.running || state.running || state.chatActive || state.replying || b._checking) {
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
    const skipApplied = body?.skipApplied !== false;

    const searchLiveJobs = async function () {
      const s = getScraper();
      const kw = filterKeywords.split(/[,\u3001\/]/).map(function (x) { return x.trim(); }).filter(function (x) { return x; })[0] || "C++";
      const liveJobs = await s.searchJobs({ keyword: kw, pages: 3 });
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

    if (allJobs.length === 0 && !jobId) {
      liveLog.add(`数据库为空，实时搜索 ${platform.name}...`);
      try {
        allJobs = await searchLiveJobs();
        liveSearchDone = true;
        if (filterCity) allJobs = allJobs.filter(function (j) { return (j.city || "").includes(filterCity); });
      } catch (e) {
        liveSearchDone = true;
        liveLog.add("实时搜索失败: " + (e.message || "").slice(0, 80));
      }
    }

    if (allJobs.length === 0 && filterCity && !jobId) {
      liveLog.add("当前城市无职位，回退到全部城市");
      allJobs = jobDb.search({ limit: 200 }).filter(function (j) { return !j.status || j.status === "active"; });
      allJobs = allJobs.filter(function (j) { return !isBlockedCompany(j); });
    }

    let skippedApplied = 0;
    const appliedIds = new Set(applicationDb.findAll().map(function (a) { return a.jobId; }));
    if (skipApplied && !jobId) {
      const before = allJobs.length;
      allJobs = allJobs.filter(function (j) { return !appliedIds.has(j.id); });
      skippedApplied = before - allJobs.length;
      if (skippedApplied > 0) liveLog.add(`跳过已投递职位: ${skippedApplied} 个`);
    }

    if (skipApplied && !jobId && allJobs.length === 0 && !liveSearchDone) {
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
    }

    const profile = getProfile();
    const greeting = body?.greeting || profile.greeting || "";
    const scored = allJobs.map(function (j) {
      const s = scoreJob(j, profile);
      try { jobDb.update(j.id, { score: s.score }); } catch (e) {}
      return { job: j, match: s.score / 100, score: s.score, salaryRank: s.salaryRank, salaryStatus: s.salaryStatus };
    });

    const decisions = { AUTO_APPLY: 0, REVIEW: 0, IGNORE: 0 };
    scored.forEach(function (s) {
      decisions[decideJob(s.score, minMatch * 100)]++;
    });

    const jobs = sortJobsForApply(
      scored.filter(function (s) { return s.match >= minMatch; })
    )
      .slice(0, limit)
      .map(function (s) {
        const techs = (s.job.technologies || "").split(",").map(function (x) { return x.trim(); }).filter(Boolean);
        const resume = resumeDb.findBestMatch(techs);
        return Object.assign({}, s.job, {
          companyName: getJobCompanyName(s.job),
          resumeId: resume ? resume.id : null,
        });
      });

    if (jobs.length === 0) {
      json(res, { ok: true, applied: 0, total: 0, skippedApplied: skippedApplied, message: "没有匹配的职位（城市=" + filterCity + " 区域=" + filterDistrict + " 关键词=" + filterKeywords + "）" });
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
        const stats = result || { scanned: 0, replied: 0, manual: 0, resumeSent: 0 };
        liveLog.add(`[chat] once scan done: scanned=${stats.scanned} replied=${stats.replied} manual=${stats.manual} resumeSent=${stats.resumeSent}`);
        json(res, { ok: true, message: "once_chat_scan_done", ...stats });
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
