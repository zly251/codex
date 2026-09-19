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
import { getStatus as getBossStatus, handleConnect, handleLaunch, handleSearch, handleEnrich, handleApply, handleChatStart, handleChatStop, handleChatReply, handleChatSendResume, handleFeedbackSync, handleGetMessages, handleReviewList, handleReviewApprove, handleReviewReject } from "./src/routes.mjs";
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
    totalJobs: job.search({}).length,
    activeJobs: job.search({ status: 'active' }).length,
    closedJobs: job.search({ status: 'closed' }).length,
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
  if (p === "/api/profile" && req.method === "POST") { apiSaveProfile(req, res); return; }
  if (p === "/api/resumes/upload" && req.method === "POST") { apiUploadResume(req, res); return; }
  if (req.method === "POST" && /^\/api\/resumes\/\d+\/default$/.test(p)) {
    apiSetDefaultResume(req, res);
    return;
  }
  if (p === "/api/resume/editor" && req.method === "GET") { apiGetResumeEditor(req, res); return; }
  if (p === "/api/resume/editor" && req.method === "POST") { apiSaveResumeEditor(req, res); return; }
  if (p === "/api/resume/export" && req.method === "GET") { apiExportResume(req, res); return; }

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
});
