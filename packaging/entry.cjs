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
      const ps = "Get-CimInstance Win32_Process -Filter \"Name='firefox.exe' OR Name='msedge.exe' OR Name='chrome.exe' OR Name='chromium.exe'\" | Where-Object { $_.CommandLine -like '*" + profileDir.replace(/'/g, "''") + "*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
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

function getTrayScriptPath(ROOT) {
  const roots = [
    ROOT,
    process.env.JOB_AGENT_DATA_DIR,
    process.env.JOB_AGENT_ROOT,
    path.resolve(__dirname, '..'),
  ].filter(Boolean);
  for (const root of roots) {
    try {
      const trayScript = path.join(root, 'scripts', 'tray_agent.ps1');
      if (fs.existsSync(trayScript)) return trayScript;
    } catch (e) {}
  }
  return null;
}

function getWindowsPowerShellPath() {
  if (PLATFORM !== 'win32') return null;
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const candidates = [
    path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (e) {}
  }
  return 'powershell.exe';
}

function isSeaRuntime() {
  try {
    return !!require('node:sea').isSea();
  } catch (e) {
    return false;
  }
}

function ensureTray(ROOT) {
  if (PLATFORM !== 'win32') return;
  const trayScript = getTrayScriptPath(ROOT);
  if (!trayScript) {
    appendWatchdogLog('tray script not found, skip tray agent');
    return;
  }
  appendWatchdogLog('tray script resolved: ' + trayScript);
  const powershellExe = getWindowsPowerShellPath();
  appendWatchdogLog('tray powershell exe: ' + powershellExe);
  appendWatchdogLog('tray starting via Start-Process');
  const psQuote = function (value) {
    return "'" + String(value).replace(/'/g, "''") + "'";
  };
  const startCommand = 'Start-Process -FilePath ' + psQuote(powershellExe) +
    ' -ArgumentList ' + psQuote('-NoProfile') + ',' + psQuote('-ExecutionPolicy') + ',' +
    psQuote('Bypass') + ',' + psQuote('-STA') + ',' + psQuote('-WindowStyle') + ',' +
    psQuote('Hidden') + ',' + psQuote('-File') + ',' + psQuote(trayScript) +
    ' -WindowStyle Hidden';
  try {
    const dataRoot = ROOT || process.env.JOB_AGENT_DATA_DIR || process.env.JOB_AGENT_ROOT;
    const previousEnv = {};
    const envVars = {
      JOB_AGENT_PORT: String(PORT),
    };
    if (dataRoot) envVars.JOB_AGENT_DATA_DIR = dataRoot;
    if (isSeaRuntime()) envVars.JOB_AGENT_EXE = process.execPath;
    for (const name of Object.keys(envVars)) {
      previousEnv[name] = process.env[name];
      process.env[name] = envVars[name];
    }
    try {
      execFileSync(powershellExe, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', startCommand], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 15000,
      });
      appendWatchdogLog('tray Start-Process launched');
    } finally {
      for (const name of Object.keys(envVars)) {
        if (previousEnv[name] === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = previousEnv[name];
        }
      }
    }
  } catch (e) {
    appendWatchdogLog('tray agent start failed: ' + (e && e.message));
  }
}

async function launchBrowser() {
  if (edgeLock) return false;
  edgeLock = true;
  try {
    // 已存在 CDP 实例时直接复用，绝不 kill 掉正在登录/使用的浏览器。
    if (await cdpPortOpen()) {
      appendWatchdogLog('CDP already open, reuse existing browser');
      return true;
    }
    const exe = findBrowserPath();
    if (!exe) {
      appendWatchdogLog('browser exe not found');
      return false;
    }
    const dataRoot = process.env.JOB_AGENT_DATA_DIR || process.env.JOB_AGENT_ROOT || process.cwd();
    const base = path.join(dataRoot, '..');
    if (!process.env.JOB_AGENT_PROFILE_DIR) process.env.JOB_AGENT_PROFILE_DIR = path.join(base, '.edge-profile');
    if (!process.env.JOB_AGENT_FALLBACK_PROFILE_DIR) process.env.JOB_AGENT_FALLBACK_PROFILE_DIR = path.join(base, '.edge-profile-2');
    const profiles = [
      process.env.JOB_AGENT_PROFILE_DIR,
      process.env.JOB_AGENT_FALLBACK_PROFILE_DIR,
    ];
    for (const dir of profiles) {
      try {
        killProfileProcesses(dir);
        fs.mkdirSync(dir, { recursive: true });
        const args = [
          '--remote-debugging-port=' + CDP_PORT,
          '--remote-allow-origins=*',
          '--user-data-dir=' + dir,
          '--start-maximized',
          '--no-first-run',
          '--disable-notifications',
          '--disable-features=CalculateNativeWinOcclusion',
          '--disable-backgrounding-occluded-windows',
          process.env.JOB_AGENT_START_URL || 'https://www.zhipin.com',
        ];
        const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: PLATFORM === 'win32' });
        child.unref();
        const ok = await waitFor('http://127.0.0.1:' + CDP_PORT + '/json/version', 30000);
        if (ok) {
          appendWatchdogLog('browser launched with profile ' + dir);
          return true;
        }
      } catch (e) {
        appendWatchdogLog('browser launch failed: ' + (e && e.message));
      }
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
    const browser = globalThis.__JOB_AGENT_BROWSER__;
    if (browser?.connected) {
      const pages = await browser.pages();
      let appPage = pages.find(function (p) {
        try {
          return p.url().startsWith(SERVER_URL);
        } catch (e) {
          return false;
        }
      });
      if (!appPage) appPage = await browser.newPage();
      await appPage.goto(SERVER_URL, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(function () {});
      await appPage.bringToFront().catch(function () {});
      return;
    }
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
  if (!globalThis.__JOB_AGENT_BROWSER__?.connected) {
    await launchBrowser();
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
    if (!(await isOurServer())) {
      appendWatchdogLog('server unavailable, watchdog paused');
      failures = 0;
      return;
    }
    let connected = false;
    try {
      const res = await fetch(SERVER_URL + '/api/boss/status', { signal: AbortSignal.timeout(3000) });
      const data = await res.json();
      connected = !!data.browserConnected;
    } catch (e) {}
    if (connected) {
      failures = 0;
      return;
    }
    failures++;
    appendWatchdogLog('browser disconnected, failure ' + failures);
    if (failures < 3) return;
    failures = 0;
    appendWatchdogLog('relaunching browser');
    console.error('[watchdog] browser disconnected for 3 checks, relaunching...');
    try {
      if (!globalThis.__JOB_AGENT_BROWSER__?.connected) await launchBrowser();
      await fetch(SERVER_URL + '/api/boss/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: '127.0.0.1', port: CDP_PORT }),
        signal: AbortSignal.timeout(10000),
      }).catch(function () {});
    } catch (e) {
      console.error('[watchdog] browser relaunch error: ' + (e && e.message));
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
    ensureTray(ROOT);
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

    if (!(await isOurServer())) {
      appendWatchdogLog('server failed to start, exit without launching edge');
      process.exit(1);
    }
  }

  await ensureEdgeConnected();

  startEdgeWatchdog();

  ensureTray(ROOT);

  if (process.env.JOB_AGENT_NO_OPEN !== '1') {
    await openAppPage();
  }
}

main();
