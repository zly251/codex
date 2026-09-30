// Autonomous Job Search Agent - Web UI Server
// Start: npx tsx server.mjs

import http from "node:http";
import "dotenv/config";

// Prevent crash on unhandled promise rejections
process.on("unhandledRejection", function(reason) {
  console.error("[server] Unhandled Rejection:", (reason?.message || reason || "").slice(0, 100));
});
process.on("uncaughtException", function(err) {
  console.error("[server] Uncaught Exception:", (err?.message || "").slice(0, 100));
});

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { initDb } from "./src/db/index.js";
import { getStatus as getBossStatus, handleConnect, handleLaunch, handleSearch, handleEnrich, handleApply, handleChatStart, handleChatStop, handleChatReply, handleChatSendResume, handleFeedbackSync, handleGetMessages, handleReviewList, handleReviewApprove, handleReviewApproveAll, handleReviewReject, handleReplenish, handleReviewAutoApprove, checkLoggedIn, isBrowserConnected, ensureBrowserConnected, approvedPendingCount, manualPendingCount, recentChatTranscripts, isApplyDryRun } from "./src/routes.mjs";
import { createAutopilot } from "./src/autopilot.js";
import { buildSummaries, writeSummariesFile } from "./src/chatSummary.js";
import { generateText, loadCandidateCardText, buildSafeResumeText } from "./src/llmProvider.js";
import { buildLookResponse } from "./src/extensionLook.mjs";
import { computeValueCard } from "./src/value.mjs";
import * as company from "./src/db/company.js";
import * as job from "./src/db/job.js";
import * as resume from "./src/db/resume.js";
import * as application from "./src/db/application.js";
import { extractSkills } from "./src/utils/skills.js";
import { scoreJob } from "./src/scoring.js";
import { buildStrategy } from "./src/strategy.js";
import {
  extractResumeText,
  mergeResumeFromUpload,
  parseResumeText,
  resumeFileType,
} from "./src/utils/resumeParser.js";
import { PROFILE_PATH, RESUME_DIR, ensureDataDirs } from "./src/paths.js";
import { loadResumeEditor, saveResumeEditor, generateDocxBuffer, generatePdfBuffer, resumeToText } from "./src/resumeExport.js";

var __dirname = (function(){ try { return path.dirname(fileURLToPath(import.meta.url)); } catch (e) { return process.cwd(); } })();
var WEB_DIR = process.env.JOB_AGENT_WEB_DIR || path.join(__dirname, "web");
var PORT = Number(process.env.PORT) || 3456;

initDb();
ensureDataDirs();
console.log("[server] DB ready, port " + PORT);

// ══════════════════════════════════════════════════════════════════
// 自动巡航（autopilot）：用户点一次「开始自动跑」，之后自己循环到没活干。
// 循环体：连浏览器(自动恢复 Cookie) → 同步聊天 → 回待回消息 → 按节奏发打招呼 → 写面试摘要。
// 每个动作都通过本机 HTTP 调自己的接口 —— 这些动作在 routes.mjs 里是「req/res」形态，
// 自调用比重构成纯函数改动面小得多，且同进程不会有死锁问题。
// ══════════════════════════════════════════════════════════════════
const SELF_BASE = "http://127.0.0.1:" + PORT;
const SUMMARY_PATH =
  process.env.JOB_AGENT_SUMMARY_PATH ||
  path.join(process.env.JOB_AGENT_DATA_DIR || process.cwd(), "data", "chat-summaries.json");

// 自调用走 node:http 并显式 setTimeout：全局 fetch（undici）默认 300s 响应超时，
// once 扫描带人味节奏常跑 5~10 分钟以上，会在服务端仍在干活时先报 "fetch failed"，
// 巡航把"其实还在跑"的一轮误判为失败（2026-09-19 日志实证）。45 分钟上限足够覆盖
// 最长扫描，又能保证真挂死时最终报错，不会让 autopilot 永久卡住。
const SELF_TIMEOUT_MS = Number(process.env.JOB_AGENT_SELF_TIMEOUT_MS || 45 * 60 * 1000);

function selfPost(pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const req = http.request(
      SELF_BASE + pathname,
      { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`自调用 ${pathname} 返回非 JSON (HTTP ${res.statusCode})`)); }
        });
      }
    );
    req.setTimeout(SELF_TIMEOUT_MS, () => req.destroy(new Error(`自调用 ${pathname} 超时（>${Math.round(SELF_TIMEOUT_MS / 60000)} 分钟）`)));
    req.on("error", reject);
    req.end(payload);
  });
}

