import * as applicationDb from "./db/application.js";
import * as companyDb from "./db/company.js";
import * as jobDb from "./db/job.js";
import * as liveLog from "./log.js";
import path from "node:path";
import { DATA_ROOT } from "./paths.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randBetween = (min, max) => min + Math.random() * Math.max(0, max - min);
const randSleep = (minMs, maxMs) => sleep(randBetween(minMs, maxMs));
const log = (msg) => liveLog.add(msg);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const START_CHAT_SELECTORS = [
  ".btn-startchat",
  "a[ka='job-startchat']",
  ".op-btn",
  "[class*='startchat']",
  "[class*='start-chat']",
  "a.btn",
  "button.btn",
];

const SEND_SELECTORS = [
  ".btn-send",
  ".btn-confirm",
  ".dialog-footer .btn-primary",
  "[class*='send']",
  "[class*='submit']",
  ".primary-btn",
  ".confirm-btn",
];

const SEND_TEXTS = ["发送", "提交", "确定"];
const START_TEXTS = ["立即沟通", "立即开聊", "沟通"];

const BLOCKED_HINTS = ["验证码", "安全验证", "访问异常", "访问过于频繁", "系统繁忙", "请登录", "扫码登录"];
const SENT_MARKERS = ["送达", "已发送", "消息已发送", "发送成功", "已沟通", "继续沟通", "查看聊天", "打招呼成功", "已读"];

function normalizeCompany(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/股份有限公司|有限责任公司|有限公司/g, "")
    .replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
}

function feedbackStatusFromMessage(msg) {
  const text = String(msg || "").toLowerCase();
  if (/offer|录用|入职|恭喜/.test(text)) return "offer";
  if (/面试|面谈|面聊|复试|初试/.test(text)) return "interview";
  if (/不合适|不匹配|招满|暂不|不考虑|不需要|不录用|停止|抱歉|遗憾|已关闭|不符合/.test(text)) return "rejected";
  if (text.trim()) return "replied";
  return null;
}

export class AutoApplyBot {
  constructor(bm, style) {
    this.manager = bm;
    this.page = null;
    this.running = false;
    this.style = style || { greeting: "您好", tone: "礼貌" };
  }

  async _getPage() {
    if (this.page && !this.page.isClosed()) {
      try {
        await this.page.evaluate("1+1");
        return this.page;
      } catch (e) {
        log("[page] 页面已失效，重新获取: " + (e.message || "").slice(0, 40));
      }
    }

    const b = this.manager.browser;
    if (!b?.connected) throw new Error("浏览器未连接");

    const pages = await b.pages();
    const zhipinPages = [];
    for (const p of pages) {
      try {
        const u = p.url();
        if (u.includes("zhipin") && !u.includes("about:")) zhipinPages.push(p);
      } catch (e) {}
    }

    if (zhipinPages.length === 0) {
      const page = await b.newPage();
      this.page = page;
      log("[page] 创建 BOSS 直聘标签页");
      return page;
    }

    let chosen = zhipinPages[0];
    for (const p of zhipinPages) {
      try {
        const t = await p.evaluate(function () { return document.body ? document.body.innerText : ""; });
        if (t.indexOf("登录/注册") < 0) { chosen = p; break; }
      } catch (e) {}
    }

    while (zhipinPages.length > 1) {
      const idx = zhipinPages.findIndex(function (p) { return p !== chosen; });
      if (idx < 0) break;
      const extra = zhipinPages.splice(idx, 1)[0];
      try { await extra.close(); log("[page] 关闭多余标签页"); } catch (e) {}
    }

    this.page = chosen;
    log("[page] 复用已打开的 BOSS 直聘标签页");
    return this.page;

    throw new Error("BOSS 标签页已关闭，请重启应用或手动打开 BOSS 直聘");
  }

