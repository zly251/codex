// Autonomous Job Search Agent
// Database connection & initialization
import { DatabaseSync } from "node:sqlite";
import { unlinkSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { SCHEMA_SQL } from "./schema.js";
var __dirname = (function(){ try { return dirname(fileURLToPath(import.meta.url)); } catch (e) { return process.cwd(); } })();
var DB_PATH = join(tmpdir(), "autonomous-job-agent", "dev.db");
var db = null;
export function getDb() {
    if (!db) {
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