// 会话要点摘要：把留档的会话原话交给 LLM 提要点，失败自动退回骨架（绝不抛）
async function runSummaries() {
  const chats = recentChatTranscripts(30);
  if (!chats.length) return { written: 0, reason: "no_chats" };
  let profile = null;
  try { profile = JSON.parse(fs.readFileSync(PROFILE_PATH, "utf8")); } catch (e) {}
  const card = (() => { try { return loadCandidateCardText(); } catch (e) { return ""; } })();
  const result = await buildSummaries({
    chats,
    callLLM: (prompt) => generateText(prompt, { maxTokens: 900 }),
    profile,
    card,
    log: (m) => console.log("[summary] " + m),
  });
  await writeSummariesFile({ filePath: SUMMARY_PATH, summaries: result.summaries, existing: null });
  return {
    written: result.summaries.length,
    llmUsed: result.llmUsed,
    fallbackUsed: result.fallbackUsed,
  };
}

const autopilot = createAutopilot({
  isBrowserConnected: () => {
    try { return isBrowserConnected(); } catch (e) { return false; }
  },
  connectBrowser: () => ensureBrowserConnected(),
  checkLogin: () => checkLoggedIn(),
  // —— 无人值守"补库存 + 自动放行"两步（2026-09-21 新增）——
  // 默认关：只有 .env JOB_AGENT_REPLENISH / JOB_AGENT_AUTO_APPROVE 打开时，巡航才会自己搜新岗、
  // 增补、并把达标待确认岗位放行进投递集合。关着时返回空对象，巡航行为与新增前完全一致。
  replenish: async () => {
    if (!/^(1|true|yes|on)$/i.test(String(process.env.JOB_AGENT_REPLENISH || "").trim())) {
      return { searched: 0, enriched: 0, skipped: true };
    }
    const j = await selfPost("/api/boss/replenish");
    // 补库存失败（浏览器没连/风控等）不当致命：交给调度器记一条 error，本轮其余动作照常。
    if (j && j.ok === false && !j.busy) throw new Error(j.error || "replenish 失败");
    return j || {};
  },
  autoApprove: async () => {
    if (!/^(1|true|yes|on)$/i.test(String(process.env.JOB_AGENT_AUTO_APPROVE || "").trim())) {
      return { approved: 0 };
    }
    const j = await selfPost("/api/review/auto-approve");
    if (j && j.ok === false && !j.busy) throw new Error(j.error || "auto-approve 失败");
    return j || {};
  },
  syncFeedback: async () => {
    const j = await selfPost("/api/boss/sync-feedback");
    // busy=已有任务在跑，属正常情况，不算失败
    if (j && j.ok === false && !j.busy) throw new Error(j.error || "sync-feedback 失败");
    return j || {};
  },
  replyDueChats: async () => {
    // 用 once:true 做"扫一遍就返回"的串行处理，而不是常驻监控：
    // apply/chat/scan 三者都驱动同一个页面，项目里是互斥的（busy 409）。
    // 巡航每轮串行执行一遍，既拿到真实的"回了几条/还有几条要人管"，也不会互相抢页面。
    const j = await selfPost("/api/boss/chat/start", { once: true, sendResume: true, sendResumeScreenshot: false });
    if (j && j.ok === false && !j.needLogin && !j.busy) throw new Error(j.error || "chat once 扫描失败");
    const manual = Number(j && j.manual) || 0;
    return {
      replied: Number(j && j.replied) || 0,
      failed: Number(j && j.failed) || 0,
      pending: manual || manualPendingCount(),
    };
  },
  applyQueue: async () => {
    const before = approvedPendingCount();
    if (!before) return { sent: 0, remaining: 0 };
    const j = await selfPost("/api/boss/apply", { limit: 150 });
    // busy=once 扫描还占着页面，属正常互斥（与 sync-feedback 同一套语义），不算失败；
    // 队列没排空，下一轮自然会再试（2026-09-19 修正：此前每轮都误报一条 applyQueue 失败）。
    if (j && j.ok === false && !j.needLogin && !j.busy) throw new Error(j.error || "apply 失败");
    // blocked=命中 BOSS 账号访问受限/连续打不开熔断。透传给调度器，让它【整体停机】而不是
    // 转空闲继续巡检 —— 巡检下一轮会再搜索+增补，正是 BOSS 明令禁止、会延长封禁的行为。
    return { sent: Number(j && j.applied) || 0, remaining: approvedPendingCount(), blocked: !!(j && j.blocked) };
  },
  writeSummaries: () => runSummaries(),
  log: (msg) => console.log("[autopilot] " + msg),
});

