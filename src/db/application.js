// Autonomous Job Search Agent
// Application CRUD
import { getDb } from "./index.js";
export function findAll(status) {
    var d = getDb();
    if (status) {
        return d.prepare("SELECT * FROM Application WHERE status = ? ORDER BY updatedAt DESC").all(status);
    }
    return d.prepare("SELECT * FROM Application ORDER BY updatedAt DESC").all();
}
export function findById(id) { return getDb().prepare("SELECT * FROM Application WHERE id = ?").get(id); }
export function findByJobId(jobId) { return getDb().prepare("SELECT * FROM Application WHERE jobId = ? ORDER BY updatedAt DESC LIMIT 1").get(jobId); }
export function create(data) {
    var d = getDb();
    if (data.jobId) {
        var existing = findByJobId(data.jobId);
        if (existing) return existing;
    }
    var info = d.prepare("INSERT INTO Application (status, resumeId, jobId, notes, appliedAt) VALUES (?, ?, ?, ?, datetime('now'))").run(data.status || "pending", data.resumeId || null, data.jobId || null, data.notes || null);
    return findById(info.lastInsertRowid);
}
export function updateStatus(id, status, notes) {
    var d = getDb();
    var col = status === "viewed" ? "viewedAt" : status === "replied" ? "repliedAt" : status === "interview" ? "interviewAt" : status === "offer" ? "offerAt" : null;
    if (col) {
        d.prepare("UPDATE Application SET status = ?, " + col + " = datetime('now'), notes = COALESCE(?, notes), updatedAt = datetime('now') WHERE id = ?").run(status, notes || null, id);
    }
    else {
        d.prepare("UPDATE Application SET status = ?, notes = COALESCE(?, notes), updatedAt = datetime('now') WHERE id = ?").run(status, notes || null, id);
    }
    return findById(id);
}
export function remove(id) { return getDb().prepare("DELETE FROM Application WHERE id = ?").run(id).changes > 0; }
export function attachDefaultResume(resumeId) {
    return getDb().prepare("UPDATE Application SET resumeId = ? WHERE resumeId IS NULL").run(resumeId).changes;
}
export function getStats() {
    var d = getDb();
    var rows = d.prepare("SELECT status, COUNT(*) as cnt FROM Application GROUP BY status").all();
    var stats = { pending: 0, viewed: 0, replied: 0, interview: 0, offer: 0, rejected: 0, withdrawn: 0 };
    for (var i = 0; i < rows.length; i++) {
        stats[rows[i].status] = rows[i].cnt;
    }
    return stats;
}
