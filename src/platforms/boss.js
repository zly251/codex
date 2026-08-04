import fs from "node:fs";
import path from "node:path";
import { BossApiScraper } from "../scrapers/bossApi.js";
import { AutoApplyBot } from "../chatApply.js";

function isJobDomain(domain) {
  return typeof domain === "string" && (domain === "zhipin.com" || domain.endsWith(".zhipin.com"));
}

async function findJobPage(manager) {
  if (!manager?.browser?.connected) return null;
  const pages = await manager.browser.pages();
  let first = null;
  for (const p of pages) {
    try {
      if (!p.url().includes("zhipin.com")) continue;
      if (!first) first = p;
      const text = await p.evaluate(function () {
        return document.body ? document.body.innerText : "";
      });
      if (text.indexOf("登录/注册") < 0) return p;
    } catch (e) {}
  }
  return first;
}

async function isLoggedIn(page) {
  try {
    return await page.evaluate(function () {
      const text = document.body ? document.body.innerText : "";
      return text.indexOf("登录/注册") < 0;
    });
  } catch (e) {
    return false;
  }
}

function cookieBackupPath(root) {
  return path.join(root, "data", "boss-cookies.json");
}

async function saveCookies(manager, root) {
  const page = await findJobPage(manager);
  if (!page) return { saved: false, reason: "no_page" };
  const loggedIn = await isLoggedIn(page);
  if (!loggedIn) return { saved: false, reason: "not_logged_in" };
  const client = await page.createCDPSession();
  const data = await client.send("Network.getAllCookies");
  const cookies = (data.cookies || []).filter(function (c) {
    return isJobDomain(c.domain);
  });
  if (cookies.length === 0) return { saved: false, reason: "empty" };
  const json = JSON.stringify(cookies);
  const file = cookieBackupPath(root);
  let prev = "";
  try { prev = fs.readFileSync(file, "utf8"); } catch (e) {}
  if (prev === json) return { saved: false, reason: "unchanged", count: cookies.length };
  fs.writeFileSync(file, json, "utf8");
  return { saved: true, count: cookies.length };
}

async function restoreCookies(manager, root) {
  const file = cookieBackupPath(root);
  if (!fs.existsSync(file)) return { restored: false, reason: "no_backup", count: 0 };
  const cookies = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(cookies) || cookies.length === 0) return { restored: false, reason: "empty_backup", count: 0 };
  const page = await findJobPage(manager);
  if (!page) return { restored: false, reason: "no_page", count: 0 };
  if (await isLoggedIn(page)) return { restored: false, reason: "already_logged_in", count: 0 };
  const client = await page.createCDPSession();
  const payload = cookies.map(function (c) {
    return {
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || "/",
      expires: typeof c.expires === "number" ? c.expires : -1,
      httpOnly: !!c.httpOnly,
      secure: !!c.secure,
      sameSite: c.sameSite || "Lax",
      priority: c.priority || "Medium",
    };
  });
  await client.send("Network.setCookies", { cookies: payload });
  try {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
  } catch (e) {}
  return { restored: true, count: payload.length };
}

export const bossPlatform = {
  id: "boss",
  name: "BOSS直聘",
  baseUrl: "https://www.zhipin.com",
  jobsUrl: "https://www.zhipin.com/web/geek/jobs",
  loginUrl: "https://www.zhipin.com/web/user/?ka=header-login",
  blockedCompanies: ["甲骨科技", "比伦纺织科技", "教育", "培训学校"],
  isJobDomain,
  findJobPage,
  isLoggedIn,
  cookieBackupPath,
  saveCookies,
  restoreCookies,
  createScraper(manager) {
    return new BossApiScraper(manager);
  },
  createBot(manager) {
    return new AutoApplyBot(manager);
  },
};