async function ensureResumeFile(resumeRow) {
  if (resumeRow?.filePath && fs.existsSync(resumeRow.filePath)) return resumeRow;
  try {
    const saved = loadResumeEditor(getProfile() || {});
    const buf = await generatePdfBuffer(saved);
    const file = path.join(RESUME_DIR, "resume-" + Date.now() + ".pdf");
    fs.writeFileSync(file, buf);
    console.log("[server] generated default resume: " + file);
    return resumeRow ? resume.update(resumeRow.id, { filePath: file, fileType: "pdf" }) : null;
  } catch (e) {
    console.error("[server] default resume generate failed: " + (e && e.message));
    return resumeRow;
  }
}

async function autoCreateResumeFromProfile() {
  try {
    const existing = resume.findDefault() || resume.findAll()[0];
    if (existing) {
      const updated = await ensureResumeFile(existing);
      application.attachDefaultResume((updated || existing).id);
      return;
    }
    const p = getProfile();
    if (!p || !String(p.skills || "").trim()) return;
    const created = resume.create({
      name: p.name || "个人简历",
      targetRole: p.targetRole || "",
      tags: p.skills,
      fileType: "profile",
      description: "由个人档案自动生成",
      isDefault: true,
      skills: p.skills,
    });
    if (created) application.attachDefaultResume(created.id);
    const updated = await ensureResumeFile(created);
    if (updated) application.attachDefaultResume(updated.id);
    console.log("[server] auto resume created from profile");
  } catch (e) {
    console.error("[server] auto resume failed: " + (e && e.message));
  }
}

function refreshJobScores() {
  try {
    const profile = getProfile();
    const jobs = job.search({ limit: 100000 });
    for (const j of jobs) {
      const s = scoreJob(j, profile);
      job.update(j.id, { score: s.score });
    }
    console.log("[server] scores refreshed: " + jobs.length);
  } catch (e) {
    console.error("[server] score refresh failed: " + (e && e.message));
  }
}

autoCreateResumeFromProfile().catch(function (e) {
  console.error("[server] auto resume init failed: " + (e && e.message));
});
refreshJobScores();


