import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import puppeteer from "puppeteer-core";

const FIREFOX_CANDIDATES = [
  "D:\\Firefox\\firefox.exe",
  "E:\\Firefox\\firefox.exe",
  "C:\\Program Files\\Mozilla Firefox\\firefox.exe",
  "C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe",
  path.join(process.env.LOCALAPPDATA || "", "Mozilla Firefox\\firefox.exe"),
  path.join(process.env.ProgramFiles || "", "Mozilla Firefox\\firefox.exe"),
  path.join(process.env["ProgramFiles(x86)"] || "", "Mozilla Firefox\\firefox.exe"),
];

export const DEFAULT_FIREFOX_PROFILE =
  process.env.JOB_AGENT_PROFILE_DIR ||
  process.env.JOB_AGENT_FIREFOX_PROFILE_DIR ||
  path.join(process.cwd(), ".firefox-profile");

export const FALLBACK_FIREFOX_PROFILE =
  process.env.JOB_AGENT_FALLBACK_PROFILE_DIR ||
  process.env.JOB_AGENT_FIREFOX_FALLBACK_PROFILE_DIR ||
  path.join(process.cwd(), ".firefox-profile-2");

export function findFirefoxPath() {
  const envPath = process.env.FIREFOX_PATH || process.env.JOB_AGENT_FIREFOX_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;
  for (const p of FIREFOX_CANDIDATES) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch (e) {}
  }
  if (process.platform === "win32") {
    try {
      const out = execFileSync("where", ["firefox"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
      const p = (out || "").trim().split(/\r?\n/)[0];
      if (p && fs.existsSync(p)) return p;
    } catch (e) {}
  } else {
    try {
      const out = execFileSync("which", ["firefox"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
      const p = (out || "").trim().split(/\r?\n/)[0];
      if (p && fs.existsSync(p)) return p;
    } catch (e) {}
  }
  return null;
}

export async function launchFirefox({
  profileDir,
  url = "https://www.zhipin.com",
  headless = false,
  timeout = 60000,
} = {}) {
  const exe = findFirefoxPath();
  if (!exe) throw new Error("Firefox not found. Please install Firefox first.");
  const dir = profileDir || DEFAULT_FIREFOX_PROFILE;
  fs.mkdirSync(dir, { recursive: true });
  const browser = await puppeteer.launch({
    browser: "firefox",
    executablePath: exe,
    headless,
    userDataDir: dir,
    timeout,
    args: ["--start-maximized"],
  });
  const pages = await browser.pages();
  const page = pages.find((p) => {
    try {
      return p.url() && !p.url().startsWith("about:");
    } catch (e) {
      return false;
    }
  }) || pages[0] || await browser.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch (e) {}
  try {
    await page.bringToFront();
  } catch (e) {}
  return browser;
}

export async function openUrlInFirefox(browser, url) {
  if (!browser?.connected) throw new Error("Firefox browser is not connected.");
  let page = null;
  try {
    const pages = await browser.pages();
    page = pages.find((p) => {
      try {
        return p.url().startsWith(url);
      } catch (e) {
        return false;
      }
    }) || pages[0];
  } catch (e) {}
  if (!page) page = await browser.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
  try {
    await page.bringToFront();
  } catch (e) {}
  return page;
}
