// Autonomous Job Search Agent
// Job CRUD

import { getDb } from "./index.js";

export function search(params) {
  if (!params) params = {};
  var d = getDb(); var conds = []; var vals = [];
  if (params.keywords) { conds.push("(title LIKE ? OR description LIKE ? OR requirements LIKE ? OR technologies LIKE ?)"); var kw = "%" + params.keywords + "%"; vals.push(kw, kw, kw, kw); }
  if (params.city) { conds.push("city = ?"); vals.push(params.city); }
  if (params.status) { conds.push("status = ?"); vals.push(params.status); }
  if (params.jobTag) { conds.push("jobTag = ?"); vals.push(params.jobTag); }
  if (params.source) { conds.push("source = ?"); vals.push(params.source); }
  if (params.minScore !== undefined) { conds.push("score >= ?"); vals.push(params.minScore); }
  var where = conds.length > 0 ? "WHERE " + conds.join(" AND ") : "";
  var limit = params.limit || 50; var offset = params.offset || 0;
  vals.push(limit, offset);
  return d.prepare("SELECT * FROM Job " + where + " ORDER BY scrapedAt DESC LIMIT ? OFFSET ?").all(...vals);
}

export function findById(id) { return getDb().prepare("SELECT * FROM Job WHERE id = ?").get(id); }
export function findByUrl(url) { return getDb().prepare("SELECT * FROM Job WHERE url = ?").get(url); }

export function create(data) {
  var d = getDb();
  var info = d.prepare("INSERT INTO Job (title, salaryMin, salaryMax, salaryRaw, city, district, experience, education, description, requirements, technologies, url, source, rawData, postedAt, lastSeenAt, companyId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)").run(data.title, data.salaryMin||null, data.salaryMax||null, data.salaryRaw||null, data.city||null, data.district||null, data.experience||null, data.education||null, data.description||null, data.requirements||null, data.technologies||null, data.url, data.source||"zhipin", data.rawData||null, data.postedAt||null, data.companyId||null);
  return findById(info.lastInsertRowid);
}

export function upsert(data) {
  var existing = findByUrl(data.url);
  if (existing) {
    update(existing.id, data);
    touch(existing.id);
    return findById(existing.id);
  }
  return create(data);
}

export function touch(id) {
  getDb().prepare("UPDATE Job SET lastSeenAt = datetime('now'), status = 'active' WHERE id = ?").run(id);
}

export function markClosed(id) {
  getDb().prepare("UPDATE Job SET status = 'closed', updatedAt = datetime('now') WHERE id = ?").run(id);
}

export function markClosedBefore(dateStr) {
  var info = getDb().prepare("UPDATE Job SET status = 'closed', updatedAt = datetime('now') WHERE status = 'active' AND (lastSeenAt IS NULL OR lastSeenAt < ?)").run(dateStr);
  return info.changes;
}

export function update(id, data) {
  var d = getDb(); var sets = []; var vals = [];
  for (var k in data) { if (data[k] !== undefined) { sets.push(k + " = ?"); vals.push(data[k]); } }
  if (sets.length === 0) return findById(id);
  sets.push("lastSeenAt = datetime('now')"); sets.push("updatedAt = datetime('now')"); vals.push(id);
  d.prepare("UPDATE Job SET " + sets.join(", ") + " WHERE id = ?").run(...vals);
  return findById(id);
}

export function remove(id) { return getDb().prepare("DELETE FROM Job WHERE id = ?").run(id).changes > 0; }

export function count(params) {
  if (!params) params = {};
  var d = getDb(); var conds = []; var vals = [];
  if (params.keywords) { conds.push("(title LIKE ? OR description LIKE ? OR requirements LIKE ? OR technologies LIKE ?)"); var kw = "%" + params.keywords + "%"; vals.push(kw, kw, kw, kw); }
  if (params.city) { conds.push("city = ?"); vals.push(params.city); }
  if (params.status) { conds.push("status = ?"); vals.push(params.status); }
  if (params.jobTag) { conds.push("jobTag = ?"); vals.push(params.jobTag); }
  if (params.minScore !== undefined) { conds.push("score >= ?"); vals.push(params.minScore); }
  var where = conds.length > 0 ? "WHERE " + conds.join(" AND ") : "";
  return d.prepare("SELECT COUNT(*) as cnt FROM Job " + where).get(...vals).cnt;
}

export function getActiveUrls() {
  var rows = getDb().prepare("SELECT url FROM Job WHERE status = 'active'").all();
  return rows.map(function(r) { return r.url; });
}

export function getHighScoreJobs(score) {
  if (score === undefined) score = 60;
  return getDb().prepare("SELECT * FROM Job WHERE status = 'active' AND score >= ? ORDER BY score DESC").all(score);
}
