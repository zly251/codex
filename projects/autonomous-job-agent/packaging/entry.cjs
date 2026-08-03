'use strict';

require('./setup-sea.cjs');

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');

const SERVER_URL = 'http://127.0.0.1:' + (process.env.PORT || 3456);
const CDP_PORT = 9222;
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

function findEdgePath() {
  const candidates = [
    process.env.EDGE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge Beta\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge Beta\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge Dev\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge Dev\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge Canary\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge Canary\\Application\\msedge.exe',
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (e) {}
  }
  return null;
}

function killProfileProcesses(profileDir) {
  try {
    const ps = "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -like '*" + profileDir.replace(/'/g, "''") + "*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
    execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'ignore', timeout: 8000, windowsHide: true });
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
    const ps = "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Select-Object -ExpandProperty CommandLine";
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 8000, windowsHide: true });
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

function cdpPortOpen() {
  try {
    const ps = "(Get-NetTCPConnection -State Listen -LocalPort " + CDP_PORT + " -ErrorAction SilentlyContinue | Measure-Object).Count";
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    const n = parseInt((out || '').trim(), 10);
    return n > 0;
  } catch (e) {
    return false;
  }
}

function appendWatchdogLog(msg) {
  try {
    const root = process.env.JOB_AGENT_ROOT;
    if (!root) return;
    fs.appendFileSync(path.join(root, 'data', 'watchdog.log'), new Date().toISOString() + ' ' + msg + '\n');
  } catch (e) {}
}

async function launchEdge() {
  if (edgeLock) return false;
  edgeLock = true;
  const exe = findEdgePath();
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
        'https://www.zhipin.com',
      ];
      const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true });
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
    const child = spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch (e) {}
}

function startEdgeWatchdog() {
  let failures = 0;
  setInterval(async function () {
    if (process.env.JOB_AGENT_NO_EDGE === '1') return;
    const portOk = cdpPortOpen();
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
  const ROOT = process.env.JOB_AGENT_ROOT;
  const serverRunning = await waitFor(SERVER_URL + '/api/stats', 2000);
  if (!serverRunning) {
    const serverPath = process.env.JOB_AGENT_SERVER_BUNDLE || path.join(ROOT, 'server', 'server.cjs');
    try {
      createRequire(process.execPath)(serverPath);
    } catch (e) {
      console.error('[launcher] server failed: ' + (e && e.stack || e));
    }
    await waitFor(SERVER_URL + '/api/stats', 20000);
  }

  if (process.env.JOB_AGENT_NO_EDGE !== '1') {
    let cdpOpen = await waitFor('http://127.0.0.1:' + CDP_PORT + '/json/version', 1500);
    if (cdpOpen && process.env.JOB_AGENT_PROFILE_DIR) {
      const running = getRunningProfile();
      const matchesPreferred = running &&
        normalizeProfile(running) === normalizeProfile(process.env.JOB_AGENT_PROFILE_DIR) &&
        hasCookies(running);
      if (!matchesPreferred) {
        if (running) killProfileProcesses(running);
        await new Promise((r) => setTimeout(r, 800));
        cdpOpen = false;
      }
    }
    if (!cdpOpen) {
      await launchEdge();
    }

    try {
      await fetch(SERVER_URL + '/api/boss/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: '127.0.0.1', port: CDP_PORT }),
        signal: AbortSignal.timeout(10000),
      });
    } catch (e) {}
  }

  startEdgeWatchdog();

  if (process.env.JOB_AGENT_NO_OPEN !== '1') {
    openUrl(SERVER_URL);
  }
}

main();
