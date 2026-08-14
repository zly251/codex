import fs from "node:fs";
import path from "node:path";
import { DATA_ROOT } from "./paths.js";

const CHAT_STATE_PATH =
  process.env.JOB_AGENT_CHAT_STATE_PATH ||
  path.join(DATA_ROOT, "data", "chat-state.json");

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(CHAT_STATE_PATH, "utf8")) || {};
  } catch (e) {
    cache = {};
  }
  return cache;
}

function save() {
  try {
    fs.mkdirSync(path.dirname(CHAT_STATE_PATH), { recursive: true });
    fs.writeFileSync(CHAT_STATE_PATH, JSON.stringify(cache, null, 2), "utf8");
  } catch (e) {}
}

export function chatKey(chat) {
  const name = String(chat?.name || "").trim();
  const company = String(chat?.company || "").trim();
  const msg = String(chat?.msg || "").trim();
  const rowId = String(chat?.rowId || chat?.sessionKey || "").trim();
  const href = String(chat?.href || "").trim();
  // 会话身份优先级：rowId/sessionKey > href > name|company，
  // 避免两个不同会话因同名同公司同消息撞 key。
  const identity =
    rowId || href || (name || company ? `${name}|${company}` : "unknown");
  return `${identity}|${msg}`;
}

export function resumeChatKey(chat) {
  const name = String(chat?.name || "").trim();
  const company = String(chat?.company || "").trim();
  const rowId = String(chat?.rowId || chat?.sessionKey || "").trim();
  const href = String(chat?.href || "").trim();
  const identity =
    rowId || href || (name || company ? `${name}|${company}` : "unknown");
  return `resume:${identity}`;
}

export function resumeScreenshotChatKey(chat) {
  const name = String(chat?.name || "").trim();
  const company = String(chat?.company || "").trim();
  const rowId = String(chat?.rowId || chat?.sessionKey || "").trim();
  const href = String(chat?.href || "").trim();
  const identity =
    rowId || href || (name || company ? `${name}|${company}` : "unknown");
  return `resumeScreenshot:${identity}`;
}

export function shouldReply(chat) {
  const key = chatKey(chat);
  if (!key || key === "|") return false;
  const state = load();
  const entry = state[key];
  if (!entry) return true;
  if (entry.manualPending) return false;
  return !entry.replied;
}

export function markReplied(chat, reply, result) {
  const key = chatKey(chat);
  if (!key || key === "|") return;
  const state = load();
  state[key] = {
    replied: true,
    repliedAt: new Date().toISOString(),
    reply: String(reply || "").slice(0, 300),
    ok: !!(result && result.ok !== false),
  };
  save();
}

export function markManualPending(chat, reason, result) {
  const key = chatKey(chat);
  if (!key || key === "|") return;
  const state = load();
  state[key] = {
    manualPending: true,
    reason: String(reason || "").slice(0, 200),
    markedAt: new Date().toISOString(),
    replied: false,
    reply: "",
    ok: false,
  };
  save();
}

export function shouldTryResume(chat, nowMs = Date.now()) {
  const key = resumeChatKey(chat);
  if (!key || key === "resume:unknown") return false;
  const state = load();
  const entry = state[key];
  if (!entry) return true;
  if (entry.ok) return false;
  const attemptedAt = entry.attemptedAt ? new Date(entry.attemptedAt).getTime() : 0;
  if (!attemptedAt) return true;
  const waitMs = entry.reason === "resume_unavailable" ? 90000 : 60000;
  return nowMs - attemptedAt >= waitMs;
}

export function shouldTryResumeScreenshot(chat, nowMs = Date.now()) {
  const key = resumeScreenshotChatKey(chat);
  if (!key || key === "resumeScreenshot:unknown") return false;
  const state = load();
  const entry = state[key];
  if (!entry) return true;
  if (entry.ok) return false;
  const attemptedAt = entry.attemptedAt ? new Date(entry.attemptedAt).getTime() : 0;
  if (!attemptedAt) return true;
  const waitMs = entry.reason === "resume_unavailable" ? 90000 : 60000;
  return nowMs - attemptedAt >= waitMs;
}

export function markResumeAttempted(chat, result, nowMs = Date.now()) {
  const key = resumeChatKey(chat);
  if (!key || key === "resume:unknown") return;
  const state = load();
  state[key] = {
    attemptedAt: new Date(nowMs).toISOString(),
    ok: !!(result && result.ok !== false),
    reason: String(result?.reason || ""),
    fileName: String(result?.fileName || ""),
  };
  save();
}

export function markResumeScreenshotAttempted(chat, result, nowMs = Date.now()) {
  const key = resumeScreenshotChatKey(chat);
  if (!key || key === "resumeScreenshot:unknown") return;
  const state = load();
  state[key] = {
    attemptedAt: new Date(nowMs).toISOString(),
    ok: !!(result && result.ok !== false),
    reason: String(result?.reason || ""),
    fileName: String(result?.fileName || ""),
  };
  save();
}

export function getChatStatePath() {
  return CHAT_STATE_PATH;
}