  async _closeCurrentPage() {
    const p = this.page;
    this.page = null;
    if (!p || p.isClosed()) return;
    let zhipinCount = 0;
    try {
      const pages = await this.manager.browser.pages();
      for (const x of pages) {
        if (x.isClosed()) continue;
        const u = x.url();
        if (u.includes("zhipin") && !u.includes("about:")) zhipinCount++;
      }
    } catch (e) {}
    if (zhipinCount <= 1) {
      try {
        log("[page] 保留最后一个 BOSS 页面");
        await p.goto("https://www.zhipin.com/web/geek/jobs", { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
      } catch (e) {}
      return;
    }
    try { await p.close(); log("[page] 已关闭异常页面"); } catch (e) {}
  }

  async _humanWait(minSec, maxSec) {
    let ms = randBetween(minSec, maxSec) * 1000;
    if (Math.random() < 0.12) ms *= randBetween(1.4, 2.2);
    log(`随机等待 ${(ms / 1000).toFixed(1)} 秒，模拟真人节奏`);
    await sleep(ms);
  }

  async _humanMove(page, x, y) {
    const startX = clamp(x - randBetween(160, 380), 20, 1400);
    const startY = clamp(y + randBetween(-160, 160), 20, 800);
    await page.mouse.move(startX, startY, { steps: Math.floor(randBetween(5, 12)) });
    await randSleep(180, 520);
    const midX = x + randBetween(-90, 90);
    const midY = y + randBetween(-60, 60);
    await page.mouse.move(midX, midY, { steps: Math.floor(randBetween(14, 30)) });
    await randSleep(120, 380);
    await page.mouse.move(x, y, { steps: Math.floor(randBetween(8, 16)) });
    await randSleep(160, 420);
  }

  async _humanClick(page, x, y) {
    await this._humanMove(page, x, y);
    await randSleep(120, 360);
    await page.mouse.down();
    await randSleep(70, 160);
    await page.mouse.up();
    await randSleep(120, 300);
  }

  async _locatePoint(page, selectors, skipTexts = []) {
    const matched = await page.evaluate((sels, skip) => {
      const seen = new Set();
      for (const s of sels) {
        for (const el of document.querySelectorAll(s)) {
          if (seen.has(el)) continue;
          seen.add(el);
          if (!el.offsetParent || el.getClientRects().length === 0) continue;
          const txt = (el.textContent || "").trim();
          if (skip.some((t) => txt.includes(t))) return { skip: true };
          el.scrollIntoView({ block: "center", behavior: "smooth" });
          return true;
        }
      }
      return false;
    }, selectors, skipTexts).catch(() => false);

    if (matched && matched.skip) return "skip";
    if (!matched) return null;

    await randSleep(900, 1600);

    const point = await page.evaluate((sels) => {
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el && el.offsetParent && el.getClientRects().length > 0) {
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        }
      }
      return null;
    }, selectors).catch(() => null);
    return point;
  }

  async _clickFirst(page, selectors, opts = {}) {
    const pt = await this._locatePoint(page, selectors, opts.skipTexts || []);
    if (pt === "skip") return "skip";
    if (!pt) return false;
    try { if (opts.onLocate) opts.onLocate(pt); } catch (e) {}
    await this._humanClick(page, pt.x, pt.y);
    return true;
  }

  async _clickTextControl(page, texts, opts = {}) {
    const tags = opts.tags || ["button", "a", "[role=button]", "[class*='send']", "[class*='submit']", "[class*='btn']"];
    const mode = opts.match || "exact";
    const found = await page.evaluate((texts, tags, mode) => {
      const list = [];
      for (const sel of tags) {
        for (const el of document.querySelectorAll(sel)) {
          if (!el.offsetParent || el.getClientRects().length === 0) continue;
          if (el.disabled) continue;
          const txt = (el.textContent || "").trim();
          if (!txt) continue;
          if (mode === "includes") {
            if (!texts.some((t) => txt.includes(t))) continue;
          } else if (!texts.includes(txt)) {
            continue;
          }
          list.push(el);
        }
      }
      if (list.length === 0) return false;
      list.sort((a, b) => (a.textContent || "").trim().length - (b.textContent || "").trim().length);
      const target = list[0];
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      return true;
    }, texts, tags, mode).catch(() => false);
    if (!found) return false;
    await randSleep(800, 1500);
    const pt = await page.evaluate((texts, tags, mode) => {
      const list = [];
      for (const sel of tags) {
        for (const el of document.querySelectorAll(sel)) {
          if (!el.offsetParent || el.getClientRects().length === 0) continue;
          if (el.disabled) continue;
          const txt = (el.textContent || "").trim();
          if (!txt) continue;
          if (mode === "includes") {
            if (!texts.some((t) => txt.includes(t))) continue;
          } else if (!texts.includes(txt)) {
            continue;
          }
          list.push(el);
        }
      }
      if (list.length === 0) return null;
      list.sort((a, b) => (a.textContent || "").trim().length - (b.textContent || "").trim().length);
      const r = list[0].getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    }, texts, tags, mode).catch(() => null);
    if (!pt) return false;
    await this._humanClick(page, pt.x, pt.y);
    return true;
  }

