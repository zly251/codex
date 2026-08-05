'use strict';

require('./setup-sea.cjs');

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');

const SERVER_URL = 'http://127.0.0.1:' + (process.env.PORT || 3456);
const PORT = Number(process.env.PORT) || 3456;
const CDP_PORT = 9222;
const PLATFORM = process.platform;
let edgeLock = false;

async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function getServerPid() {
  try {
    if (PLATFORM === 'win32') {
      const ps = "(Get-NetTCPConnection -State Listen -LocalPort " + PORT + " -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | Select-Object -First 1)";
      const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 8000, windowsHide: true });
      const n = parseInt((out || '').trim(), 10);
      return Number.isFinite(n) ? n : null;
    }
    try {
      const out = execFileSync('lsof', ['-ti', 'tcp:' + PORT], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      const n = parseInt((out || '').trim().split(/\r?\n/)[0], 10);
      if (Number.isFinite(n)) return n;
    } catch (e) {}
    const netstat = execFileSync('netstat', ['-tlnp'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    for (const line of (netstat || '').split(/\r?\n/)) {
      if (line.indexOf(':' + PORT) === -1) continue;
      const m = line.match(/\s(\d+)\/(\S+)/);
      if (m) return Number(m[1]);
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function isOurServer() {
  try {
    const res = await fetch(SERVER_URL + '/api/boss/status', { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return false;
    const data = await res.json();
    return data && typeof data.browserConnected === 'boolean';
  } catch (e) {
    return false;
  }
}

async function stopExistingInstance() {
  if (!(await isOurServer())) return false;
  const pid = getServerPid();
  if (!pid) return false;
  try {
    if (PLATFORM === 'win32') {
      execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Stop-Process -Id ' + pid + ' -Force'], { stdio: 'ignore', timeout: 8000, windowsHide: true });
    } else {
      execFileSync('kill', ['-9', String(pid)], { stdio: 'ignore', timeout: 8000 });
    }
  } catch (e) {}
  await new Promise((r) => setTimeout(r, 1500));
  return true;
}

function findBrowserPath() {
  const envPath = process.env.BROWSER_PATH || process.env.EDGE_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge Beta\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge Beta\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge Dev\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge Dev\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge Canary\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/opt/google/chrome/chrome',
    '/snap/bin/chromium',
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (e) {}
  }
  if (PLATFORM !== 'win32') {
    for (const cmd of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
      try {
        const out = execFileSync('which', [cmd], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
        const p = (out || '').trim().split(/\r?\n/)[0];
        if (p && fs.existsSync(p)) return p;
      } catch (e) {}
    }
  }
  return null;
}

const findEdgePath = findBrowserPath;

function killProfileProcesses(profileDir) {
  try {
    if (PLATFORM === 'win32') {
      const ps = "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' OR Name='chrome.exe' OR Name='chromium.exe'\" | Where-Object { $_.CommandLine -like '*" + profileDir.replace(/'/g, "''") + "*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
      execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'ignore', timeout: 8000, windowsHide: true });
    } else {
      execFileSync('pkill', ['-f', '--', '--user-data-dir=' + profileDir], { stdio: 'ignore', timeout: 8000 });
    }
  } catch (e) {}
}

function hasCookies(dir) {
  try {
    return fs.existsSync(path.join(dir, 'Default', 'Cookies')) ||
      fs.existsSync(path.join(dir, 'Default', 'Network', 'Cookies'));
  } catch (e) {
    return false;
  }
}

function normalizeProfile(p) {
  try {
    return path.resolve(String(p).trim().replace(/^"(.*)"$/, '$1'));
  } catch (e) {
    return String(p || '');
  }
}

function getRunningProfile() {
  try {
    let out = '';
    if (PLATFORM === 'win32') {
      const ps = "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' OR Name='chrome.exe' OR Name='chromium.exe'\" | Select-Object -ExpandProperty CommandLine";
      out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    } else {
      out = execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
    }
    const lines = out.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    for (const line of lines) {
      if (line.indexOf('--remote-debugging-port=' + CDP_PORT) === -1) continue;
      const m = line.match(/--user-data-dir=(?:"([^"]+)"|([^\s]+))/);
      if (m) return m[1] || m[2];
    }
    for (const line of lines) {
      const m = line.match(/--user-data-dir=(?:"([^"]+)"|([^\s]+))/);
      if (m) return m[1] || m[2];
    }
  } catch (e) {}
  return null;
}

async function cdpPortOpen() {
  try {
    return await waitFor('http://127.0.0.1:' + CDP_PORT + '/json/version', 1200);
  } catch (e) {
    return false;
  }
}

function appendWatchdogLog(msg) {
  try {
    const root = process.env.JOB_AGENT_DATA_DIR || process.env.JOB_AGENT_ROOT;
    if (!root) return;
    fs.appendFileSync(path.join(root, 'data', 'watchdog.log'), new Date().toISOString() + ' ' + msg + '\n');
  } catch (e) {}
}

async function launchEdge() {
  if (edgeLock) return false;
  edgeLock = true;
  const exe = findBrowserPath();
  try {
    if (!exe) return false;
    const profiles = [
      process.env.JOB_AGENT_PROFILE_DIR,
      process.env.JOB_AGENT_FALLBACK_PROFILE_DIR,
    ].filter(function (dir) {
      return dir && hasCookies(dir);
    });
    if (profiles.length === 0 && process.env.JOB_AGENT_PROFILE_DIR) profiles.push(process.env.JOB_AGENT_PROFILE_DIR);
    for (const dir of profiles) {
      killProfileProcesses(dir);
      fs.mkdirSync(dir, { recursive: true });
      const args = [
        '--remote-debugging-port=' + CDP_PORT,
        '--remote-allow-origins=*',
        '--user-data-dir=' + dir,
        '--start-maximized',
        '--no-first-run',
        '--disable-notifications',
        process.env.JOB_AGENT_START_URL || 'https://www.zhipin.com',
      ];
      const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: PLATFORM === 'win32' });
      child.unref();
      if (await waitFor('http://127.0.0.1:' + CDP_PORT + '/json/version', 20000)) return true;
    }
    return false;
  } finally {
    edgeLock = false;
  }
}

function openUrl(url) {
  try {
    let cmd;
    let args;
    if (PLATFORM === 'win32') {
      cmd = 'cmd.exe';
      args = ['/c', 'start', '', url];
    } else if (PLATFORM === 'darwin') {
      cmd = 'open';
      args = [url];
    } else {
      cmd = 'xdg-open';
      args = [url];
    }
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: PLATFORM === 'win32' });
    child.unref();
  } catch (e) {}
}

function isAppTarget(t) {
  if (!t || t.type !== "page") return false;
  const u = t.url || "";
  return u.startsWith("http://127.0.0.1:" + PORT) || u.startsWith("http://localhost:" + PORT);
}

async function closeTarget(id) {
  try {
    await fetch("http://127.0.0.1:" + CDP_PORT + "/json/close/" + encodeURIComponent(id), {
      method: "PUT",
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {}
}

async function activateTarget(id) {
  try {
    await fetch("http://127.0.0.1:" + CDP_PORT + "/json/activate/" + encodeURIComponent(id), {
      method: "PUT",
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {}
}

async function openAppPage() {
  try {
    const res = await fetch("http://127.0.0.1:" + CDP_PORT + "/json/list", {
      signal: AbortSignal.timeout(5000),
    });
    const list = await res.json();
    const targets = (list || []).filter(isAppTarget);
    if (targets.length > 0) {
      const keep = targets[0];
      for (let i = 1; i < targets.length; i++) {
        await closeTarget(targets[i].id);
      }
      await activateTarget(keep.id);
      return;
    }
    const newRes = await fetch("http://127.0.0.1:" + CDP_PORT + "/json/new?" + encodeURIComponent(SERVER_URL), {
      method: "PUT",
      signal: AbortSignal.timeout(10000),
    });
    if (newRes.ok) return;
  } catch (e) {
    console.error("[launcher] open app page via CDP failed: " + (e && e.message));
  }
  openUrl(SERVER_URL);
}

async function ensureEdgeConnected() {
  if (process.env.JOB_AGENT_NO_EDGE === "1") return;
  let cdpOpen = await waitFor("http://127.0.0.1:" + CDP_PORT + "/json/version", 1500);
  if (cdpOpen && process.env.JOB_AGENT_PROFILE_DIR) {
    const running = getRunningProfile();
    const matchesPreferred = running &&
      normalizeProfile(running) === normalizeProfile(process.env.JOB_AGENT_PROFILE_DIR) &&
      hasCookies(running);
    if (!matchesPreferred) {
      if (running) killProfileProcesses(running);
      await new Promise(function (r) { setTimeout(r, 800); });
      cdpOpen = false;
    }
  }
  if (!cdpOpen) {
    await launchEdge();
  }
  try {
    await fetch(SERVER_URL + "/api/boss/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host: "127.0.0.1", port: CDP_PORT }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {}
}

function startEdgeWatchdog() {
  let failures = 0;
  setInterval(async function () {
    if (process.env.JOB_AGENT_NO_EDGE === '1') return;
    const portOk = await cdpPortOpen();
    if (portOk) {
      failures = 0;
      return;
    }
    failures++;
    appendWatchdogLog('cdp port down, failure ' + failures);
    if (failures < 3) return;
    failures = 0;
    appendWatchdogLog('relaunching edge');
    console.error('[watchdog] Edge CDP lost for 3 checks, relaunching...');
    try {
      const running = getRunningProfile();
      if (running) killProfileProcesses(running);
      await new Promise(function (r) { setTimeout(r, 1500); });
      const launched = await launchEdge();
      if (launched) {
        await fetch(SERVER_URL + '/api/boss/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ host: '127.0.0.1', port: CDP_PORT }),
          signal: AbortSignal.timeout(10000),
        }).catch(function () {});
      }
    } catch (e) {
      console.error('[watchdog] relaunch error: ' + (e && e.message));
    }
  }, 20000);
}

async function main() {
  const ROOT = process.env.JOB_AGENT_DATA_DIR || process.env.JOB_AGENT_ROOT;
  const serverRunning = await waitFor(SERVER_URL + '/api/stats', 2000);
  const replaced = serverRunning ? await stopExistingInstance() : false;
  if (serverRunning && !replaced) {
    await ensureEdgeConnected();
    startEdgeWatchdog();
    if (process.env.JOB_AGENT_NO_OPEN !== '1') {
      await openAppPage();
    }
    return;
  }
  if (!serverRunning || replaced) {
    const serverPath = process.env.JOB_AGENT_SERVER_BUNDLE || path.join(ROOT, 'server', 'server.cjs');
    try {
      createRequire(process.execPath)(serverPath);
    } catch (e) {
      console.error('[launcher] server failed: ' + (e && e.stack || e));
    }
    await waitFor(SERVER_URL + '/api/stats', 20000);
  }

  await ensureEdgeConnected();

  startEdgeWatchdog();

  if (process.env.JOB_AGENT_NO_OPEN !== '1') {
    await openAppPage();
  }
}

main();
