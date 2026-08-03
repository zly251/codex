import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = (function(){ try { return path.dirname(fileURLToPath(import.meta.url)); } catch (e) { return process.cwd(); } })();
export const PROJECT_ROOT = process.env.JOB_AGENT_ROOT || path.join(__dirname, "..");
export const DEFAULT_PROFILE = process.env.JOB_AGENT_PROFILE_DIR || path.join(PROJECT_ROOT, ".edge-profile");
export const FALLBACK_PROFILE = process.env.JOB_AGENT_FALLBACK_PROFILE_DIR || path.join(PROJECT_ROOT, ".edge-profile-2");

const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge Beta\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge Beta\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge Dev\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge Dev\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge Canary\\Application\\msedge.exe",
].filter(Boolean);

export function findEdgePath() {
  for (const p of EDGE_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch (e) {}
  }
  return null;
}

export async function waitForCDP(host = "127.0.0.1", port = 9222, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      const res = await fetch(`http://${host}:${port}/json/version`, { signal: controller.signal });
      clearTimeout(timer);
      const data = await res.json();
      if (data?.webSocketDebuggerUrl) return data.webSocketDebuggerUrl;
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 900));
  }
  throw new Error("Edge CDP 端口未就绪: " + (lastErr?.message || "timeout"));
}

export async function launchEdge({ profileDir, url = "https://www.zhipin.com", host = "127.0.0.1", port = 9222 } = {}) {
  const exe = findEdgePath();
  if (!exe) throw new Error("未找到 Edge，请安装 Microsoft Edge");
  const dir = profileDir || DEFAULT_PROFILE;
  try {
    const existing = await waitForCDP(host, port, 1500);
    if (existing) return { exe, dir, pid: 0, alreadyRunning: true };
  } catch (e) {}
  try {
    const ps = "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -like '*" + dir.replace(/'/g, "''") + "*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
    execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], { stdio: "ignore", timeout: 8000, windowsHide: true });
  } catch (e) {}
  fs.mkdirSync(dir, { recursive: true });
  const args = [
    `--remote-debugging-port=${port}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${dir}`,
    "--start-maximized",
    "--no-first-run",
    "--disable-notifications",
    url,
  ];
  const child = spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  return { exe, dir, pid: child.pid };
}