  async _clickSendButton(page) {
    const selectorHit = await this._clickFirst(page, SEND_SELECTORS);
    if (selectorHit) return true;
    return await this._clickTextControl(page, SEND_TEXTS, { match: "includes" });
  }

  async _clickButtonByText(page, text) {
    const found = await page.evaluate((txt) => {
      for (const b of document.querySelectorAll("button")) {
        if ((b.textContent || "").trim() === txt && !b.disabled && b.offsetParent !== null && b.getClientRects().length > 0) {
          b.scrollIntoView({ block: "center", behavior: "smooth" });
          return true;
        }
      }
      return false;
    }, text).catch(() => false);
    if (!found) return false;
    await randSleep(800, 1500);
    const pt = await page.evaluate((txt) => {
      for (const b of document.querySelectorAll("button")) {
        if ((b.textContent || "").trim() === txt && !b.disabled && b.offsetParent !== null && b.getClientRects().length > 0) {
          const r = b.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        }
      }
      return null;
    }, text).catch(() => null);
    if (!pt) return false;
    await this._humanClick(page, pt.x, pt.y);
    return true;
  }

  async _humanType(page, text) {
    const selectors = [
      ".chat-container textarea",
      "[class*='chat'] textarea",
      "textarea",
      ".chat-container [contenteditable]",
      "[class*='chat'] [contenteditable]",
      "[contenteditable]",
      "[class*='chat'] [class*='input']",
      "[class*='input']",
    ];
    const focused = await page.evaluate((selectors) => {
      let el = null;
      for (const s of selectors) {
        const found = document.querySelector(s);
        if (found && found.offsetParent !== null) { el = found; break; }
      }
      if (!el) return false;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.focus();
      el.click();
      if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
        el.value = "";
      } else if (el.isContentEditable) {
        el.innerText = "";
      }
      return true;
    }, selectors).catch(() => false);
    if (!focused) return false;
    await randSleep(500, 900);
    for (const ch of String(text || "")) {
      await page.keyboard.type(ch, { delay: 0 }).catch(() => {});
      await randSleep(60, 240);
      if (Math.random() < 0.05) await randSleep(400, 1100);
    }
    await randSleep(400, 800);
    const typed = await page.evaluate(() => {
      const el = document.querySelector("textarea, [contenteditable], [class*='input']");
      if (!el) return false;
      const val = el.value || (el.isContentEditable ? el.innerText : "") || "";
      return val.trim().length > 0;
    }).catch(() => false);
    if (typed) return true;
    return await page.evaluate((text, selectors) => {
      let el = null;
      for (const s of selectors) {
        const found = document.querySelector(s);
        if (found && found.offsetParent !== null) { el = found; break; }
      }
      if (!el) return false;
      el.focus();
      if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
        el.value = text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      } else if (el.isContentEditable) {
        el.innerText = text;
        el.dispatchEvent(new InputEvent("input", { bubbles: true }));
      }
      return true;
    }, String(text || ""), selectors).catch(() => false);
  }

  async _checkPageState(page) {
    try {
      return await page.evaluate((markers) => {
        const body = document.body?.innerText || "";
        let btn = "";
        const sels = [".btn-startchat", "a[ka='job-startchat']", ".op-btn", "[class*='startchat']", "[class*='start-chat']"];
        for (const s of sels) {
          const el = document.querySelector(s);
          if (el && el.offsetParent) { btn = (el.textContent || "").trim(); break; }
        }
        const dialog = document.querySelector(".dialog-footer, .chat-dialog, [class*='dialog']");
        const chatArea = document.querySelector(".chat-container, [class*='chat']");
        const chatText = chatArea ? chatArea.innerText : body;
        const input = document.querySelector("textarea, [contenteditable], [class*='chat'] [class*='input'], [class*='input']");
        const inputValue = input ? (input.value || (input.isContentEditable ? input.innerText : "") || "").trim() : "";
        const sendVisible = Array.from(document.querySelectorAll("button, a, [role=button], [class*='send'], [class*='submit'], [class*='btn']")).some((el) => {
          if (!el.offsetParent || el.getClientRects().length === 0 || el.disabled) return false;
          const txt = (el.textContent || "").trim();
          return ["发送", "提交", "确定"].some((t) => txt.includes(t));
        });
        return {
          textLen: body.length,
          btn,
          dialogVisible: !!(dialog && dialog.offsetParent !== null),
          inputExists: !!input,
          inputValue,
          hasSendVisible: sendVisible,
          chatTextLen: chatText.length,
          hasDelivered: markers.some(function (s) { return chatText.includes(s); }),
          hasGreeted: ["继续沟通", "查看聊天", "已沟通"].some((t) => btn.includes(t)),
        };
      }, SENT_MARKERS);
    } catch (e) { return null; }
  }

  async _navigateToChat() {
    const page = await this._getPage();
    let url = page.url();
    if (url.includes("/web/geek/chat") || url.includes("/chat")) {
      return page;
    }
    try {
      await page.goto("https://www.zhipin.com/web/geek/chat?ka=header-message", { waitUntil: "domcontentloaded", timeout: 15000 });
      if (!page.url().includes("/chat")) log("[nav] 直达聊天页未跳转: " + page.url().slice(0, 80));
    } catch (e) {
      log("[nav] 直达聊天页失败: " + (e.message || "").slice(0, 80));
    }
    await this._humanWait(2, 4);
    if (page.url().includes("/chat")) return page;
    if (!url.includes("zhipin.com")) {
      log("[nav] 打开 BOSS 直聘职位页...");
      await page.goto("https://www.zhipin.com/web/geek/jobs", { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
      await this._humanWait(2, 4);
    }

    const foundLink = await page.evaluate(() => {
      for (const a of document.querySelectorAll("a")) {
        if ((a.textContent || "").includes("消息") && a.offsetParent !== null && a.getClientRects().length > 0) {
          a.scrollIntoView({ block: "center", behavior: "smooth" });
          return true;
        }
      }
      const badge = document.querySelector(".nav-chat-num, [class*='nav-chat']");
      if (badge) {
        const t = badge.closest("a") || badge.parentElement;
        if (t) { t.scrollIntoView({ block: "center", behavior: "smooth" }); return true; }
      }
      return false;
    }).catch(() => false);

    let clickedViaHuman = false;
    if (foundLink) {
      await randSleep(800, 1500);
      const pt = await page.evaluate(() => {
        for (const a of document.querySelectorAll("a")) {
          if ((a.textContent || "").includes("消息") && a.offsetParent !== null && a.getClientRects().length > 0) {
            const r = a.getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          }
        }
        const badge = document.querySelector(".nav-chat-num, [class*='nav-chat']");
        if (badge) {
          const t = badge.closest("a") || badge.parentElement;
          if (t) {
            const r = t.getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          }
        }
        return null;
      }).catch(() => null);

      if (pt) {
        log("[nav] 点击消息入口...");
        await this._humanClick(page, pt.x, pt.y);
        await this._humanWait(3, 5);
        clickedViaHuman = true;
      }
    }

    if (!clickedViaHuman) {
      const didClick = await page.evaluate(() => {
        for (const a of document.querySelectorAll("a")) {
          if ((a.textContent || "").includes("消息") && a.offsetParent !== null) { a.click(); return true; }
        }
        for (const el of document.querySelectorAll("*")) {
          if ((el.textContent || "").trim() === "消息" && el.offsetParent !== null) {
            const target = el.closest("a") || el.closest("[onclick]") || el;
            target.click(); return true;
          }
        }
        const badge = document.querySelector(".nav-chat-num, [class*='nav-chat']");
        if (badge) {
          const t = badge.closest("a") || badge.parentElement;
          if (t) { t.click(); return true; }
        }
        return false;
      }).catch(() => false);
      if (didClick) {
        log("[nav] DOM 兜底点击消息");
        await this._humanWait(3, 5);
      } else {
        log("[nav] 未找到消息入口");
      }
    }

    log("[nav] 当前地址: " + page.url().slice(0, 80));
    return page;
  }

  async _scanChatSessions(navigate = true) {
    const page = await this._getPage();
    if (!navigate && !page.url().includes("/chat")) {
      log("[chat] 当前不在聊天页，本次跳过");
      return [];
    }
    if (navigate) {
      await this._navigateToChat();
      await this._humanWait(1.5, 2.5);
    }
    return await page.evaluate(() => {
      const rows = [];
      document.querySelectorAll('li[role="listitem"]').forEach((li) => {
        if (!li.offsetParent && li.getClientRects().length === 0) return;
        const name = (li.querySelector(".name-text")?.textContent || "").trim();
        const nameBox = li.querySelector(".name-box");
        const company = (nameBox?.children?.[1]?.textContent || "").trim();
        const msg = (li.querySelector(".last-msg-text")?.textContent || "").trim();
        const status = (li.querySelector(".message-status, [class*='status-']")?.textContent || "").trim();
        const hrLast = !/\[(送达|已读)\]/.test(status || "") && !/^\[(送达|已读)\]/.test(msg || "");
        const badge = li.querySelector("[class*='badge'], [class*='num']")?.textContent?.trim() || "";
        const unread = /^\d+$/.test(badge) && Number(badge) > 0;
        if (name || company || msg) rows.push({ name, company, msg, status, hrLast, unread });
      });
      return rows;
    }).catch(() => []);
  }

  _findApplicationByCompany(apps, companyName) {
    const needle = normalizeCompany(companyName);
    if (!needle) return null;
    let fallback = null;
    for (const app of apps || []) {
      const j = app.jobId ? jobDb.findById(app.jobId) : null;
      const c = j?.companyId ? companyDb.findById(j.companyId) : null;
      const candidate = normalizeCompany(c?.name || j?.companyName || "");
      if (!candidate) continue;
      if (candidate === needle || candidate.includes(needle) || needle.includes(candidate)) return app;
      if (!fallback && candidate.includes(needle.slice(0, Math.max(4, needle.length)))) fallback = app;
    }
    return fallback;
  }

  async syncFeedback(sessions) {
    const scanned = sessions || await this._scanChatSessions();
    const apps = applicationDb.findAll();
    const updated = [];
    const rank = { pending: 0, viewed: 1, replied: 2, interview: 3, offer: 4, rejected: 5 };
    for (const s of scanned || []) {
      const ownMessage = /\[(送达|已读)\]/.test(s.status || "") || /^\[(送达|已读)\]/.test(s.msg || "");
      if (ownMessage || !String(s.msg || "").trim()) continue;
      const status = feedbackStatusFromMessage(s.msg);
      if (!status) continue;
      const app = this._findApplicationByCompany(apps, s.company || s.name || "");
      if (!app || app.status === status) continue;
      if ((rank[app.status] || 0) > (rank[status] || 0)) continue;
      const note = `BOSS 同步: ${s.name || ""} ${s.company || ""} - ${String(s.msg || "").slice(0, 80)}`;
      applicationDb.updateStatus(app.id, status, note);
      updated.push({ id: app.id, company: s.company || s.name || "", status, message: String(s.msg || "").slice(0, 120) });
      log(`[feedback] ${app.id} -> ${status} (${s.company || s.name || ""})`);
    }
    log(`[feedback] 扫描 ${scanned.length} 个会话，更新 ${updated.length} 条投递反馈`);
    return { scanned: scanned.length, updatedCount: updated.length, updated };
  }

  _progress(options, current, total, title, step) {
    try { options.onProgress?.({ current, total, title, step }); } catch (e) {}
  }

  _isVerified(before, after) {
    if (!after) return false;
    if (after.hasDelivered || after.hasGreeted) return true;
    if (before) {
      if (before.inputValue && !after.inputValue && after.chatTextLen > before.chatTextLen) return true;
      if (before.dialogVisible && !after.dialogVisible && before.hasSendVisible) return true;
    }
    return false;
  }

  async autoApply(jobs, options = {}) {
    const page = await this._getPage();
    let applied = 0;
    let failed = 0;
    let skipped = 0;
    const results = [];
    const total = (jobs || []).length;
    const delayMin = Number(options.delayMin ?? 8) || 8;
    const delayMax = Number(options.delayMax ?? 25) || 25;

    for (let i = 0; i < total; i++) {
      const job = jobs[i];
      if (!this.running) { log("已收到停止指令，结束投递"); break; }
      try {
        const title = job.title || job.name || "?";
        const existing = job.id ? applicationDb.findByJobId(job.id) : null;
        if (existing) {
          skipped++;
          results.push({ job: title, status: "already", reason: "已投递" });
          log(`[${i + 1}/${total}] 已投递过，跳过: ${title}`);
          continue;
        }
        this._progress(options, i + 1, total, title, "打开职位页");
        log(`[${i + 1}/${total}] 打开职位: ${title} ${job.city || ""} ${job.district || ""}`);
        await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
        await this._humanWait(2.5, 5);
        try { await page.waitForSelector("body", { timeout: 8000 }); } catch (e) {}

        let state0 = await this._checkPageState(page);
        let bodyText = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
        let blockedHint = BLOCKED_HINTS.find((h) => bodyText.includes(h));
        if (!state0 || state0.textLen < 30) {
          log(`[${i + 1}/${total}] 页面内容不足，等待重新加载: ${title}`);
          await this._humanWait(3, 5);
          try { await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 }); } catch (e) {}
          await this._humanWait(2, 4);
          state0 = await this._checkPageState(page);
          bodyText = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
          blockedHint = BLOCKED_HINTS.find((h) => bodyText.includes(h));
        }
        if (!state0 || state0.textLen < 30 || blockedHint) {
          failed++;
          results.push({ job: title, status: "blocked", reason: blockedHint || "页面无内容" });
          if (blockedHint && (blockedHint.indexOf("请登录") >= 0 || blockedHint.indexOf("扫码登录") >= 0)) {
            log(`[${i + 1}/${total}] BOSS 未登录，停止投递，请先扫码登录: ${title}`);
            this.running = false;
            return { applied, failed, total: applied + failed, results };
          }
          log(`[${i + 1}/${total}] 页面无法查看（${blockedHint || "内容为空"}），保留页面继续: ${title}`);
          try { await page.screenshot({ path: path.join(DATA_ROOT, "data", "last_blocked.png"), fullPage: false }).catch(() => {}); } catch (e) {}
          await this._closeCurrentPage();
          if (this.running && i < total - 1) await this._humanWait(delayMin, delayMax);
          continue;
        }

        this._progress(options, i + 1, total, title, "定位沟通按钮");
        let clicked = await this._clickFirst(page, START_CHAT_SELECTORS, {
          skipTexts: ["继续沟通", "查看聊天"],
          onLocate: () => this._progress(options, i + 1, total, title, "移动鼠标点击沟通"),
        });
        if (clicked !== "skip" && clicked !== true) {
          const fallback = await this._clickTextControl(page, START_TEXTS, { match: "includes" });
          if (fallback) clicked = true;
        }

        if (clicked === "skip") {
          results.push({ job: title, status: "skip", reason: "already chatted" });
          log(`[${i + 1}/${total}] 复核：该职位已沟通过，跳过: ${title}`);
          if (this.running && i < total - 1) await this._humanWait(delayMin, delayMax);
          continue;
        }

        if (clicked) {
          this._progress(options, i + 1, total, title, "等待聊天弹窗");
          await this._humanWait(2, 4);
          let state1 = await this._checkPageState(page);
          if (!state1 || !(state1.inputExists || state1.hasSendVisible)) {
            const retry = await this._clickTextControl(page, START_TEXTS, { match: "includes" });
            if (retry) {
              await this._humanWait(2, 4);
              state1 = await this._checkPageState(page);
            }
          }

          if (state1 && (state1.hasDelivered || state1.hasGreeted)) {
            applied++;
            try { applicationDb.create({ jobId: job.id, resumeId: job.resumeId || null, status: "pending", notes: "打招呼-复核通过" }); } catch (e) {}
            results.push({ job: title, status: "ok", verified: true });
            log(`[${i + 1}/${total}] 已存在沟通状态，确认打过招呼: ${title}`);
          } else {
            const greeting = options.greeting || this.style.greeting || "您好，我对该职位很感兴趣，方便沟通一下吗？";
            if (greeting && state1?.inputExists) {
              this._progress(options, i + 1, total, title, "输入打招呼语");
              const typed = await this._humanType(page, greeting);
              if (!typed) log(`[${i + 1}/${total}] 未找到聊天输入框，继续尝试发送`);
              await randSleep(600, 1200);
            }
            this._progress(options, i + 1, total, title, "点击发送按钮");
            const sent = await this._clickSendButton(page);
            if (!sent) {
              log(`[${i + 1}/${total}] 未找到发送按钮，尝试回车发送`);
              await page.keyboard.press("Enter").catch(() => {});
              await randSleep(800, 1500);
            }
            await this._humanWait(2, 3.5);

            const v1 = await this._checkPageState(page);
            await this._humanWait(2, 4);
            const v2 = await this._checkPageState(page);
            const verified = this._isVerified(state1, v1) || this._isVerified(state1, v2);
            log(`[${i + 1}/${total}] 复核确认: ${verified ? "已打过招呼" : "未确认到打招呼"} (送达=${v2?.hasDelivered ? "是" : "否"}, 按钮状态=${v2?.btn || "无"}, 输入框=${v2?.inputValue ? "有内容" : "已清空"})`);

            if (verified) {
              applied++;
              try { applicationDb.create({ jobId: job.id, resumeId: job.resumeId || null, status: "pending", notes: "打招呼-复核通过" }); } catch (e) {}
              results.push({ job: title, status: "ok", verified: true });
              log(`[${i + 1}/${total}] 复核通过，确认已打招呼: ${title}`);
            } else {
              failed++;
              results.push({ job: title, status: "unverified", reason: "复核未确认" });
              log(`[${i + 1}/${total}] 复核未确认，记入失败: ${title}`);
              try { await page.screenshot({ path: path.join(DATA_ROOT, "data", "last_unverified.png"), fullPage: false }).catch(() => {}); } catch (e) {}
            }
          }
        } else {
          failed++;
          results.push({ job: title, status: "no_button" });
          log(`[${i + 1}/${total}] 未找到沟通按钮: ${title}`);
          try { await page.screenshot({ path: path.join(DATA_ROOT, "data", "last_fail.png"), fullPage: false }).catch(() => {}); } catch (e) {}
        }
      } catch (e) {
        failed++;
        results.push({ job: (job.title || job.name || "?"), status: "error", error: (e.message || "").slice(0, 40) });
        log(`[${i + 1}/${total}] 处理异常: ${(e.message || "").slice(0, 80)}`);
      }

      if (this.running && i < total - 1) {
        this._progress(options, i + 1, total, (jobs[i]?.title || ""), `等待随机 ${delayMin}-${delayMax} 秒`);
        await this._humanWait(delayMin, delayMax);
      }
    }

    this._progress(options, total, total, "", "完成");
    log(`投递结束: 成功 ${applied}，失败 ${failed}，跳过 ${skipped}，共处理 ${applied + failed + skipped}`);
    return { applied, failed, skipped, total: applied + failed, results };
  }

  async monitorChat(onMsg, interval) {
    let firstScan = true;
    const check = async () => {
      try {
        const data = await this._scanChatSessions(firstScan);
        firstScan = false;

        log(`[chat] 扫描到 ${data.length} 个会话`);
        for (const c of data) {
          if (c.hrLast && c.unread) {
            log(`[chat] 收到 ${c.name} 的消息: ${(c.msg || "").slice(0, 30)}`);
            try { if (onMsg) await onMsg(c); } catch (e) {}
          }
        }
        await this.syncFeedback(data);
      } catch (e) {
        log(`[chat] 扫描异常: ${(e?.message || "").slice(0, 60)}`);
      }
    };

    await this._getPage();
    await check();
    this._timer = setInterval(check, interval || 30000);
  }

  async sendReply(hrName, msg) {
    try {
      await this._navigateToChat();

      if (hrName) {
        await this.page.evaluate((name) => {
          const items = document.querySelectorAll("[class*='session'], [class*='chat-item'], [class*='conversation'], li");
          for (const el of items) {
            if ((el.textContent || "").includes(name) && el.offsetParent !== null) {
              el.click(); return;
            }
          }
        }, hrName).catch(() => {});
        await randSleep(800, 1600);
      }

      let typed = await this._humanType(this.page, msg);
      if (!typed) {
        log("[chat] 未找到输入框，改用 DOM 注入");
        await this.page.evaluate((text) => {
          const el = document.querySelector("textarea, [contenteditable], [class*='input']");
          if (!el) return false;
          el.focus();
          if (el.isContentEditable) {
            el.innerHTML = text;
            el.dispatchEvent(new InputEvent("input", { bubbles: true }));
          } else {
            el.value = text;
            el.dispatchEvent(new Event("input", { bubbles: true }));
          }
        }, msg).catch(() => {});
        await randSleep(500, 800);
      }

      const sent = await this._clickButtonByText(this.page, "发送");
      if (!sent) {
        log("[chat] 未找到发送按钮，按回车发送");
        await this.page.keyboard.press("Enter").catch(() => {});
        await randSleep(400, 700);
      }
      log(`已回复 ${hrName || "HR"}: ${String(msg || "").slice(0, 20)}...`);
    } catch (e) {
      log(`[chat] 回复失败: ${(e?.message || "").slice(0, 60)}`);
    }
  }

  async _deepseekReply(hrMsg, name, skills) {
    const apiKey = process.env.DEEPSEEK_API_KEY || "";
    if (!apiKey) return null;
    const targetRole = process.env.TARGET_ROLE || "C++开发工程师";
    const prompt = "你正在Boss直聘上和HR聊天找工作。这是HR发给你的消息，请以求职者的身份回复，语气自然口语化，不要客套，像真人聊天。你的技能: " + (skills || "C++,Qt,Linux") + "。目标: " + targetRole + "。HR说: " + (hrMsg || "") + "。请用中文回复，20-50字，自然一点，不要用欢迎感谢之类的客套话开头。";
    try {
      const resp = await fetch("https://api.deepseek.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
        body: JSON.stringify({ model: "deepseek-chat", messages: [{ role: "user", content: prompt }], max_tokens: 200, temperature: 0.8 }),
      });
      const data = await resp.json();
      const text = data?.choices?.[0]?.message?.content || "";
      return text.trim().substring(0, 200) || null;
    } catch (e) {
      log("[deepseek] " + (e.message || "").slice(0, 60));
      return null;
    }
  }

  generateReply(hrMsg, name, skills) {
    const apiKey = process.env.DEEPSEEK_API_KEY || "";
    if (apiKey) return this._deepseekReply(hrMsg, name, skills);
    const fallbacks = [
      "收到，谢谢回复！方便的话可以约个时间详细聊聊吗？",
      "好的，了解了。有什么需要我进一步说明的随时问我。",
      "谢谢您的消息，我对这个岗位挺感兴趣的，希望能有机会跟您详细沟通一下。",
    ];
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
  }

  stop() {
    this.running = false;
    if (this._timer) clearInterval(this._timer);
    log("自动化已停止");
  }
}
