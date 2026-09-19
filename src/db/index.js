// Autonomous Job Search Agent
// Database connection & initialization
import { DatabaseSync } from "node:sqlite";
import { unlinkSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { SCHEMA_SQL } from "./schema.js";
import { DATA_ROOT as APP_DATA_ROOT } from "../paths.js";
var DATA_ROOT = process.env.JOB_AGENT_DATA_DIR || APP_DATA_ROOT;
var DB_PATH = process.env.JOB_AGENT_DB_PATH || join(DATA_ROOT, "data", "job-agent.db");
var LEGACY_DB_PATH = join(tmpdir(), "autonomous-job-agent", "dev.db");
var db = null;

function migrateLegacyDb() {
  try {
    if (existsSync(DB_PATH) || !existsSync(LEGACY_DB_PATH)) return;
    var dir = dirname(DB_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    copyFileSync(LEGACY_DB_PATH, DB_PATH);
    console.log("[db] migrated legacy DB to " + DB_PATH);
  } catch (e) {
    console.error("[db] migrate legacy DB failed: " + (e && e.message));
  }
}

// M1: 距离/宿舍列迁移。老库（表已存在）不会重跑 CREATE TABLE，故用逐列
// ALTER，重复列（"duplicate column name"）直接忽略，幂等。
function migrateJobDistanceColumns() {
  var d = getDb();
  var alters = [
    "ALTER TABLE Job ADD COLUMN lng REAL",
    "ALTER TABLE Job ADD COLUMN lat REAL",
    "ALTER TABLE Job ADD COLUMN distanceKm REAL",
    "ALTER TABLE Job ADD COLUMN distanceTier TEXT",
    "ALTER TABLE Job ADD COLUMN hasDormitory INTEGER",
    "ALTER TABLE Job ADD COLUMN dormitorySource TEXT",
  ];
  for (var i = 0; i < alters.length; i++) {
    try {
      d.exec(alters[i] + ";");
      console.log("[db] job column added: " + alters[i]);
    } catch (e) {
      // 列已存在 -> 忽略；其它错误也仅告警，不阻断启动
      if (!/duplicate column name/i.test(String(e && e.message))) {
        console.error("[db] migrate job columns failed: " + (e && e.message));
      }
    }
  }
}

function applicationStatusRank(status) {
  if (status === "offer") return 5;
  if (status === "interview") return 4;
  if (status === "rejected") return 3;
  if (status === "replied") return 2;
  if (status === "viewed") return 1;
  return 0;
}

function migrateDuplicateApplications() {
  var d = getDb();
  var dupRows = d.prepare("SELECT jobId FROM Application WHERE jobId IS NOT NULL GROUP BY jobId HAVING COUNT(*) > 1").all();
  if (dupRows.length === 0) return;
  var mergeStmt = d.prepare(
    "UPDATE Application SET status = ?, notes = ?, appliedAt = ?, viewedAt = COALESCE(viewedAt, ?), repliedAt = COALESCE(repliedAt, ?), interviewAt = COALESCE(interviewAt, ?), offerAt = COALESCE(offerAt, ?), feedback = COALESCE(feedback, ?), resumeId = COALESCE(resumeId, ?), updatedAt = datetime('now') WHERE id = ?"
  );
  var deleteStmt = d.prepare("DELETE FROM Application WHERE id = ?");
  for (var i = 0; i < dupRows.length; i++) {
    var apps = d.prepare("SELECT * FROM Application WHERE jobId = ? ORDER BY id ASC").all(dupRows[i].jobId);
    var keeper = apps[0];
    for (var j = 1; j < apps.length; j++) {
      if (applicationStatusRank(apps[j].status) > applicationStatusRank(keeper.status)) keeper = apps[j];
    }
    for (var k = 0; k < apps.length; k++) {
      var app = apps[k];
      if (app.id === keeper.id) continue;
      var higher = applicationStatusRank(app.status) > applicationStatusRank(keeper.status);
      var nextStatus = higher ? app.status : keeper.status;
      var nextNotes = higher ? (app.notes || keeper.notes) : (keeper.notes || app.notes);
      var nextAppliedAt = app.appliedAt && (!keeper.appliedAt || app.appliedAt < keeper.appliedAt) ? app.appliedAt : keeper.appliedAt;
      mergeStmt.run(nextStatus, nextNotes, nextAppliedAt, app.viewedAt, app.repliedAt, app.interviewAt, app.offerAt, app.feedback, app.resumeId, keeper.id);
      deleteStmt.run(app.id);
    }
  }
  console.log("[db] merged duplicate applications: " + dupRows.length + " jobs");
}

export function getDb() {
    if (!db) {
        migrateLegacyDb();
        var dir = dirname(DB_PATH);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        db = new DatabaseSync(DB_PATH);
        db.exec("PRAGMA journal_mode = DELETE");
        db.exec("PRAGMA foreign_keys = ON");
    }
    return db;
}
export function getDbPath() { return DB_PATH; }
export function initDb() {
    var d = getDb();
    d.exec(SCHEMA_SQL);
    migrateJobDistanceColumns();
    migrateDuplicateApplications();
    d.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_application_jobId_unique ON Application(jobId);");
    console.log("[db] DB ready: " + DB_PATH);
}
export function resetDb() {
    if (db) {
        db.close();
        db = null;
    }
    try {
        unlinkSync(DB_PATH);
    }
    catch (e) { }
    try {
        unlinkSync(DB_PATH + "-journal");
    }
    catch (e) { }
    try {
        unlinkSync(DB_PATH + "-wal");
    }
    catch (e) { }
    try {
        unlinkSync(DB_PATH + "-shm");
    }
    catch (e) { }
    initDb();
}
export function getDbInfo() {
    var d = getDb();
    var rows = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    return { path: DB_PATH, tableCount: rows.length };
}
