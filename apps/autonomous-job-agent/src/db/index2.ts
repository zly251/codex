// Autonomous Job Search Agent
// Database connection & initialization

import { DatabaseSync } from "node:sqlite";
import { unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_SQL } from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, "../../prisma/dev.db");

let db = null;

export function getDb() {
  if (!db) {
    db = new DatabaseSync(DB_PATH);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
  }
  return db;
}

export function getDbPath() {
  return DB_PATH;
}

export function initDb() {
  const d = getDb();
  d.exec(SCHEMA_SQL);
  console.log("[db] DB ready: " + DB_PATH);
}

export function resetDb() {
  if (db) {
    db.close();
    db = null;
  }
  try { unlinkSync(DB_PATH); } catch {}
  initDb();
}

export function getDbInfo() {
  const d = getDb();
  const rows = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  return { path: DB_PATH, tableCount: rows.length };
}
