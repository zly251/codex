import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = (function(){ try { return path.dirname(fileURLToPath(import.meta.url)); } catch (e) { return process.cwd(); } })();
export const PROJECT_ROOT = process.env.JOB_AGENT_ROOT || path.join(__dirname, "..");
export const DEFAULT_PROFILE = process.env.JOB_AGENT_PROFILE_DIR || path.join(PROJECT_ROOT, ".edge-profile");
export const FALLBACK_PROFILE = process.env.JOB_AGENT_FALLBACK_PROFILE_DIR || path.join(PROJECT_ROOT, ".edge-profile-2");

const PLATFORM = process.platform;
const BROWSER_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge Beta\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge Beta\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge Dev\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge Dev\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge Canary\\Application\\msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/microsoft-edge",
  "/opt/google/chrome/chrome",
  "/snap/bin/chromium",
].filter(Boolean);

function commandPath(cmd) {
  try {
    const out = execFileSync(PLATFORM === "win32" ? "where" : "which", [cmd], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    const p = (out || "").trim().split(/\r?\n/)[0];
    return p && fs.existsSync(p) ? p : null;
  } catch (e) {
    return null;
  }
}

function findBrowserPath() {
  const envPath = process.env.BROWSER_PATH || process.env.EDGE_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;
  for (const p of BROWSER_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch (e) {}
  }
  for (const cmd of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"]) {
    const p = commandPath(cmd);
    if (p) return p;
  }
  return null;
}

export const findEdgePath = findBrowserPath;

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
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 900));
  }
  throw new Error("浏览器 CDP 端口未就绪: " + (lastErr?.message || "timeout"));
}

function killProcessesByProfileWindows(dir) {
  const ps = "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' OR Name='chrome.exe' OR Name='chromium.exe'\" | Where-Object { $_.CommandLine -like '*" + dir.replace(/'/g, "''") + "*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
  execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], { stdio: "ignore", timeout: 8000, windowsHide: true });
}

function killProcessesByProfileUnix(dir) {
  execFileSync("pkill", ["-f", "--", "--user-data-dir=" + dir], { stdio: "ignore", timeout: 8000 });
}

function killBrowserProfile(dir) {
  try {
    if (PLATFORM === "win32") killProcessesByProfileWindows(dir);
    else killProcessesByProfileUnix(dir);
  } catch (e) {}
}

function parseProfileFromLines(lines, port) {
  for (const line of lines) {
    if (line.indexOf("--remote-debugging-port=" + port) === -1) continue;
    const m = line.match(/--user-data-dir=(?:"([^"]+)"|([^\s]+))/);
    if (m) return m[1] || m[2];
  }
  return null;
}

function getRunningProfile(port) {
  try {
    if (PLATFORM === "win32") {
      const ps = "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' OR Name='chrome.exe' OR Name='chromium.exe'\" | Select-Object -ExpandProperty CommandLine";
      const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf8", timeout: 8000, windowsHide: true });
      return parseProfileFromLines((out || "").split(/\r?\n/), port);
    }
    const out = execFileSync("ps", ["-eo", "args"], { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] });
    return parseProfileFromLines((out || "").split(/\r?\n/), port);
  } catch (e) {
    return null;
  }
}

export async function launchEdge({ profileDir, url = "https://www.zhipin.com", host = "127.0.0.1", port = 9222 } = {}) {
  const exe = findBrowserPath();
  if (!exe) throw new Error("未找到浏览器，请安装 Edge/Chrome/Chromium 或设置 BROWSER_PATH");
  const dir = profileDir || DEFAULT_PROFILE;
  try {
    const existing = await waitForCDP(host, port, 1500);
    if (existing) return { exe, dir, pid: 0, alreadyRunning: true };
  } catch (e) {}
  const running = getRunningProfile(port);
  if (running) killBrowserProfile(running);
  fs.mkdirSync(dir, { recursive: true });
  const args = [
    `--remote-debugging-port=${port}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${dir}`,
    "--start-maximized",
    "--no-first-run",
    "--disable-notifications",
    "--disable-features=CalculateNativeWinOcclusion",
    "--disable-backgrounding-occluded-windows",
    url,
  ];
  const child = spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: PLATFORM === "win32" });
  child.unref();
  return { exe, dir, pid: child.pid };
}
