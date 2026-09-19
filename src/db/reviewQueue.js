// Autonomous Job Search Agent
// M2: 待人工确认队列（REVIEW 桶）建表 + 访问层
// 本文件自建表（不改 schema.js），依赖 src/db/index.js 的 getDb()。
// 约束：jobId 与 Application.jobId 一样全局唯一（同一岗位在队列里只有一条待确认记录）。
import { getDb } from "./index.js";

const REVIEW_QUEUE_SQL = [
    'CREATE TABLE IF NOT EXISTS ReviewQueue (',
    '  id          INTEGER PRIMARY KEY AUTOINCREMENT,',
    '  jobId       INTEGER NOT NULL UNIQUE REFERENCES Job(id),',
    '  score       REAL,',
    '  decision    TEXT NOT NULL DEFAULT "REVIEW",',
    '  reason      TEXT,',
    '  status      TEXT NOT NULL DEFAULT "pending",',
    '  createdAt   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,',
    '  updatedAt   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP',
    ');',
    'CREATE INDEX IF NOT EXISTS idx_review_queue_status ON ReviewQueue(status);',
].join('\n');

export function ensureTable() {
    var d = getDb();
    d.exec(REVIEW_QUEUE_SQL);
    return true;
}

function assertReady() {
    ensureTable();
    return getDb();
}

/**
 * 幂等入队：同一 jobId 只保留一条记录。
 * 已存在时只刷新分数/理由与 updatedAt；status 不回退（rejected 不会被重新打回 pending）。
 */
export function enqueue(data) {
    var d = assertReady();
    if (!data || !data.jobId)
        return null;
    var existing = findByJobId(data.jobId);
    if (existing) {
        d.prepare("UPDATE ReviewQueue SET score = ?, decision = ?, reason = COALESCE(?, reason), updatedAt = datetime('now') WHERE id = ?")
            .run(data.score ?? null, data.decision || "REVIEW", data.reason || null, existing.id);
        return findById(existing.id);
    }
    var info = d.prepare("INSERT INTO ReviewQueue (jobId, score, decision, reason, status) VALUES (?, ?, ?, ?, ?)")
        .run(data.jobId, data.score ?? null, data.decision || "REVIEW", data.reason || null, data.status || "pending");
    return findById(info.lastInsertRowid);
}

export function findById(id) { return assertReady().prepare("SELECT * FROM ReviewQueue WHERE id = ?").get(id); }
export function findByJobId(jobId) { return assertReady().prepare("SELECT * FROM ReviewQueue WHERE jobId = ?").get(jobId); }

/** 单条消费：approved -> consumed（真正进入本次执行计划时调用）。 */
export function markConsumed(id) {
    var d = assertReady();
    return d.prepare("UPDATE ReviewQueue SET status = 'consumed', updatedAt = datetime('now') WHERE id = ? AND status = 'approved'").run(id).changes > 0;
}

/** 回退：把已 consumed / approved 但未真正投递的记录放回 approved，下次投递重试。 */
export function releaseToApproved(ids) {
    var d = assertReady();
    var stmt = d.prepare("UPDATE ReviewQueue SET status = 'approved', updatedAt = datetime('now') WHERE id = ? AND status IN ('consumed','approved')");
    var n = 0;
    for (var i = 0; i < (ids || []).length; i++) {
        n += stmt.run(ids[i]).changes;
    }
    return n;
}

/** 按状态列出（默认 pending，按分数降序）。 */
export function list(status) {
    var d = assertReady();
    if (status) {
        return d.prepare("SELECT * FROM ReviewQueue WHERE status = ? ORDER BY score DESC, id ASC").all(status);
    }
    return d.prepare("SELECT * FROM ReviewQueue ORDER BY score DESC, id ASC").all();
}

export function findPending() { return list("pending"); }

/** 批准：置 approved，下次投递入口会取出并转入投递集合。 */
export function approve(id) {
    var d = assertReady();
    return d.prepare("UPDATE ReviewQueue SET status = 'approved', updatedAt = datetime('now') WHERE id = ?").run(id).changes > 0;
}

/** 拒绝：置 rejected，不再进入投递集合。 */
export function reject(id) {
    var d = assertReady();
    return d.prepare("UPDATE ReviewQueue SET status = 'rejected', updatedAt = datetime('now') WHERE id = ?").run(id).changes > 0;
}

export function findApproved() {
    var d = assertReady();
    return d.prepare("SELECT * FROM ReviewQueue WHERE status = 'approved' ORDER BY score DESC, id ASC").all();
}

/**
 * 取出已批准的岗位 id 并原子地标记 consumed（消费后不会被重复投递）。
 * 返回 consumed 的记录列表（含 jobId），调用方据此回查 Job 行。
 * 注意：调用方若因 limit/配额/dry-run 未真正投递，应把对应记录 setStatus 回 "approved"
 * 以便下次重试。
 */
export function consumeApproved(limit) {
    var d = assertReady();
    var rows = d.prepare("SELECT * FROM ReviewQueue WHERE status = 'approved' ORDER BY score DESC, id ASC").all();
    var taken = typeof limit === "number" && limit > 0 ? rows.slice(0, limit) : rows;
    var out = [];
    var stmt = d.prepare("UPDATE ReviewQueue SET status = 'consumed', updatedAt = datetime('now') WHERE id = ?");
    for (var i = 0; i < taken.length; i++) {
        var info = stmt.run(taken[i].id);
        if (info.changes > 0) {
            out.push(Object.assign({}, taken[i], { status: "consumed" }));
        }
    }
    return out;
}

export function countByStatus() {
    var d = assertReady();
    var rows = d.prepare("SELECT status, COUNT(*) as cnt FROM ReviewQueue GROUP BY status").all();
    var stats = { pending: 0, approved: 0, rejected: 0, consumed: 0 };
    for (var i = 0; i < rows.length; i++) {
        stats[rows[i].status] = rows[i].cnt;
    }
    return stats;
}

export function remove(id) { return assertReady().prepare("DELETE FROM ReviewQueue WHERE id = ?").run(id).changes > 0; }
