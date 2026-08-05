'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function isSea() {
  try {
    return !!require('node:sea').isSea();
  } catch {
    return false;
  }
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function defaultRoot() {
  if (process.env.JOB_AGENT_DATA_DIR) return process.env.JOB_AGENT_DATA_DIR;
  const candidates = [
    process.env.JOB_AGENT_HOME,
    process.platform === 'win32' ? 'E:\\autonomous-job-agent' : null,
    path.join(os.homedir(), '.autonomous-job-agent'),
  ].filter(Boolean);
  const existing = candidates.find(function (p) { return fs.existsSync(p); });
  if (existing) return path.join(existing, 'portable');
  return path.join(os.homedir(), '.autonomous-job-agent', 'portable');
}

const ROOT = defaultRoot();
ensureDir(path.join(ROOT, 'data'));
ensureDir(path.join(ROOT, 'resumes'));

function hasCookies(dir) {
  try {
    return fs.existsSync(path.join(dir, 'Default', 'Cookies')) ||
      fs.existsSync(path.join(dir, 'Default', 'Network', 'Cookies'));
  } catch (e) {
    return false;
  }
}

function pickPrimaryProfile() {
  const legacy = process.platform === 'win32' ? 'E:\\autonomous-job-agent\\.edge-profile' : null;
  if (legacy && hasCookies(legacy)) return legacy;
  const portableProfile = path.join(ROOT, '.edge-profile');
  if (hasCookies(portableProfile)) return portableProfile;
  return portableProfile;
}

function migrateLegacyProfile() {
  const legacyProfile = process.platform === 'win32' ? 'E:\\autonomous-job-agent\\data\\profile.json' : null;
  if (!legacyProfile) return;
  const targetProfile = path.join(ROOT, 'data', 'profile.json');
  if (fs.existsSync(targetProfile) || !fs.existsSync(legacyProfile)) return;
  try {
    fs.copyFileSync(legacyProfile, targetProfile);
    console.error('[setup] profile migrated to ' + targetProfile);
  } catch (e) {
    console.error('[setup] profile migrate failed: ' + (e && e.message));
  }
}

function extractAssets() {
  const sea = require('node:sea');
  const assets = {
    'web/index.html': path.join(ROOT, 'web', 'index.html'),
    'tessdata/chi_sim.traineddata.gz': path.join(ROOT, 'tessdata', 'chi_sim.traineddata.gz'),
    'tessdata/eng.traineddata.gz': path.join(ROOT, 'tessdata', 'eng.traineddata.gz'),
    'server/server.cjs': path.join(ROOT, 'server', 'server.cjs'),
    'worker/worker.cjs': path.join(ROOT, 'worker', 'worker.cjs'),
    'worker/tesseract-core-relaxedsimd-lstm.wasm': path.join(ROOT, 'worker', 'tesseract-core-relaxedsimd-lstm.wasm'),
    'worker/tesseract-core-relaxedsimd.wasm': path.join(ROOT, 'worker', 'tesseract-core-relaxedsimd.wasm'),
    'worker/tesseract-core-simd-lstm.wasm': path.join(ROOT, 'worker', 'tesseract-core-simd-lstm.wasm'),
    'worker/tesseract-core-simd.wasm': path.join(ROOT, 'worker', 'tesseract-core-simd.wasm'),
    'worker/tesseract-core-lstm.wasm': path.join(ROOT, 'worker', 'tesseract-core-lstm.wasm'),
    'worker/tesseract-core.wasm': path.join(ROOT, 'worker', 'tesseract-core.wasm'),
    '.env': path.join(ROOT, '.env'),
  };
  for (const [name, dest] of Object.entries(assets)) {
    try {
      ensureDir(path.dirname(dest));
      const data = sea.getAsset(name);
      fs.writeFileSync(dest, Buffer.from(data));
    } catch (e) {
      console.error('[setup] failed to extract ' + name + ': ' + (e && e.message));
    }
  }
}

function applyEnv() {
  process.env.JOB_AGENT_ROOT = ROOT;
  process.env.JOB_AGENT_DATA_DIR = ROOT;
  process.env.JOB_AGENT_WEB_DIR = path.join(ROOT, 'web');
  process.env.JOB_AGENT_RESUME_DIR = path.join(ROOT, 'resumes');
  process.env.JOB_AGENT_PROFILE_PATH = path.join(ROOT, 'data', 'profile.json');
  const primaryProfile = pickPrimaryProfile();
  process.env.JOB_AGENT_PROFILE_DIR = primaryProfile;
  process.env.JOB_AGENT_FALLBACK_PROFILE_DIR = primaryProfile + '-2';
  process.env.JOB_AGENT_TESSDATA = path.join(ROOT, 'tessdata');
  process.env.JOB_AGENT_TESS_WORKER = path.join(ROOT, 'worker', 'worker.cjs');
  process.env.JOB_AGENT_SERVER_BUNDLE = path.join(ROOT, 'server', 'server.cjs');
  process.env.DOTENV_CONFIG_PATH = path.join(ROOT, '.env');
}

if (isSea()) {
  ensureDir(ROOT);
  extractAssets();
  migrateLegacyProfile();
  applyEnv();
} else {
  const devRoot = path.resolve(__dirname, '..');
  const devData = path.join(devRoot, 'portable');
  process.env.JOB_AGENT_ROOT = process.env.JOB_AGENT_ROOT || devRoot;
  process.env.JOB_AGENT_DATA_DIR = process.env.JOB_AGENT_DATA_DIR || devData;
  process.env.JOB_AGENT_WEB_DIR = process.env.JOB_AGENT_WEB_DIR || path.join(devRoot, 'web');
  process.env.JOB_AGENT_RESUME_DIR = process.env.JOB_AGENT_RESUME_DIR || path.join(devData, 'resumes');
  process.env.JOB_AGENT_PROFILE_PATH = process.env.JOB_AGENT_PROFILE_PATH || path.join(devData, 'data', 'profile.json');
  process.env.JOB_AGENT_PROFILE_DIR = process.env.JOB_AGENT_PROFILE_DIR || path.join(devData, '.edge-profile');
  process.env.JOB_AGENT_FALLBACK_PROFILE_DIR = process.env.JOB_AGENT_FALLBACK_PROFILE_DIR || path.join(devData, '.edge-profile-2');
  process.env.JOB_AGENT_TESSDATA = process.env.JOB_AGENT_TESSDATA || path.join(devData, 'tessdata');
  process.env.JOB_AGENT_TESS_WORKER = process.env.JOB_AGENT_TESS_WORKER || '';
}

module.exports = ROOT;