function serveFile(res, filePath) {
  var mimes = { '.html':'text/html;charset=utf-8', '.css':'text/css;charset=utf-8', '.js':'application/javascript;charset=utf-8', '.png':'image/png', '.jpg':'image/jpeg' };
  try {
    var c = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mimes[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(c);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

function json(res, data, status) {
  res.writeHead(status || 200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function getProfile() { try { return JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8')); } catch { return null; } }

function apiGetProfile(req, res) { json(res, getProfile() || { name: '', skills: '', targetRole: '' }); }

function apiSaveProfile(req, res) {
  var body = '';
  req.on('data', function(c) { body += c; });
  req.on('end', function() {
    try {
      var p = JSON.parse(body);
      fs.writeFileSync(PROFILE_PATH, JSON.stringify(p, null, 2), 'utf8');
      json(res, { ok: true });
    } catch (e) {
      json(res, { error: e.message }, 400);
    }
  });
}

function apiStats(req, res) {
  var appStats = application.getStats();
  var strategy = buildStrategy();
  json(res, {
    // 用 count() 而不是 search().length：search 默认 LIMIT 50，库里有 156 个岗位时
    // 面板永远显示"总岗位 50"，与投递/队列看到的对不上（2026-09-19 实测）。
    totalJobs: job.count({}),
    activeJobs: job.count({ status: 'active' }),
    closedJobs: job.count({ status: 'closed' }),
    totalResumes: resume.findAll().length,
    totalApplications: application.findAll().length,
    pending: appStats.pending || 0,
    viewed: appStats.viewed || 0,
    replied: appStats.replied || 0,
    interviews: appStats.interview || 0,
    offers: appStats.offer || 0,
    rejected: appStats.rejected || 0,
    withdrawn: appStats.withdrawn || 0,
    funnel: strategy.funnel,
    conversion: strategy.conversion,
    strategy: {
      recommendedMinMatch: strategy.recommendedMinMatch,
      avgAppliedScore: strategy.avgAppliedScore,
      insight: strategy.insight,
    },
  });
}

function apiStrategy(req, res) {
  json(res, buildStrategy());
}

function apiJobs(req, res) {
  var url = new URL(req.url, 'http://localhost');
  var params = Object.fromEntries(url.searchParams);
  var results = job.search(params);
  var total = job.count(params);
  var profile = getProfile();
  results = results.map(function(j) {
    var cn = ''; if (j.companyId) { var c = company.findById(j.companyId); if (c) cn = c.name; }
    var s = scoreJob(j, profile);
    return { id: j.id, title: j.title, companyName: cn, salaryMin: j.salaryMin, salaryMax: j.salaryMax, salaryRaw: j.salaryRaw, city: j.city, status: j.status, score: j.score, technologies: j.technologies, description: j.description, requirements: j.requirements, url: j.url, matchPct: s.score, matchedSkills: s.matchedSkills, missingSkills: s.missingSkills };
  });
  json(res, { jobs: results, total: total });
}

function apiResumes(req, res) { json(res, { resumes: resume.findAll() }); }

function apiSetDefaultResume(req, res) {
  var id = parseInt(req.url.split('/').filter(Boolean).slice(-2)[0], 10);
  var existing = resume.findById(id);
  if (!existing) {
    json(res, { ok: false, error: "Resume not found" }, 404);
    return;
  }
  resume.update(id, { isDefault: true });
  json(res, { ok: true, resume: resume.findById(id) });
}

function apiGetResumeEditor(req, res) {
  json(res, { ok: true, resume: loadResumeEditor(getProfile() || {}) });
}

function apiSaveResumeEditor(req, res) {
  readJsonBody(req, function (data) {
    try {
      const saved = saveResumeEditor(data, PROFILE_PATH);
      const skills = saved.skills || "";
      const rawText = resumeToText(saved);
      const existing = resume.findDefault() || resume.findAll()[0];
      const payload = {
        name: saved.name || existing?.name || "个人简历",
        targetRole: saved.targetRole,
        tags: skills,
        skills: skills,
        description: saved.summary,
        rawText: rawText,
        fileType: "editor",
      };
      if (existing) {
        resume.update(existing.id, payload);
      } else {
        resume.create({ ...payload, isDefault: true });
      }
      json(res, { ok: true, resume: saved });
    } catch (e) {
      json(res, { error: e.message }, 500);
    }
  });
}

async function apiExportResume(req, res) {
  try {
    const format = (new URL(req.url, "http://localhost").searchParams.get("format") || "pdf").toLowerCase();
    const saved = loadResumeEditor(getProfile() || {});
    if (format === "docx") {
      const buf = await generateDocxBuffer(saved);
      res.writeHead(200, {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": 'attachment; filename="resume.docx"',
        "Content-Length": buf.length,
      });
      res.end(buf);
      return;
    }
    const buf = await generatePdfBuffer(saved);
    res.writeHead(200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": 'attachment; filename="resume.pdf"',
      "Content-Length": buf.length,
    });
    res.end(buf);
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
}

function apiUploadResume(req, res) {
  var body = '';
  req.on('data', function(c) { body += c; });
  req.on('end', async function() {
    try {
      var data = JSON.parse(body);
      if (!data.fileData) { json(res, { error: 'No file data' }, 400); return; }
      var buf = Buffer.from(data.fileData, 'base64');
      var saveName = Date.now() + '-' + (data.fileName || 'upload').replace(/[^\w.-]/g, '_');
      var savePath = path.join(RESUME_DIR, saveName);
      fs.writeFileSync(savePath, buf);
      var text = '';
      var recognitionWarning = '';
      try {
        text = await extractResumeText(savePath);
      } catch (e) {
        recognitionWarning = String(e?.message || e || 'resume_parse_failed').slice(0, 200);
      }
      text = String(text || '').trim();
      var parsed = parseResumeText(text);
      var existingEditor = loadResumeEditor(getProfile() || {});
      var mergedEditor = mergeResumeFromUpload(existingEditor, parsed);
      saveResumeEditor(mergedEditor, PROFILE_PATH);
      var skills = (parsed.skills || extractSkills(text).join(',')).split(',').filter(function(s, i, a) { return s && a.indexOf(s) === i; });
      var r = resume.create({
        name: data.name || parsed.name || saveName,
        targetRole: parsed.targetRole || data.targetRole || '',
        tags: skills.join(',') || data.tags || '',
        isDefault: true,
        rawText: text.slice(0, 10000),
        filePath: savePath,
        fileType: resumeFileType(savePath),
        skills: skills.join(','),
      });
      json(res, {
        ok: true,
        resume: r,
        skills: skills,
        parsed: parsed,
        textPreview: text.slice(0, 800),
        recognitionWarning: recognitionWarning || null,
      });
    } catch (e) {
      console.error("[upload] " + e.message);
      json(res, { error: e.message }, 400);
    }
  });
}

function apiApplications(req, res) {
  var s = new URL(req.url, 'http://localhost').searchParams.get('status') || undefined;
  var apps = application.findAll(s);
  apps = apps.map(function(a) {
    var j = a.jobId ? job.findById(a.jobId) : null;
    var c = j && j.companyId ? company.findById(j.companyId) : null;
    var r = a.resumeId ? resume.findById(a.resumeId) : null;
    return { id: a.id, jobTitle: (j && j.title) || (a.jobId ? '#' + a.jobId : '-'), companyName: (c && c.name) || (j && j.companyName) || '', salary: (j && j.salaryRaw) || '', city: (j && j.city) || '', status: a.status, notes: a.notes || '', resumeId: a.resumeId || null, resumeName: (r && r.name) || '', time: a.appliedAt || a.updatedAt || '' };
  });
  json(res, { applications: apps });
}

function readJsonBody(req, cb) {
  var body = '';
  req.on('data', function(c) { body += c; });
  req.on('end', function() {
    try { cb(JSON.parse(body || '{}')); } catch (e) { cb({}); }
  });
}

function apiCloseJob(req, res, id) {
  json(res, { ok: job.markClosed(id) });
}

function apiCloseStaleJobs(req, res) {
  var before = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  json(res, { ok: true, closed: job.markClosedBefore(before) });
}

function apiUpdateApplication(req, res, id) {
  readJsonBody(req, function(data) {
    var a = application.updateStatus(id, data.status || 'pending', data.notes || null);
    json(res, { ok: !!a, application: a });
  });
}

function apiDeleteApplication(req, res, id) {
  json(res, { ok: application.remove(id) });
}

// ══════════════════════════════════════════════════════════════════
// 浏览器扩展 V0（任务卡-求职助手浏览器扩展V0）：扩展只读页面 → 本机算钱 + 出话术建议。
// 与 puppeteer 自动化链路完全解耦：这里不碰浏览器、不写页面，纯请求/响应。
// ══════════════════════════════════════════════════════════════════
async function apiExtensionLook(req, res) {
  readJsonBody(req, async function (data) {
    try {
      // 真机验收诊断：设 EXT_LOOK_DEBUG=<路径> 时把原始 pageText 落盘，供离线核对抽取假设。默认关。
      if (process.env.EXT_LOOK_DEBUG) {
        try {
          fs.appendFileSync(
            process.env.EXT_LOOK_DEBUG,
            "\n==== " + new Date().toISOString() + " href=" + (data.href || "") + " ====\n" + (data.pageText || "") + "\n",
            "utf8"
          );
        } catch (e) { /* 诊断失败不影响主流程 */ }
      }
      const profile = getProfile() || {};
      const resumeEditor = loadResumeEditor(profile);
      const expectedSalary = String(resumeEditor?.expectedSalary ?? "");
      const resumeRow = resume.findDefault() || resume.findAll()[0] || null;
      const out = await buildLookResponse(
        {
          pageText: data.pageText,
          href: data.href,
          commuteMode: data.commuteMode,
          oneWayKm: data.oneWayKm,
          profile,
          resume: resumeRow,
          resumeEditor,
          expectedSalary,
        },
        { env: process.env, generateText }
      );
      json(res, out);
    } catch (e) {
      json(res, { ok: false, error: String(e?.message || e).slice(0, 200) }, 500);
    }
  });
}

// 含金量卡单独口子：面板可脱离聊天页，按手填薪资直接算（也走 value.mjs 纯函数）
function apiValue(req, res) {
  readJsonBody(req, function (data) {
    try {
      json(res, computeValueCard(data || {}));
    } catch (e) {
      json(res, { ok: false, reason: String(e?.message || e).slice(0, 200) }, 500);
    }
  });
}

var routes = {
  "/api/profile": apiGetProfile,
  "/api/stats": apiStats,
  "/api/jobs": apiJobs,
  "/api/resumes": apiResumes,
  "/api/applications": apiApplications,
  "/api/strategy": apiStrategy,
};

var httpServer = http.createServer(function(req, res) {
  var url = new URL(req.url, 'http://localhost');
  var p = url.pathname;
  if (p === "/api/value" && req.method === "POST") { apiValue(req, res); return; }
  if (p === "/api/profile" && req.method === "POST") { apiSaveProfile(req, res); return; }
  if (p === "/api/resumes/upload" && req.method === "POST") { apiUploadResume(req, res); return; }
  if (req.method === "POST" && /^\/api\/resumes\/\d+\/default$/.test(p)) {
    apiSetDefaultResume(req, res);
    return;
  }
  if (p === "/api/resume/editor" && req.method === "GET") { apiGetResumeEditor(req, res); return; }
  if (p === "/api/resume/editor" && req.method === "POST") { apiSaveResumeEditor(req, res); return; }
  if (p === "/api/resume/export" && req.method === "GET") { apiExportResume(req, res); return; }

  // —— 扩展 V0：/api/extension/look（含 chrome-extension:// 源的 CORS 预检）——
  if (p === "/api/extension/look" && req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    });
    res.end();
    return;
  }
  if (p === "/api/extension/look" && req.method === "POST") { apiExtensionLook(req, res); return; }

  if (req.method === "DELETE" && /^\/api\/resumes\/\d+$/.test(p)) {
    var id = parseInt(p.split('/').pop(), 10);
    var ok = resume.remove(id);
    json(res, { ok: ok });
    return;
  }

  if (req.method === "POST" && /^\/api\/jobs\/\d+\/close$/.test(p)) {
    apiCloseJob(req, res, parseInt(p.match(/^\/api\/jobs\/(\d+)\/close$/)[1], 10));
    return;
  }
  if (req.method === "POST" && p === "/api/jobs/close-stale") {
    apiCloseStaleJobs(req, res);
    return;
  }
  if (req.method === "PATCH" && /^\/api\/applications\/\d+$/.test(p)) {
    apiUpdateApplication(req, res, parseInt(p.split('/').pop(), 10));
    return;
  }
  if (req.method === "DELETE" && /^\/api\/applications\/\d+$/.test(p)) {
    apiDeleteApplication(req, res, parseInt(p.split('/').pop(), 10));
    return;
  }

  var handler = routes[p];
  if (handler) { handler(req, res); return; }

  if (p === "/api/chat/messages" && req.method === "GET") {
    handleGetMessages(req, res);
    return;
  }

  if (p === "/api/chat/send" && req.method === "POST") {
    var chatBody = "";
    req.on("data", function(c) { chatBody += c; });
    req.on("end", async function() {
      try {
        var chatData = chatBody ? JSON.parse(chatBody) : {};
        await handleChatReply(req, res, chatData);
      } catch (e) {
        json(res, { ok: false, error: e.message }, 500);
      }
    });
    return;
  }

  if (p === "/api/boss/chat/reply" && req.method === "POST") {
    var replyBody = "";
    req.on("data", function(c) { replyBody += c; });
    req.on("end", async function() {
      try {
        var replyData = replyBody ? JSON.parse(replyBody) : {};
        await handleChatReply(req, res, replyData);
      } catch (e) {
        json(res, { ok: false, error: e.message }, 500);
      }
    });
    return;
  }

  if (p === "/api/autopilot/status" && req.method === "GET") {
    json(res, { ok: true, autopilot: autopilot.status(), applyDryRun: isApplyDryRun(), approved: approvedPendingCount(), manualPending: manualPendingCount() });
    return;
  }
  if (p === "/api/autopilot/start" && req.method === "POST") {
    var apBody = "";
    req.on("data", function(c) { apBody += c; });
    req.on("end", function() {
      var opts = {};
      try { opts = apBody ? JSON.parse(apBody) : {}; } catch (e) {}
      var r = autopilot.start(opts);
      json(res, { ok: !!r.started, result: r, autopilot: autopilot.status() });
    });
    return;
  }
  if (p === "/api/autopilot/stop" && req.method === "POST") {
    json(res, { ok: true, result: autopilot.stop(), autopilot: autopilot.status() });
    return;
  }
  if (p === "/api/chat/summaries" && req.method === "GET") {
    var summaryStore = { updatedAt: "", summaries: [] };
    try { summaryStore = JSON.parse(fs.readFileSync(SUMMARY_PATH, "utf8")) || summaryStore; } catch (e) {}
    json(res, { ok: true, updatedAt: summaryStore.updatedAt || "", summaries: summaryStore.summaries || [] });
    return;
  }
  if (p === "/api/chat/summaries/refresh" && req.method === "POST") {
    runSummaries()
      .then(function (r) { json(res, { ok: true, ...r }); })
      .catch(function (e) { json(res, { ok: false, error: e.message }, 500); });
    return;
  }
  if (p === "/api/review" && req.method === "GET") { handleReviewList(req, res); return; }
  if (p === "/api/review/approve" && req.method === "POST") {
    var rvBody = "";
    req.on("data", function(c) { rvBody += c; });
    req.on("end", async function() {
      try { await handleReviewApprove(req, res, rvBody ? JSON.parse(rvBody) : {}); }
      catch (e) { json(res, { ok: false, error: e.message }, 500); }
    });
    return;
  }
  if (p === "/api/review/approve-all" && req.method === "POST") {
    var raBody = "";
    req.on("data", function(c) { raBody += c; });
    req.on("end", function() {
      try { handleReviewApproveAll(req, res, raBody ? JSON.parse(raBody) : {}); }
      catch (e) { json(res, { ok: false, error: e.message }, 500); }
    });
    return;
  }
  if (p === "/api/review/auto-approve" && req.method === "POST") {
    var aaBody = "";
    req.on("data", function(c) { aaBody += c; });
    req.on("end", function() {
      try { handleReviewAutoApprove(req, res, aaBody ? JSON.parse(aaBody) : {}); }
      catch (e) { json(res, { ok: false, error: e.message }, 500); }
    });
    return;
  }
  if (p === "/api/review/reject" && req.method === "POST") {
    var rjBody = "";
    req.on("data", function(c) { rjBody += c; });
    req.on("end", async function() {
      try { await handleReviewReject(req, res, rjBody ? JSON.parse(rjBody) : {}); }
      catch (e) { json(res, { ok: false, error: e.message }, 500); }
    });
    return;
  }

  if (p.startsWith("/api/boss")) {
    if (req.method === "GET") {
      if (p === "/api/boss/status") { json(res, getBossStatus()); return; }
      if (p === "/api/boss/chat/stop") { handleChatStop(req, res); return; }
      if (p === '/api/chat/messages') { handleGetMessages(req, res); return; }
    }
    if (req.method === "POST") {
      var bd = "";
      req.on("data", function(c) { bd += c; });
      req.on("end", async function() {
        try {
          var data = bd ? JSON.parse(bd) : {};
          if (p === "/api/boss/connect") { await handleConnect(req, res, data); }
          else if (p === "/api/boss/launch") { await handleLaunch(req, res, data); }
          else if (p === "/api/boss/search") { await handleSearch(req, res, data); }
          else if (p === "/api/boss/enrich") { await handleEnrich(req, res, data); }
          else if (p === "/api/boss/replenish") { await handleReplenish(req, res, data); }
          else if (p === "/api/boss/apply") { await handleApply(req, res, data); }
          else if (p === "/api/boss/stop") { handleChatStop(req, res); }
          else if (p === "/api/boss/chat/start") { await handleChatStart(req, res, data); }
          else if (p === "/api/boss/chat/send-resume") { await handleChatSendResume(req, res, data); }
          else if (p === "/api/boss/sync-feedback") { await handleFeedbackSync(req, res, data); }
          else { json(res, { error: "not found" }, 404); }
        } catch (e) {
          json(res, { error: e.message }, 500);
        }
      });
      return;
    }
    json(res, { error: "method not allowed" }, 405);
    return;
  }

  if (p === "/") p = "/index.html";
  serveFile(res, path.join(WEB_DIR, p));
});

httpServer.listen(PORT, function() {
  console.log("================================================");
  console.log("  Job Agent UI  -  http://localhost:" + PORT);
  console.log("================================================");
  // 一键启动：.env 里 AUTOPILOT=1 时，服务一起来就自动开始巡航（真正的"入口一键启动"）。
  // 默认不开，避免用户没准备好就被自动发出去。
  if (/^(1|true|yes|on)$/i.test(String(process.env.AUTOPILOT || "").trim())) {
    const r = autopilot.start();
    console.log("[autopilot] 已按 .env AUTOPILOT=1 自动启动", JSON.stringify(r));
  }
});
