import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = (function () {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch (e) {
    return process.cwd();
  }
})();

export const PROJECT_ROOT =
  process.env.JOB_AGENT_ROOT || path.join(__dirname, "..");

function resolveDataRoot() {
  const explicit = process.env.JOB_AGENT_DATA_DIR;
  if (explicit) return explicit;
  return path.basename(PROJECT_ROOT).toLowerCase() === "portable"
    ? PROJECT_ROOT
    : path.join(PROJECT_ROOT, "portable");
}

export const DATA_ROOT = resolveDataRoot();
export const PROFILE_PATH =
  process.env.JOB_AGENT_PROFILE_PATH ||
  path.join(DATA_ROOT, "data", "profile.json");
export const RESUME_DIR =
  process.env.JOB_AGENT_RESUME_DIR || path.join(DATA_ROOT, "resumes");
export const RESUME_EDITOR_PATH =
  process.env.JOB_AGENT_RESUME_EDITOR_PATH ||
  path.join(RESUME_DIR, "resume-editor.json");
export const CHAT_PATH =
  process.env.JOB_AGENT_CHAT_PATH ||
  path.join(DATA_ROOT, "data", "chat.json");
export const COOKIE_PATH =
  process.env.JOB_AGENT_COOKIE_PATH ||
  path.join(DATA_ROOT, "data", "boss-cookies.json");

export function ensureDataDirs() {
  fs.mkdirSync(path.dirname(PROFILE_PATH), { recursive: true });
  fs.mkdirSync(RESUME_DIR, { recursive: true });
}
