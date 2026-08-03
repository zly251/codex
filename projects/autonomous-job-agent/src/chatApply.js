import * as applicationDb from "./db/application.js";
import * as liveLog from "./log.js";

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

const BLOCKED_HINTS = ["验证码", "安全验证", "访问异常", "访问过于频繁", "系统繁忙", "请登录", "扫码登录"];

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

    while (zhipinPages.length > 2) {
      const extra = zhipinPages.pop();
      try { await extra.close(); log("[page] 关闭多余标签页"); } catch (e) {}
    }

    if (zhipinPages.length > 0) {
      this.page = zhipinPages[0];
      try { await this.page.bringToFront(); } catch (e) {}
      log("[page] 复用已打开的 BOSS 直聘标签页");
      return this.page;
    }

    this.page = await b.newPage();
    await this.page.setViewport({ width: 1400, height: 900 }).catch(() => {});
    try { await this.page.bringToFront(); } catch (e) {}
    log("[page] 新建标签页");
    return this.page;
  }

  async _closeCurrentPage() {
    const p = this.page;
    this.page = null;
    if (p && !p.isClosed()) {
      try { await p.close(); log("[page] 已关闭异常页面"); } catch (e) {}
    }
  }

  async _humanWait(minSec, maxSec) {
    let ms = randBetween(minSec, maxSec) * 1000;
    if (Math.random() < 0.12) ms *= randBetween(1.4, 2.2);
    log(`随机等待 ${(ms / 1000).toFixed(1)} 秒，模拟真人节奏`);
    await sleep(ms);
  }

  async _humanMove(page, x, y) {
    try { await page.bringToFront(); } catch (e) {}
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
    const ok = await page.evaluate(() => {
      const el = document.querySelector("textarea, [contenteditable], [class*='input']");
      if (!el) return false;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.focus();
      el.click();
      return true;
    }).catch(() => false);
    if (!ok) return false;
    await randSleep(500, 900);
    for (const ch of String(text || "")) {
      await page.keyboard.type(ch, { delay: 0 }).catch(() => {});
      await randSleep(60, 240);
      if (Math.random() < 0.05) await randSleep(400, 1100);
    }
    await randSleep(400, 800);
    return true;
  }

  async _checkPageState(page) {
    try {
      return await page.evaluate(() => {
        const body = document.body?.innerText || "";
        let btn = "";
        const sels = [".btn-startchat", "a[ka='job-startchat']", ".op-btn", "[class*='startchat']", "[class*='start-chat']"];
        for (const s of sels) {
          const el = document.querySelector(s);
          if (el && el.offsetParent) { btn = (el.textContent || "").trim(); break; }
        }
        const dialog = document.querySelector(".dialog-footer, .chat-dialog, [class*='dialog']");
        return {
          textLen: body.length,
          btn,
          dialogVisible: !!(dialog && dialog.offsetParent !== null),
          hasDelivered: body.includes("送达") || body.includes("已发送") || body.includes("消息已发送"),
          hasGreeted: ["继续沟通", "查看聊天", "已沟通"].some((t) => btn.includes(t)),
        };
      });
    } catch (e) { return null; }
  }

  async _navigateToChat() {
    const page = await this._getPage();
    let url = page.url();
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

  _progress(options, current, total, title, step) {
    try { options.onProgress?.({ current, total, title, step }); } catch (e) {}
  }

  async autoApply(jobs, options = {}) {
    const page = await this._getPage();
    let applied = 0;
    let failed = 0;
    const results = [];
    const total = (jobs || []).length;
    const delayMin = Number(options.delayMin ?? 8) || 8;
    const delayMax = Number(options.delayMax ?? 25) || 25;

    for (let i = 0; i < total; i++) {
      const job = jobs[i];
      if (!this.running) { log("已收到停止指令，结束投递"); break; }
      try {
        const title = job.title || job.name || "?";
        this._progress(options, i + 1, total, title, "打开职位页");
        log(`[${i + 1}/${total}] 打开职位: ${title} ${job.city || ""} ${job.district || ""}`);
        try { await page.bringToFront(); } catch (e) {}
        await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
        await this._humanWait(2.5, 5);
        try { await page.waitForSelector("body", { timeout: 8000 }); } catch (e) {}

        const state0 = await this._checkPageState(page);
        const bodyText = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
        const blockedHint = BLOCKED_HINTS.find((h) => bodyText.includes(h));
        if (!state0 || state0.textLen < 30 || blockedHint) {
          failed++;
          results.push({ job: title, status: "blocked", reason: blockedHint || "页面无内容" });
          if (blockedHint && (blockedHint.indexOf("请登录") >= 0 || blockedHint.indexOf("扫码登录") >= 0)) {
            log(`[${i + 1}/${total}] BOSS 未登录，停止投递，请先扫码登录: ${title}`);
            this.running = false;
            return { applied, failed, total: applied + failed, results };
          }
          log(`[${i + 1}/${total}] 页面无法查看（${blockedHint || "内容为空"}），关闭该页继续: ${title}`);
          try { await page.screenshot({ path: "data/last_blocked.png", fullPage: false }).catch(() => {}); } catch (e) {}
          await this._closeCurrentPage();
          if (this.running && i < total - 1) await this._humanWait(delayMin, delayMax);
          continue;
        }

        this._progress(options, i + 1, total, title, "定位沟通按钮");
        const clicked = await this._clickFirst(page, START_CHAT_SELECTORS, {
          skipTexts: ["继续沟通", "查看聊天"],
          onLocate: () => this._progress(options, i + 1, total, title, "移动鼠标点击沟通"),
        });

        if (clicked === "skip") {
          results.push({ job: title, status: "skip", reason: "already chatted" });
          log(`[${i + 1}/${total}] 复核：该职位已沟通过，跳过: ${title}`);
          if (this.running && i < total - 1) await this._humanWait(delayMin, delayMax);
          continue;
        }

        if (clicked) {
          this._progress(options, i + 1, total, title, "等待发送弹窗");
          await this._humanWait(2, 4);
          const sent = await this._clickFirst(page, SEND_SELECTORS, {
            onLocate: () => this._progress(options, i + 1, total, title, "点击发送按钮"),
          });
          if (!sent) {
            log(`[${i + 1}/${total}] 未找到发送按钮，尝试回车发送`);
            await page.keyboard.press("Enter").catch(() => {});
            await randSleep(800, 1500);
          }
          await this._humanWait(2, 3.5);

          const v1 = await this._checkPageState(page);
          await this._humanWait(2, 4);
          const v2 = await this._checkPageState(page);
          const verified = !!(v2 && (v2.hasDelivered || v2.hasGreeted));
          log(`[${i + 1}/${total}] 复核确认: ${verified ? "已打过招呼" : "未确认到打招呼"} (送达=${v2?.hasDelivered ? "是" : "否"}, 按钮状态=${v2?.btn || "无"})`);

          if (verified) {
            applied++;
            try { applicationDb.create({ jobId: job.id, status: "pending", notes: "打招呼-复核通过" }); } catch (e) {}
            results.push({ job: title, status: "ok", verified: true });
            log(`[${i + 1}/${total}] 复核通过，确认已打招呼: ${title}`);
          } else {
            failed++;
            results.push({ job: title, status: "unverified", reason: "复核未确认" });
            log(`[${i + 1}/${total}] 复核未确认，记入失败: ${title}`);
            try { await page.screenshot({ path: "data/last_unverified.png", fullPage: false }).catch(() => {}); } catch (e) {}
          }
        } else {
          failed++;
          results.push({ job: title, status: "no_button" });
          log(`[${i + 1}/${total}] 未找到沟通按钮: ${title}`);
          try { await page.screenshot({ path: "data/last_fail.png", fullPage: false }).catch(() => {}); } catch (e) {}
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
    log(`投递结束: 成功 ${applied}，失败 ${failed}，共处理 ${applied + failed}`);
    return { applied, failed, total: applied + failed, results };
  }

  async monitorChat(onMsg, interval) {
    const check = async () => {
      try {
        await this._navigateToChat();

        const data = await this.page.evaluate(() => {
          const r = [];
          document.querySelectorAll("[class*='session'], [class*='chat-item'], [class*='conversation']").forEach((el) => {
            if (el.offsetParent === null) return;
            const name = (el.querySelector("[class*='name']")?.textContent || "").trim();
            const msg = (el.querySelector("[class*='last'], [class*='msg'], [class*='content']")?.textContent || "").trim();
            const unread = !!el.querySelector("[class*='badge'], [class*='num']");
            if (name) r.push({ name, msg, unread });
          });
          if (r.length === 0) {
            document.querySelectorAll("li, [class*='item']").forEach((el) => {
              if (el.offsetParent === null) return;
              const name = (el.textContent || "").trim().split("\n")[0].trim().slice(0, 15);
              const unread = !!el.querySelector("[class*='badge'], [class*='num']");
              if (name && name.length > 0) r.push({ name, msg: "", unread });
            });
          }
          return r;
        }).catch(() => []);

        log(`[chat] 扫描到 ${data.length} 个会话`);
        for (const c of data) {
          if (c.unread) {
            log(`[chat] 收到 ${c.name} 的新消息: ${(c.msg || "").slice(0, 30)}`);
            try { if (onMsg) await onMsg(c); } catch (e) {}
          }
        }
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
