import * as applicationDb from "./db/application.js";
import * as companyDb from "./db/company.js";
import * as jobDb from "./db/job.js";
import * as resumeDb from "./db/resume.js";
import * as liveLog from "./log.js";
import fs from "node:fs";
import path from "node:path";
import { DATA_ROOT } from "./paths.js";
import { buildGreeting } from "./greeting.js";
import * as chatState from "./chatState.js";
import { ensureResumeScreenshot } from "./resumeExport.js";
import { isReplyVerified, isResumeSentEvidence, isResumeAttachmentSentEvidence, RESUME_REQUEST_MARKERS, PENDING_CHIP_HINTS } from "./replyVerification.js";
import * as llmProvider from "./llmProvider.js";

// M5 步骤 1：通用工具与纯判据已抽到 src/core/**（见 docs/05_MODULARIZATION_PLAN.md）
import { sleep, randBetween, randSleep, clamp } from "./core/utils.js";
import {
  CHAT_NOT_READY,
  isGenerationCurrent,
  isResumeFileAccept,
  isResumeSendUnavailable,
  isResumeSendInEffect,
  resolveResumeUploadState,
  resolveResumeUploadPoll,
  resolveRedirectUrl,
  isStartChatApiSuccess,
  isChatPageReady,
  isChatActionReady,
  isChatActionEvidence,
  resolveChatStartPlan,
  isJobDetailReady,
  resolveChatStartState,
  isUsableChatInput,
  isResumePdfItem,
  isResumeFileLastText,
  isSelectedResumeFallbackAllowed,
  isResumeDialogSignal,
  isResumeDialogConfirmAvailable,
  shouldUseResumeVueFallback,
} from "./core/predicates.js";

const log = (msg) => liveLog.add(msg);

const START_CHAT_SELECTORS = [
  ".btn-startchat",
  "a[ka='job-startchat']",
  ".op-btn",
  "[class*='startchat']",
  "[class*='start-chat']",
  "a.btn",
  "button.btn",
];

// 读 data-url/redirect-url 用的“立即沟通”类按钮选择器（真实 BOSS 职位页为
// <a class="btn-startchat" data-url="/wapi/.../add.json" redirect-url="/web/geek/chat?id=...">）。
const START_CHAT_DATA_SELECTORS = [
  ".btn-startchat",
  "a[ka='job-startchat']",
  ".op-btn",
  "[class*='startchat']",
  "[class*='start-chat']",
];

// 当前会话区域选择器：按优先级取第一个可见元素。
// 真实聊天页：当前会话为 .chat-conversation，消息区为 .chat-record / .chat-message；
// .chat-container 包含左侧全部会话列表，绝不能拿它当“当前会话”——左侧列表的
// “送达/已发送”状态不能证明当前会话已成功发送。因此顺序优先消息区/当前会话，
// 最后才回退 .chat-container、[class*='chat']。
const CHAT_AREA_SELECTORS = [
  ".chat-record",
  ".chat-message",
  ".chat-conversation",
  ".chat-container",
  "[class*='chat']",
];
// 聊天页就绪专用：只用具体消息区，不用外层 .chat-container / [class*='chat'] 兜底。
// 空聊天列表也会出现可见 .chat-conversation，不能把它当成具体会话消息区。
export const CHAT_READY_AREA_SELECTORS = [
  ".chat-record",
  ".chat-message",
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
const RESUME_SUBMIT_TEXTS = ["投递简历", "立即投递", "投递附件", "投递"];
const RESUME_SEND_TEXTS = ["发送简历", "发简历", "发送附件", "附件简历", "求简历"];
// 只保留简历/附件专属强特征；通用“已发送/发送成功”也会出现在普通打招呼消息上，不能作为附件已发送证据
export const RESUME_SENT_MARKERS = ["简历已发送", "附件已发送", "已发送简历", "已发送附件", "简历发送成功", "附件发送成功", ...RESUME_REQUEST_MARKERS, "点击预览附件简历"];
export const RESUME_APPLIED_MARKERS = [
  "你与该职位竞争者PK情况",
  "查看详细分析",
  "共人投递，你超过竞争者",
];
export const RESUME_SEND_BUTTON_TEXTS = [...RESUME_SEND_TEXTS];
const RESUME_SEND_BUTTON_SELECTORS = [".toolbar-btn", "button", "a", "[role=button]", "[class*='btn']"];
const RESUME_CHOOSE_DIALOG_SELECTORS = [".choose-resume-dialog", ".dialog-wrap.active"];
const RESUME_CHOOSE_DIALOG_HINT = "请选择要发送的简历";
const RESUME_DIALOG_CONTENT_SELECTOR = ".resume-list, .btn-confirm";
const RESUME_ITEM_SELECTOR = ".resume-list li.list-item";
const RESUME_CONFIRM_TEXT = "发送";
const RESUME_CONFIRM_SELECTORS = [".btn-confirm", ".dialog-footer .btn-primary", "button", "a", "[role=button]"];
const RESUME_UPLOAD_DIALOG_SELECTORS = [".upload-preview", ".dialog-wrap.active"];
const VUE_ACTION_METHODS = ["confirmSend", "handleConfirm", "send", "confirm", "submit", "handleSend", "handleSubmit", "handleClick"];
const CHAT_SESSION_SELECTORS = [
  'li[role="listitem"]',
  "[class*='session']",
  "[class*='chat-item']",
  "[class*='conversation-item']",
  "[class*='conversation']:not(.chat-conversation):not([class*='conversation-list']):not([class*='conversation-container']):not([class*='conversation-list-content'])",
];

const RESUME_UPLOAD_CONFIRM_TEXT = "确定添加";
const RESUME_UPLOAD_CONFIRM_SELECTORS = [
  ".btn-v2.btn-sure-v2",
  ".upload-preview .btn",
  ".dialog-body .btns button",
  ".dialog-body .btns [class*='btn']",
  ".dialog-body .btns [class*='sure']",
  "[class*='sure']",
  "[class*='confirm']",
  "button",
  "a",
  "[role=button]",
];
const UPLOAD_DIALOG_SKIP_SELECTORS = [
  ".upload-preview",
  ".dialog-body",
  "[class*='dialog']",
  "[class*='upload']",
  "[class*='preview']",
];

const BLOCKED_HINTS = ["验证码", "安全验证", "访问异常", "访问过于频繁", "系统繁忙", "请登录", "扫码登录"];
const SENT_MARKERS = ["送达", "已发送", "消息已发送", "发送成功", "已沟通", "继续沟通", "查看聊天", "打招呼成功", "已读"];

// 运行期致命错误文案：浏览器/CDP 连接断开、页面或目标关闭等。这些错误之后任何页面操作都不可能
// 成功，继续扫描只会空转；普通 DOM 异常（元素未找到、渲染抖动）不在此列，仍按可恢复处理。
const FATAL_BROWSER_ERROR_HINTS = [
  "浏览器未连接",
  "页面已关闭",
  "目标已关闭",
  "page closed",
  "target closed",
  "browser disconnected",
  "browser has been disconnected",
  "has been closed",
  "connection closed",
];

export function isFatalBrowserError(e) {
  const msg = String((e && (e.message || e)) || "").toLowerCase();
  return FATAL_BROWSER_ERROR_HINTS.some((h) => msg.includes(h.toLowerCase()));
}

// 聊天输入框选择器：优先真实 BOSS 聊天页的 .chat-input（contenteditable）、
// .chat-editor / .chat-conversation 内的 contenteditable，再回退聊天区 textarea 与
// 聊天作用域内的通用 input。避免裸 [class*='input'] 选中 BOSS 顶部 .boss-search-input。
// _humanType、_checkPageState 与 sendReply 复核共用，保证“输入框已清空”检查选中的是同一个输入框。
// 注：M5 步骤 1 只抽纯函数，本常量属 BOSS 选择器，按蓝图 §4 步骤 2 迁往 platforms/boss/selectors.js。
export const CHAT_INPUT_SELECTORS = [
  ".chat-input:not([class*='search']):not([type='search']):not([aria-label*='搜索'])",
  ".chat-editor [contenteditable]:not([class*='search']):not([aria-label*='搜索'])",
  ".chat-conversation [contenteditable]:not([class*='search']):not([aria-label*='搜索'])",
  ".chat-container textarea:not([class*='search']):not([type='search']):not([aria-label*='搜索'])",
  "[class*='chat'] textarea:not([class*='search']):not([type='search']):not([aria-label*='搜索'])",
  ".chat-container [contenteditable]:not([class*='search']):not([aria-label*='搜索'])",
  "[class*='chat'] [contenteditable]:not([class*='search']):not([aria-label*='搜索'])",
  "[class*='chat'] [class*='input']:not([class*='search']):not([type='search']):not([aria-label*='搜索'])",
];

// —— M5 步骤 1 抽叶：以下符号实现在 ./core/predicates.js，此处逐名 re-export 保持既有 import 面 ——
export {
  CHAT_NOT_READY,
  isGenerationCurrent,
  isResumeFileAccept,
  isResumeSendUnavailable,
  isResumeSendInEffect,
  resolveResumeUploadState,
  resolveResumeUploadPoll,
  resolveRedirectUrl,
  isStartChatApiSuccess,
  isChatPageReady,
  isChatActionReady,
  isChatActionEvidence,
  resolveChatStartPlan,
  isJobDetailReady,
  resolveChatStartState,
  isUsableChatInput,
  isResumePdfItem,
  isResumeFileLastText,
  isSelectedResumeFallbackAllowed,
  isResumeDialogSignal,
  isResumeDialogConfirmAvailable,
  shouldUseResumeVueFallback,
} from "./core/predicates.js";


function normalizeCompany(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/股份有限公司|有限责任公司|有限公司/g, "")
    .replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
}

function normalizeJobTitle(title) {
  return String(title || "").trim().toLowerCase().replace(/\s+/g, "");
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
    // monitorChat 代际：stop() 时递增，旧轮 check 以此识别自己已失效，
    // 防止 stop 后立即 start 时新旧两轮并发处理会话。
    this.generation = 0;
    // monitorChat 互斥标志：setInterval 不等待 async check 完成，_checking 用于防止
    // 上一轮 check 尚未结束（单轮处理多个未读会话超过 interval）时，下一次定时触发
    // 又启动一个并发 check，对同一会话重复回复。
    this._checking = false;
    this.style = style || { greeting: "您好", tone: "礼貌" };
  }

  _isResumeCurrent(options = {}, requireRunningByDefault = false) {
    if (options.generation != null) {
      return isGenerationCurrent(this.running, options.generation, this.generation);
    }
    if (options.allowIdle === true) return true;
    if (options.requireRunning === true || requireRunningByDefault) return !!this.running;
    return true;
  }

  _stoppedResumeResult(fileName) {
    return { ok: false, reason: "stopped", fileName: String(fileName || "") };
  }

  _persistResumeSentForChat(chat, result) {
    const app = this._findApplicationForChat(chat);
    if (!app) return;
    const current = applicationDb.findById(app.id) || app;
    const notes = String(current.notes || "");
    if (!notes.includes("简历-已发送")) {
      applicationDb.updateStatus(app.id, current.status || "pending", [notes, "简历-已发送"].filter(Boolean).join("; "));
    }
  }

  _finishResumeForChat(chat, result, options = {}) {
    if (options.sendResumeScreenshot !== false) {
      chatState.markResumeScreenshotAttempted(chat, result);
    } else {
      chatState.markResumeAttempted(chat, result);
    }
    if (result?.ok) this._persistResumeSentForChat(chat, result);
    return result;
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
    let hasLoginPage = false;
    for (const p of zhipinPages) {
      try {
        const t = await p.evaluate(function () { return document.body ? document.body.innerText : ""; });
        if (t.indexOf("登录/注册") >= 0) hasLoginPage = true;
        if (t.indexOf("登录/注册") < 0) { chosen = p; break; }
      } catch (e) {}
    }

    // 有页面正在登录时不要关闭任何 BOSS 标签页，避免把登录页杀掉。
    if (hasLoginPage) {
      this.page = chosen;
      log("[page] 检测到登录页，保留所有 BOSS 标签页，避免中断登录");
      return this.page;
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

  async _locatePoint(page, selectors, skipTexts = [], skipSelectors = []) {
    const matched = await page.evaluate((sels, skip, skipSels) => {
      const isDisabled = (el) => {
        if (!el || el.disabled) return true;
        if (el.getAttribute && el.getAttribute("aria-disabled") === "true") return true;
        const cls = el.getAttribute ? (el.getAttribute("class") || "") : "";
        return String(cls).split(/\s+/).some((c) => c.includes("disabled"));
      };
      const inSkipArea = (el) => skipSels.some((s) => el.closest && el.closest(s));
      const seen = new Set();
      for (const s of sels) {
        for (const el of document.querySelectorAll(s)) {
          if (seen.has(el)) continue;
          seen.add(el);
          if (!el.offsetParent || el.getClientRects().length === 0 || inSkipArea(el)) continue;
          const txt = (el.textContent || "").trim();
          if (skip.some((t) => txt.includes(t))) return { skip: true };
          if (isDisabled(el)) continue;
          el.scrollIntoView({ block: "center", behavior: "smooth" });
          return true;
        }
      }
      return false;
    }, selectors, skipTexts, skipSelectors).catch(() => false);

    if (matched && matched.skip) return "skip";
    if (!matched) return null;

    await randSleep(900, 1600);

    const point = await page.evaluate((sels, skipSels) => {
      const isDisabled = (el) => {
        if (!el || el.disabled) return true;
        if (el.getAttribute && el.getAttribute("aria-disabled") === "true") return true;
        const cls = el.getAttribute ? (el.getAttribute("class") || "") : "";
        return String(cls).split(/\s+/).some((c) => c.includes("disabled"));
      };
      const inSkipArea = (el) => skipSels.some((s) => el.closest && el.closest(s));
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el && el.offsetParent && el.getClientRects().length > 0 && !isDisabled(el) && !inSkipArea(el)) {
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        }
      }
      return null;
    }, selectors, skipSelectors).catch(() => null);
    return point;
  }

  async _clickFirst(page, selectors, opts = {}) {
    const pt = await this._locatePoint(page, selectors, opts.skipTexts || [], opts.skipSelectors || []);
    if (pt === "skip") return "skip";
    if (!pt) return false;
    try { if (opts.onLocate) opts.onLocate(pt); } catch (e) {}
    await this._humanClick(page, pt.x, pt.y);
    return true;
  }

  async _clickTextControl(page, texts, opts = {}) {
    const tags = opts.tags || ["button", "a", "[role=button]", "[class*='send']", "[class*='submit']", "[class*='btn']"];
    const mode = opts.match || "exact";
    const skipSelectors = opts.skipSelectors || [];
    const found = await page.evaluate((texts, tags, mode, skipSels) => {
      const isDisabled = (el) => {
        if (!el || el.disabled) return true;
        if (el.getAttribute && el.getAttribute("aria-disabled") === "true") return true;
        const cls = el.getAttribute ? (el.getAttribute("class") || "") : "";
        return String(cls).split(/\s+/).some((c) => c.includes("disabled"));
      };
      const inSkipArea = (el) => skipSels.some((s) => el.closest && el.closest(s));
      const list = [];
      for (const sel of tags) {
        for (const el of document.querySelectorAll(sel)) {
          if (!el.offsetParent || el.getClientRects().length === 0 || inSkipArea(el)) continue;
          if (isDisabled(el)) continue;
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
    }, texts, tags, mode, skipSelectors).catch(() => false);
    if (!found) return false;
    await randSleep(800, 1500);
    const pt = await page.evaluate((texts, tags, mode, skipSels) => {
      const isDisabled = (el) => {
        if (!el || el.disabled) return true;
        if (el.getAttribute && el.getAttribute("aria-disabled") === "true") return true;
        const cls = el.getAttribute ? (el.getAttribute("class") || "") : "";
        return String(cls).split(/\s+/).some((c) => c.includes("disabled"));
      };
      const inSkipArea = (el) => skipSels.some((s) => el.closest && el.closest(s));
      const list = [];
      for (const sel of tags) {
        for (const el of document.querySelectorAll(sel)) {
          if (!el.offsetParent || el.getClientRects().length === 0 || inSkipArea(el)) continue;
          if (isDisabled(el)) continue;
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
    }, texts, tags, mode, skipSelectors).catch(() => null);
    if (!pt) return false;
    await this._humanClick(page, pt.x, pt.y);
    return true;
  }

  async _clickSendButton(page) {
    const selectorHit = await this._clickFirst(page, SEND_SELECTORS, { skipSelectors: UPLOAD_DIALOG_SKIP_SELECTORS });
    if (selectorHit) return true;
    const textHit = await this._clickTextControl(page, SEND_TEXTS, { match: "includes", skipSelectors: UPLOAD_DIALOG_SKIP_SELECTORS });
    if (textHit) return true;
    await randSleep(800, 1500);
    return await this._clickTextControl(page, SEND_TEXTS, { match: "includes", skipSelectors: UPLOAD_DIALOG_SKIP_SELECTORS });
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

  async _collectChatPageSnapshot(page) {
    const urlHasChat = /\/chat/.test(page.url());
    const dom = await page.evaluate((areaSels, inputSels) => {
      const isUsableChatInput = (el) => {
        if (!el || el.type === "file") return false;
        const cls = String((el.className && el.className.baseVal) || el.className || el.getAttribute?.("class") || "");
        const label = el.getAttribute ? (el.getAttribute("aria-label") || "") : "";
        const type = String(el.type || "").toLowerCase();
        return !(cls.includes("search") || label.includes("搜索") || type === "search");
      };
      let hasChatArea = false;
      for (const s of areaSels) {
        const el = document.querySelector(s);
        if (el && el.getClientRects().length > 0) {
          hasChatArea = true;
          break;
        }
      }
      let hasChatInput = false;
      for (const s of inputSels) {
        const el = document.querySelector(s);
        if (el && el.getClientRects().length > 0 && isUsableChatInput(el)) {
          hasChatInput = true;
          break;
        }
      }
      return { hasChatArea, hasChatInput };
    }, CHAT_READY_AREA_SELECTORS, CHAT_INPUT_SELECTORS).catch(() => ({ hasChatArea: false, hasChatInput: false }));
    return { urlHasChat, ...dom };
  }

  async _waitForChatReady(page, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let snapshot = await this._collectChatPageSnapshot(page);
    while (Date.now() < deadline) {
      if (isChatPageReady(snapshot)) return true;
      await randSleep(800, 1200);
      snapshot = await this._collectChatPageSnapshot(page);
    }
    return isChatPageReady(snapshot);
  }

  async _waitForChatReadyOrReload(page) {
    if (await this._waitForChatReady(page, 12000)) {
      log("[chat] 聊天页已就绪: " + page.url().slice(0, 80));
      return true;
    }
    log("[chat] 聊天页空壳超时，reload 重试: " + page.url().slice(0, 80));
    await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
    if (await this._waitForChatReady(page, 10000)) {
      log("[chat] reload 后聊天页已就绪: " + page.url().slice(0, 80));
      return true;
    }
    log("[chat] reload 后聊天页仍未就绪: " + page.url().slice(0, 80));
    return false;
  }

  async _waitForChatAction(page, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const actionState = await this._collectChatActionState(page);
      if (isChatActionEvidence(actionState)) return true;
      await randSleep(800, 1200);
    }
    return false;
  }

  async _collectChatActionState(page) {
    try {
      return await page.evaluate(
        (markers, appliedMarkers, areaSels) => {
          const isVisible = (el) => !!el && el.getClientRects().length > 0;
          let chatArea = null;
          for (const sel of areaSels) {
            const el = document.querySelector(sel);
            if (el && isVisible(el)) {
              chatArea = el;
              break;
            }
          }
          const areaText = chatArea ? chatArea.innerText : "";
          return {
            hasChatArea: !!chatArea,
            hasDelivered: markers.some((m) => areaText.includes(m)),
            hasGreeted: ["继续沟通", "查看聊天", "已沟通"].some((t) => areaText.includes(t)),
            hasAppliedResumeMarker: appliedMarkers.some((m) => areaText.includes(m)),
          };
        },
        SENT_MARKERS,
        RESUME_APPLIED_MARKERS,
        CHAT_READY_AREA_SELECTORS
      ).catch(() => ({
        hasChatArea: false,
        hasDelivered: false,
        hasGreeted: false,
        hasAppliedResumeMarker: false,
      }));
    } catch (e) {
      return { hasChatArea: false, hasDelivered: false, hasGreeted: false, hasAppliedResumeMarker: false };
    }
  }

  async _hasChatInputCandidate(page) {
    return await page.evaluate((sels) => {
      const isUsableChatInput = (el) => {
        if (!el || el.type === "file") return false;
        const cls = String((el.className && el.className.baseVal) || el.className || el.getAttribute?.("class") || "");
        const label = el.getAttribute ? (el.getAttribute("aria-label") || "") : "";
        const type = String(el.type || "").toLowerCase();
        return !(cls.includes("search") || label.includes("搜索") || type === "search");
      };
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el && el.getClientRects().length > 0 && isUsableChatInput(el)) return true;
      }
      return false;
    }, CHAT_INPUT_SELECTORS).catch(() => false);
  }

  async _humanType(page, text) {
    if (!(await this._hasChatInputCandidate(page))) return false;
    const selectors = CHAT_INPUT_SELECTORS;
    const focused = await page.evaluate((selectors) => {
      const isUsableChatInput = (el) => {
        if (!el || el.type === "file") return false;
        const cls = String((el.className && el.className.baseVal) || el.className || el.getAttribute?.("class") || "");
        const label = el.getAttribute ? (el.getAttribute("aria-label") || "") : "";
        const type = String(el.type || "").toLowerCase();
        return !(cls.includes("search") || label.includes("搜索") || type === "search");
      };
      let el = null;
      for (const s of selectors) {
        const found = document.querySelector(s);
        if (found && found.getClientRects().length > 0 && isUsableChatInput(found)) { el = found; break; }
      }
      if (!el) return false;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.focus();
      el.click();
      return true;
    }, selectors).catch(() => false);
    if (!focused) return false;
    await randSleep(500, 900);

    const injected = await page.evaluate((text, selectors) => {
      const isUsableChatInput = (el) => {
        if (!el || el.type === "file") return false;
        const cls = String((el.className && el.className.baseVal) || el.className || el.getAttribute?.("class") || "");
        const label = el.getAttribute ? (el.getAttribute("aria-label") || "") : "";
        const type = String(el.type || "").toLowerCase();
        return !(cls.includes("search") || label.includes("搜索") || type === "search");
      };
      let el = null;
      for (const s of selectors) {
        const found = document.querySelector(s);
        if (found && found.getClientRects().length > 0 && isUsableChatInput(found)) { el = found; break; }
      }
      if (!el) return false;
      el.focus();
      if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
        const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) {
          setter.call(el, text);
        } else {
          el.value = text;
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (el.isContentEditable) {
        el.innerHTML = text;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      }
      return true;
    }, String(text || ""), selectors).catch(() => false);
    if (injected) await randSleep(400, 900);

    const typed = await page.evaluate((sels) => {
      const isUsableChatInput = (el) => {
        if (!el || el.type === "file") return false;
        const cls = String((el.className && el.className.baseVal) || el.className || el.getAttribute?.("class") || "");
        const label = el.getAttribute ? (el.getAttribute("aria-label") || "") : "";
        const type = String(el.type || "").toLowerCase();
        return !(cls.includes("search") || label.includes("搜索") || type === "search");
      };
      let el = null;
      for (const s of sels) {
        const found = document.querySelector(s);
        if (found && found.getClientRects().length > 0 && isUsableChatInput(found)) { el = found; break; }
      }
      if (!el) return false;
      const val = el.value || (el.isContentEditable ? el.innerText : "") || "";
      return val.trim().length > 0;
    }, selectors).catch(() => false);
    if (typed) return true;

    for (const ch of String(text || "")) {
      await page.keyboard.type(ch, { delay: 0 }).catch(() => {});
      await randSleep(60, 200);
    }
    await randSleep(300, 700);
    const typed2 = await page.evaluate((sels) => {
      const isUsableChatInput = (el) => {
        if (!el || el.type === "file") return false;
        const cls = String((el.className && el.className.baseVal) || el.className || el.getAttribute?.("class") || "");
        const label = el.getAttribute ? (el.getAttribute("aria-label") || "") : "";
        const type = String(el.type || "").toLowerCase();
        return !(cls.includes("search") || label.includes("搜索") || type === "search");
      };
      let el = null;
      for (const s of sels) {
        const found = document.querySelector(s);
        if (found && found.getClientRects().length > 0 && isUsableChatInput(found)) { el = found; break; }
      }
      if (!el) return false;
      const val = el.value || (el.isContentEditable ? el.innerText : "") || "";
      return val.trim().length > 0;
    }, selectors).catch(() => false);
    if (typed2) return true;

    return await page.evaluate((text, selectors) => {
      const isUsableChatInput = (el) => {
        if (!el || el.type === "file") return false;
        const cls = String((el.className && el.className.baseVal) || el.className || el.getAttribute?.("class") || "");
        const label = el.getAttribute ? (el.getAttribute("aria-label") || "") : "";
        const type = String(el.type || "").toLowerCase();
        return !(cls.includes("search") || label.includes("搜索") || type === "search");
      };
      let el = null;
      for (const s of selectors) {
        const found = document.querySelector(s);
        if (found && found.getClientRects().length > 0 && isUsableChatInput(found)) { el = found; break; }
      }
      if (!el) return false;
      el.focus();
      if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
        el.value = text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (el.isContentEditable) {
        el.innerHTML = text;
        el.dispatchEvent(new InputEvent("input", { bubbles: true }));
      }
      return true;
    }, String(text || ""), selectors).catch(() => false);
  }

  async _checkPageState(page) {
    try {
      return await page.evaluate((markers, areaSels, inputSels) => {
        const body = document.body?.innerText || "";
        const isUsableChatInput = (el) => {
          if (!el || el.type === "file") return false;
          const cls = String((el.className && el.className.baseVal) || el.className || el.getAttribute?.("class") || "");
          const label = el.getAttribute ? (el.getAttribute("aria-label") || "") : "";
          const type = String(el.type || "").toLowerCase();
          return !(cls.includes("search") || label.includes("搜索") || type === "search");
        };
        const isDisabled = (el) => {
          if (!el || el.disabled) return true;
          if (el.getAttribute && el.getAttribute("aria-disabled") === "true") return true;
          const cls = el.getAttribute ? (el.getAttribute("class") || "") : "";
          return String(cls).split(/\s+/).some((c) => c.includes("disabled"));
        };
        // 当前会话区域：按优先级取第一个可见元素（消息区优先，绝不能拿左侧会话列表
        // .chat-container 当当前会话——列表里的“送达/已发送”状态与当前会话无关）。
        // 聊天容器多为 fixed/absolute 布局，offsetParent 为 null，用 getClientRects 判可见。
        let chatArea = null;
        for (const s of areaSels) {
          const el = document.querySelector(s);
          if (el && el.getClientRects().length > 0) { chatArea = el; break; }
        }
        const chatText = chatArea ? chatArea.innerText : body;
        let btn = "";
        const btnSels = [".btn-startchat", "a[ka='job-startchat']", ".op-btn", "[class*='startchat']", "[class*='start-chat']"];
        for (const s of btnSels) {
          const el = document.querySelector(s);
          if (el && el.offsetParent) { btn = (el.textContent || "").trim(); break; }
        }
        const dialog = document.querySelector(".dialog-footer, .chat-dialog, [class*='dialog']");
        // 输入框：只使用聊天作用域选择器，避免裸 [class*='input'] 选中顶部搜索框；
        // 聊天容器可能是 fixed/absolute，用 getClientRects 判断可见。
        let input = null;
        for (const s of inputSels) {
          const found = document.querySelector(s);
          if (found && found.getClientRects().length > 0 && isUsableChatInput(found)) { input = found; break; }
        }
        const inputValue = input ? (input.value || (input.isContentEditable ? input.innerText : "") || "").trim() : "";
        // 发送按钮可见性：跳过 property disabled / aria-disabled=true / class 含 disabled 的控件
        const sendVisible = Array.from(document.querySelectorAll("button, a, [role=button], [class*='send'], [class*='submit'], [class*='btn']")).some((el) => {
          if (!el.offsetParent || el.getClientRects().length === 0 || isDisabled(el)) return false;
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
          // 送达/已沟通判定只基于当前会话区域文本，避免左侧会话列表的“送达/已发送”误判当前会话
          hasDelivered: markers.some(function (s) { return chatText.includes(s); }),
          hasGreeted: ["继续沟通", "查看聊天", "已沟通"].some((t) => chatText.includes(t)),
        };
      }, SENT_MARKERS, CHAT_AREA_SELECTORS, CHAT_INPUT_SELECTORS);
    } catch (e) { return null; }
  }

  // 是否已处于可用的聊天页：URL 含 /chat，且已出现聊天输入/消息区元素，避免空壳 URL 误判。
  async _isOnChatPage(page) {
    try {
      return isChatPageReady(await this._collectChatPageSnapshot(page));
    } catch (e) {
      return false;
    }
  }

  async _collectJobDetailState(page) {
    try {
      return await page.evaluate((sels) => {
        const url = location.href;
        const isJobDetail = /(\/job\/|jobdetail|job-detail|job_detail)/i.test(url);
        let hasStartChat = false;
        for (const s of sels) {
          const el = document.querySelector(s);
          if (el && el.offsetParent && el.getClientRects().length > 0) {
            hasStartChat = true;
            break;
          }
        }
        return { isJobDetail, hasStartChat };
      }, START_CHAT_DATA_SELECTORS).catch(() => ({ isJobDetail: false, hasStartChat: false }));
    } catch (e) {
      return { isJobDetail: false, hasStartChat: false };
    }
  }

  // 通过职位页“立即沟通”按钮开启会话：新沟通优先调用 data-url API，
  // 成功后 goto redirect-url；只有没有 data-url 时才直接 goto redirect-url。
  // 返回："skip" = 已沟通过跳过；true = 已进入聊天页；
  // CHAT_NOT_READY = 无法安全进入聊天页，调用方应失败跳过，不回退职位页人工点击。
  async _startChatWithJob(page) {
    const SKIP_TEXTS = ["继续沟通", "查看聊天", "已沟通"];
    let info = await page.evaluate((sels) => {
      const seen = new Set();
      const candidates = [];
      const asideSel = "[class*='recommend'], [class*='sider'], [class*='aside'], [class*='relation'], [class*='job-card'], [class*='job-item'], [class*='hot'], [class*='similar']";
      for (const s of sels) {
        for (const el of document.querySelectorAll(s)) {
          if (seen.has(el)) continue;
          seen.add(el);
          if (!el.offsetParent || el.getClientRects().length === 0) continue;
          const txt = (el.textContent || "").trim();
          const dataUrl = el.getAttribute("data-url") || "";
          const redirectUrl = el.getAttribute("redirect-url") || "";
          const href = el.getAttribute("href") || "";
          const inAside = !!(el.closest && el.closest(asideSel));
          const isMain = !!dataUrl || !!redirectUrl || el.matches("a[ka='job-startchat']") || el.classList.contains("btn-startchat");
          // 推荐/侧边栏里的按钮如果没有 data-url/redirect-url，不作为主按钮。
          if (inAside && !dataUrl && !redirectUrl) continue;
          candidates.push({ txt, dataUrl, redirectUrl, href, isMain });
        }
      }
      // 优先返回带 data-url/redirect-url 的主沟通按钮；没有再回退第一个可见候选。
      return candidates.find((c) => c.isMain) || candidates[0] || null;
    }, START_CHAT_DATA_SELECTORS).catch(() => null);

    // 选择器没命中时，按文字再找一次“立即沟通/继续沟通”类按钮。
    if (!info) {
      info = await page.evaluate((startTexts, skipTexts) => {
        const asideSel = "[class*='recommend'], [class*='sider'], [class*='aside'], [class*='relation'], [class*='job-card'], [class*='job-item'], [class*='hot'], [class*='similar']";
        for (const el of document.querySelectorAll("a, button, [role=button], [class*='btn']")) {
          if (!el.offsetParent || el.getClientRects().length === 0) continue;
          const txt = (el.textContent || "").trim();
          const isStart = startTexts.some((t) => txt.includes(t));
          const isSkip = skipTexts.some((t) => txt.includes(t));
          if (!isStart && !isSkip) continue;
          const dataUrl = el.getAttribute("data-url") || "";
          const redirectUrl = el.getAttribute("redirect-url") || "";
          const href = el.getAttribute("href") || "";
          const inAside = !!(el.closest && el.closest(asideSel));
          if (inAside && !dataUrl && !redirectUrl) continue;
          return { txt, dataUrl, redirectUrl, href, isMain: !!dataUrl || !!redirectUrl };
        }
        return null;
      }, START_TEXTS, SKIP_TEXTS).catch(() => null);
    }

    if (!info) {
      log("[chat] 未找到立即沟通/startchat 入口，跳过职位页人工点击");
      return CHAT_NOT_READY;
    }

    // 已沟通过的职位按钮为“继续沟通/查看聊天/已沟通”，直接跳过，不重复沟通。
    // 只有确认是主按钮（带 data-url/redirect-url 或明确 startchat 类）才跳过，
    // 避免被推荐职位里的“继续沟通”按钮误伤。
    if (SKIP_TEXTS.some((t) => info.txt.includes(t)) && (info.isMain || info.dataUrl || info.redirectUrl)) {
      log("[chat] 该职位已沟通过（按钮: " + info.txt + "），跳过");
      return "skip";
    }

    const plan = resolveChatStartPlan({
      hasRedirectUrl: !!info.redirectUrl,
      hasDataUrl: !!info.dataUrl,
    });

    if (plan === "api_first") {
      const callStartApi = async () => page.evaluate(async (dataUrl) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 15000);
          try {
            const resp = await fetch(dataUrl, {
              method: "GET",
              credentials: "include",
              headers: { "X-Requested-With": "XMLHttpRequest" },
              signal: controller.signal,
            });
            if (!resp.ok) return false;
            // 非 JSON 响应（登录页 HTML 等）data=null，不能算成功，直接视为不可用
            const data = await resp.json().catch(() => null);
            return !!data && (String(data.code) === "0" || data.code === 0);
          } catch (e) {
            return false;
          } finally {
            clearTimeout(timer);
          }
        }, info.dataUrl).catch(() => false);
      let fetchOk = await callStartApi();
      if (!fetchOk) {
        log("[chat] startchat API 首次失败，等待后重试: " + info.dataUrl.slice(0, 60));
        await randSleep(2000, 4000);
        fetchOk = await callStartApi();
      }

      if (!fetchOk) {
        log("[chat] startchat API 失败或超时，返回 CHAT_NOT_READY: " + info.dataUrl.slice(0, 60));
        return CHAT_NOT_READY;
      }
      log("[chat] startchat API 成功: " + info.dataUrl.slice(0, 60));
      await randSleep(800, 1600);
      if (info.redirectUrl) {
        const abs = resolveRedirectUrl(info.redirectUrl, page.url());
        log("[chat] startchat API 成功，跳转聊天页: " + abs.slice(0, 80));
        await page.goto(abs, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
      }
      if (!(await this._waitForChatReadyOrReload(page))) return CHAT_NOT_READY;
      if (await this._waitForChatAction(page, 7000)) {
        log("[chat] 检测到 BOSS 异步沟通动作证据: " + page.url().slice(0, 80));
      } else {
        log("[chat] 聊天页已就绪但未检测到异步动作证据，继续手动流程: " + page.url().slice(0, 80));
      }
      return true;
    }

    if (plan === "direct_goto") {
      const abs = resolveRedirectUrl(info.redirectUrl, page.url());
      log("[chat] 无 data-url，直接使用 redirect-url 跳转聊天页: " + abs.slice(0, 80));
      await page.goto(abs, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
      if (!(await this._waitForChatReadyOrReload(page))) return CHAT_NOT_READY;
      if (await this._waitForChatAction(page, 7000)) {
        log("[chat] 检测到 BOSS 异步沟通动作证据: " + page.url().slice(0, 80));
      } else {
        log("[chat] 聊天页已就绪但未检测到异步动作证据，继续手动流程: " + page.url().slice(0, 80));
      }
      return true;
    }

    log("[chat] 无 redirect-url/data-url，跳过职位页人工点击");
    return CHAT_NOT_READY;
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
      const selectors = [
        'li[role="listitem"]',
        "[class*='session']",
        "[class*='chat-item']",
        "[class*='conversation-item']",
        "[class*='conversation']:not(.chat-conversation):not([class*='conversation-list']):not([class*='conversation-container']):not([class*='conversation-list-content'])",
      ];
      const seen = new Set();
      document.querySelectorAll(selectors.join(",")).forEach((li) => {
        if (seen.has(li)) return;
        seen.add(li);
        const className = String(li.className || li.getAttribute?.("class") || "");
        const isSessionContainer = ["conversation-list", "conversation-container", "conversation-list-content", "chat-container", "chat-list", "user-list"]
          .some((token) => className.includes(token)) && !className.includes("item");
        if (isSessionContainer) return;
        const isCurrentChatPanel = className.includes("chat-conversation") || (li.closest && li.closest(".chat-conversation"));
        if (isCurrentChatPanel) return;
        if (!li.offsetParent && li.getClientRects().length === 0) return;
        const name = (li.querySelector(".name-text")?.textContent || li.querySelector("[class*='name']")?.textContent || "").trim();
        const nameBox = li.querySelector(".name-box");
        const company = (nameBox?.children?.[1]?.textContent || li.querySelector("[class*='company']")?.textContent || "").trim();
        const msg = (li.querySelector(".last-msg-text")?.textContent || li.querySelector("[class*='last-msg']")?.textContent || li.querySelector("[class*='message']")?.textContent || "").trim();
        const status = (li.querySelector(".message-status, [class*='status-']")?.textContent || "").trim();
        const hrLast = !/\[(送达|已读)\]/.test(status || "") && !/^\[(送达|已读)\]/.test(msg || "");
        const badge = li.querySelector("[class*='badge'], [class*='num']")?.textContent?.trim() || "";
        const unread = /^\d+$/.test(badge) && Number(badge) > 0;
        const rowId = li.getAttribute("data-id") || li.getAttribute("data-sessionid") || li.getAttribute("data-conversation-id") || "";
        const href = li.querySelector("a[href]")?.getAttribute("href") || "";
        if (name || company || msg) {
          rows.push({ name, company, msg, status, hrLast, unread, rowId, href, text: (li.innerText || "").slice(0, 500) });
        }
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

  _findApplicationForChat(chat, apps = null) {
    const source = apps || applicationDb.findAll();
    let bossJobId = "";
    const href = String(chat?.href || "");
    const hrefMatch = href.match(/[?&]jobId=([^&#]+)/i);
    if (hrefMatch) {
      try {
        bossJobId = decodeURIComponent(hrefMatch[1]);
      } catch (e) {
        bossJobId = hrefMatch[1];
      }
    }
    const rawRowId = String(chat?.rowId || "").trim();
    if (!bossJobId) bossJobId = rawRowId;
    if (/^\d+$/.test(rawRowId)) {
      const byLocalId = (source || []).find((app) => String(app.jobId || "") === rawRowId);
      if (byLocalId) return byLocalId;
    }
    if (bossJobId) {
      const bossTarget = String(bossJobId);
      const escaped = bossTarget.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const bossUrlPattern = new RegExp(`/job_detail/${escaped}\\.html`, "i");
      const byBoss = (source || []).find((app) => {
        if (!app.jobId) return false;
        const job = jobDb.findById(app.jobId);
        if (!job) return false;
        return bossUrlPattern.test(String(job.url || "")) ||
          String(job.rawData || "").includes(bossTarget);
      });
      if (byBoss) return byBoss;
    }
    const jobTitle = String(chat?.jobTitle || "").trim();
    const companyNeedle = normalizeCompany(chat?.company || chat?.name);
    if (jobTitle && !companyNeedle) return null;
    if (jobTitle) {
      const titleNeedle = normalizeJobTitle(jobTitle);
      for (const app of source || []) {
        const job = app.jobId ? jobDb.findById(app.jobId) : null;
        if (!job) continue;
        if (companyNeedle) {
          const company = job.companyId ? companyDb.findById(job.companyId) : null;
          const candidate = normalizeCompany(company?.name || job.companyName || "");
          if (!candidate || (candidate !== companyNeedle && !candidate.includes(companyNeedle) && !companyNeedle.includes(candidate))) {
            continue;
          }
        }
        const candidateTitle = normalizeJobTitle(job.title);
        if (candidateTitle && candidateTitle === titleNeedle) return app;
      }
    }
    return this._findApplicationByCompany(source, chat?.company || chat?.name);
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
      // 不再以“聊天区长度增长”作为成功证据：HR 的新消息同样会让长度增长，会造成误判。
      // 仅保留“聊天弹窗关闭且发送前有发送按钮”这类明确证据。
      if (before.dialogVisible && !after.dialogVisible && before.hasSendVisible) return true;
    }
    return false;
  }

  _findResumeForJob(job) {
    const byId = job?.resumeId ? resumeDb.findById(job.resumeId) : null;
    return byId || resumeDb.findDefault() || resumeDb.findAll()[0];
  }

  _findResumeForChat(chat) {
    const app = this._findApplicationForChat(chat);
    const job = app?.jobId ? jobDb.findById(app.jobId) : null;
    return job ? this._findResumeForJob(job) : resumeDb.findDefault() || resumeDb.findAll()[0];
  }

  async _clickResumeSubmitButton(page) {
    const hit = await this._clickTextControl(page, RESUME_SUBMIT_TEXTS, { match: "includes" });
    if (!hit) return false;
    await this._humanWait(2, 4);
    // 判据不用 inputExists：仅出现聊天输入框不代表简历已提交。投递是否成功
    // 以聊天区出现发送按钮/送达/已沟通状态为准。
    const submitted = (state) => !!(state && (state.hasSendVisible || state.hasDelivered || state.hasGreeted));
    let state = await this._checkPageState(page);
    if (submitted(state)) {
      return true;
    }
    // 第一次状态未确认时复查一轮：异步渲染较慢时避免误判后再次上传附件。不做无限重试。
    await randSleep(1.5, 3);
    state = await this._checkPageState(page);
    return submitted(state);
  }

  async _collectResumeSendState(page) {
    return await page.evaluate(
      (sels, texts) => {
        const isVisible = (el) => !!el && el.getClientRects().length > 0;
        const isDisabled = (el) => {
          if (!el || el.disabled) return true;
          if (el.getAttribute && el.getAttribute("aria-disabled") === "true") return true;
          const cls = el.getAttribute ? (el.getAttribute("class") || "") : "";
          return String(cls).split(/\s+/).some((c) => c.includes("disabled") || c.includes("unable"));
        };
        let found = null;
        for (const s of sels) {
          for (const el of document.querySelectorAll(s)) {
            if (!isVisible(el)) continue;
            const txt = (el.textContent || "").trim();
            const aria = el.getAttribute ? (el.getAttribute("aria-label") || "") : "";
            const combined = `${txt} ${aria}`;
            if (texts.some((t) => combined.includes(t)) || /求简历|发简历|发送简历|附件简历/.test(combined)) {
              found = el;
              break;
            }
          }
          if (found) break;
        }
        const stateEl =
          found && found.closest
            ? found.closest('[class*="unable"], [class*="disabled"], [aria-label*="求简历"], [aria-label*="正在请求中"], [aria-disabled="true"]') || found
            : found;
        return {
          hasVisibleResumeSend: !!found,
          resumeSendDisabled: found ? isDisabled(stateEl) : false,
          resumeSendAriaLabel: stateEl ? (stateEl.getAttribute ? (stateEl.getAttribute("aria-label") || "") : "") : "",
          resumeSendText: found ? (found.textContent || "").trim() : "",
        };
      },
      [
        "[aria-label*='求简历']",
        "[aria-label*='发简历']",
        "[class*='unable']",
        "[class*='toolbar-btn']",
        "button",
        "a",
        "[role=button]",
        "[class*='btn']",
        "[class*='resume']",
        "[class*='file']",
        "[class*='attach']",
      ],
      RESUME_SEND_TEXTS
    ).catch(() => ({
      hasVisibleResumeSend: false,
      resumeSendDisabled: false,
      resumeSendAriaLabel: "",
      resumeSendText: "",
    }));
  }

  async _isResumeSendUnavailable(page) {
    try {
      return isResumeSendUnavailable(await this._collectResumeSendState(page));
    } catch (e) {
      return false;
    }
  }

  async _resumeSendInEffect(page) {
    try {
      return isResumeSendInEffect(await this._collectResumeSendState(page));
    } catch (e) {
      return false;
    }
  }

  async _collectSelectedResumeLastText(page) {
    return await page.evaluate(() => {
      const isVisible = (el) => !!el && el.getClientRects().length > 0;
      const texts = [];
      const add = (value) => {
        const t = String(value || "").trim();
        if (t && !texts.includes(t) && texts.length < 20) texts.push(t);
      };
      const readVue = (el) => {
        let node = el;
        for (let depth = 0; node && depth < 8; depth++) {
          const vm = node.__vue__ || node.__vueParentComponent;
          if (vm) {
            const sources = [vm.props, vm.$props, vm.proxy, vm.ctx, vm.setupState, vm.data, vm.$data];
            for (const src of sources) {
              if (!src) continue;
              add(src.lastText);
              add(src.lastMsg);
              add(src.lastMessage);
              add(src.msg);
            }
          }
          node = node.parentElement;
        }
      };
      const containerSelectors = [
        ".user-list-content",
        "[class*='user-list']",
        "[class*='session-list']",
        "[class*='chat-list']",
        "[class*='conversation-list']",
        "[class*='friend-list']",
        "[class*='contact-list']",
      ];
      const itemSelectors = [
        ".friend-content.selected",
        "[class*='session'].selected",
        "[class*='chat-item'].selected",
        "[class*='conversation'].selected",
        "li[role='listitem'].selected",
      ];
      const seen = new Set();
      for (const containerSel of containerSelectors) {
        for (const container of document.querySelectorAll(containerSel)) {
          if (!isVisible(container)) continue;
          for (const s of itemSelectors) {
            for (const el of container.querySelectorAll(s)) {
              if (!isVisible(el) || seen.has(el)) continue;
              seen.add(el);
              const lastMsg = el.querySelector(".last-msg-text") || el.querySelector("[class*='last-msg']") || el.querySelector("[class*='message']");
              if (lastMsg) add(lastMsg.textContent);
              readVue(el);
              const own = (el.innerText || "").trim();
              if (own && own.length <= 200) add(own);
            }
          }
        }
      }
      return texts;
    }).catch(() => []);
  }

  async _selectedResumeSent(page, fileName, altNames = []) {
    const state = await this._collectResumeState(page, fileName, altNames);
    if (!isSelectedResumeFallbackAllowed(state)) return false;
    const texts = await this._collectSelectedResumeLastText(page);
    return isResumeFileLastText(texts, [fileName, ...altNames]);
  }

  async _collectResumeState(page, fileName, altNames = []) {
    try {
      return await page.evaluate(
        (fname, altNames, sentMarkers, appliedMarkers, requestMarkers, dialogSels, dialogHint, dialogContentSel, uploadDialogSels, hints, areaSels, confirmText, confirmSels) => {
          const isVisible = (el) => !!el && el.getClientRects().length > 0;
          const isDisabled = (el) => {
            if (!el || el.disabled) return true;
            if (el.getAttribute && el.getAttribute("aria-disabled") === "true") return true;
            const cls = el.getAttribute ? (el.getAttribute("class") || "") : "";
            return String(cls).split(/\s+/).some((c) => c.includes("disabled"));
          };
          const findConfirmButton = () => {
            for (const rootSel of uploadDialogSels) {
              const root = document.querySelector(rootSel);
              if (!root || !isVisible(root)) continue;
              for (const sel of confirmSels) {
                for (const el of root.querySelectorAll(sel)) {
                  if (!isVisible(el)) continue;
                  const txt = (el.textContent || "").trim();
                  if (txt.includes(confirmText)) return el;
                }
              }
            }
            return null;
          };

          let chatArea = null;
          for (const sel of areaSels) {
            const el = document.querySelector(sel);
            if (el && el.getClientRects().length > 0) {
              chatArea = el;
              break;
            }
          }
          const areaText = chatArea ? chatArea.innerText : "";
          const fileNameMatches = (txt) => [fname, ...altNames].some((n) => n && txt.includes(n));
          const hasFileName = fileNameMatches(areaText);
          // 竞争者PK/共人投递/查看详细分析只能证明发生过在线投递动作，
          // 不能证明“附件/在线简历已发送”，因此不能并入附件强特征。
          const hasStrongResumeMarker = sentMarkers.some((m) => areaText.includes(m));
          const hasAppliedResumeMarker = appliedMarkers.some((m) => areaText.includes(m));
          const hasRequestMarker = requestMarkers.some((m) => areaText.includes(m));

          let pendingFile = false;
          for (const el of document.querySelectorAll("input[type=file]")) {
            if (el.files && el.files.length > 0) {
              pendingFile = true;
              break;
            }
          }

          let pendingChip = false;
          const chipSels = ["[class*='file']", "[class*='attach']", "[class*='upload']", "[class*='preview']", "[class*='pending']"];
          if (chatArea) {
            for (const sel of chipSels) {
              for (const el of chatArea.querySelectorAll(sel)) {
                if (!el.offsetParent || el.getClientRects().length === 0) continue;
                const txt = (el.textContent || "").trim();
                if (!txt) continue;
                if (hints.some((h) => txt.includes(h)) && fileNameMatches(txt)) {
                  pendingChip = true;
                  break;
                }
              }
              if (pendingChip) break;
            }
          }

          const confirmButton = findConfirmButton();
          const chooseDialogOpen = dialogSels.some((s) => {
            const el = document.querySelector(s);
            return el && isVisible(el) && ((el.innerText || "").includes(dialogHint) || !!el.querySelector(dialogContentSel));
          });
          return {
            hasFileName,
            hasStrongResumeMarker,
            hasAppliedResumeMarker,
            hasRequestMarker,
            hasChatArea: !!chatArea,
            chatAreaText: areaText.slice(0, 2000),
            pendingFile,
            pendingChip,
            confirmVisible: !!confirmButton || chooseDialogOpen,
            confirmDisabled: confirmButton ? isDisabled(confirmButton) : false,
          };
        },
        String(fileName || ""),
        altNames,
        RESUME_SENT_MARKERS,
        RESUME_APPLIED_MARKERS,
        RESUME_REQUEST_MARKERS,
        RESUME_CHOOSE_DIALOG_SELECTORS,
        RESUME_CHOOSE_DIALOG_HINT,
        RESUME_DIALOG_CONTENT_SELECTOR,
        RESUME_UPLOAD_DIALOG_SELECTORS,
        PENDING_CHIP_HINTS,
        CHAT_READY_AREA_SELECTORS,
        RESUME_UPLOAD_CONFIRM_TEXT,
        RESUME_UPLOAD_CONFIRM_SELECTORS
      ).catch(() => null);
    } catch (e) {
      return null;
    }
  }

  async _resumeSentMarker(page, fileName, options = {}, altNames = []) {
    try {
      const collected = await this._collectResumeState(page, fileName, altNames);
      if (!collected) return false;
      return isResumeAttachmentSentEvidence(collected, {
        allowResidualInput: options.allowResidualInput === true,
        ignoreConfirmVisible: options.ignoreConfirmVisible === true,
      });
    } catch (e) {
      return false;
    }
  }

  async _hasVisibleSend(page) {
    return await page.evaluate((skipSels) => {
      const isDisabled = (el) => {
        if (!el || el.disabled) return true;
        if (el.getAttribute && el.getAttribute("aria-disabled") === "true") return true;
        const cls = el.getAttribute ? (el.getAttribute("class") || "") : "";
        return String(cls).split(/\s+/).some((c) => c.includes("disabled"));
      };
      const inSkipArea = (el) => skipSels.some((s) => el.closest && el.closest(s));
      return Array.from(document.querySelectorAll("button,a,[role=button],[class*='send'],[class*='submit'],[class*='btn']")).some((el) => {
        if (!el.offsetParent || el.getClientRects().length === 0 || isDisabled(el) || inSkipArea(el)) return false;
        const txt = (el.textContent || "").trim();
        return ["发送", "提交", "确定"].some((t) => txt.includes(t));
      });
    }, UPLOAD_DIALOG_SKIP_SELECTORS).catch(() => false);
  }

  async _clickResumeConfirm(page) {
    return await page.evaluate((rootSelectors, confirmSels, confirmText) => {
      const isVisible = (el) => !!el && el.getClientRects().length > 0;
      const isDisabled = (el) => {
        if (!el || el.disabled) return true;
        if (el.getAttribute && el.getAttribute("aria-disabled") === "true") return true;
        const cls = el.getAttribute ? (el.getAttribute("class") || "") : "";
        return String(cls).split(/\s+/).some((c) => c.includes("disabled") || c.includes("unable"));
      };
      for (const rootSel of rootSelectors) {
        const root = document.querySelector(rootSel);
        if (!root || !isVisible(root)) continue;
        for (const sel of confirmSels) {
          for (const el of root.querySelectorAll(sel)) {
            if (isVisible(el) && !isDisabled(el) && (el.textContent || "").includes(confirmText)) {
              el.click();
              return true;
            }
          }
        }
      }
      return false;
    }, RESUME_UPLOAD_DIALOG_SELECTORS, RESUME_UPLOAD_CONFIRM_SELECTORS, RESUME_UPLOAD_CONFIRM_TEXT).catch(() => false);
  }

  async _confirmResumeUpload(page, fileName, options = {}) {
    let seen = false;
    let clicked = false;
    let lastConfirmVisible = false;
    let lastStep = "unsent";
    const stoppedResult = () => ({
      stopped: true,
      reason: "stopped",
      seen,
      clicked,
      closed: true,
      sent: false,
    });
    const check = () => this._isResumeCurrent(options) ? null : stoppedResult();
    for (let i = 0; i < 12; i++) {
      const stopped = check();
      if (stopped) return stopped;
      const state = (await this._collectResumeState(page, fileName)) || {};
      const decision = resolveResumeUploadPoll(state, {
        allowFileName: !!clicked,
        allowResidualInput: !!clicked || seen || i >= 3,
        allowFallback: false,
      });
      lastStep = decision.step;
      if (decision.confirmVisible) {
        seen = true;
        lastConfirmVisible = true;
        if (decision.poll === "click_confirm" && !clicked) {
          const beforeClick = check();
          if (beforeClick) return beforeClick;
          clicked = await this._clickResumeConfirm(page);
          const afterClick = check();
          if (afterClick) return afterClick;
          if (!clicked) {
            const beforeWait = check();
            if (beforeWait) return beforeWait;
            await randSleep(600, 1000);
          }
        } else {
          const beforeWait = check();
          if (beforeWait) return beforeWait;
          await randSleep(600, 1000);
        }
        continue;
      }

      lastConfirmVisible = false;
      if (decision.poll === "return_sent") {
        return { seen, clicked, closed: true, sent: true, reason: "auto_sent" };
      }
      if (decision.poll === "wait") {
        const beforeWait = check();
        if (beforeWait) return beforeWait;
        await randSleep(600, 1000);
        continue;
      }

      if (i >= 11) {
        const canFallback = !seen && !clicked && lastStep === "unsent";
        return {
          seen,
          clicked,
          closed: !seen || !lastConfirmVisible,
          fallback: canFallback,
          sent: false,
          reason: seen ? (lastConfirmVisible ? "upload_confirm_timeout" : "closed") : canFallback ? "no_confirm" : "pending_timeout",
        };
      }
      const beforeWait = check();
      if (beforeWait) return beforeWait;
      await randSleep(600, 1000);
    }
    return {
      seen,
      clicked,
      closed: !seen || !lastConfirmVisible,
      fallback: !seen && !clicked && lastStep === "unsent",
      sent: false,
      reason: lastConfirmVisible
        ? "upload_confirm_timeout"
        : seen
          ? "closed"
          : lastStep === "wait_sent"
            ? "pending_timeout"
            : "no_confirm",
    };
  }

  async _waitForResumeDialog(page, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    const checkOnce = async () => {
      const state = await page.evaluate((dialogSels, hint) => {
        const isVisible = (el) => !!el && el.getClientRects().length > 0;
        for (const s of dialogSels) {
          const el = document.querySelector(s);
          if (el && isVisible(el)) {
            const current = {
              hasDialog: true,
              hasResumeList: !!el.querySelector(".resume-list"),
              hasConfirmButton: !!el.querySelector(".btn-confirm"),
              hasHint: (el.innerText || "").includes(hint),
            };
            if (current.hasResumeList || current.hasConfirmButton || current.hasHint) return current;
          }
        }
        return { hasDialog: false, hasResumeList: false, hasConfirmButton: false, hasHint: false };
      }, RESUME_CHOOSE_DIALOG_SELECTORS, RESUME_CHOOSE_DIALOG_HINT).catch(() => null);
      return !!(state && isResumeDialogSignal(state));
    };
    if (await checkOnce()) return true;
    while (Date.now() < deadline) {
      await randSleep(500, 900);
      if (await checkOnce()) return true;
    }
    return false;
  }

  async _waitForResumeConfirmEnabled(page, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ok = await page.evaluate((dialogSels, confirmSels, confirmText) => {
        const isVisible = (el) => !!el && el.getClientRects().length > 0;
        const isDisabled = (el) => {
          if (!el || el.disabled) return true;
          if (el.getAttribute && el.getAttribute("aria-disabled") === "true") return true;
          const cls = el.getAttribute ? (el.getAttribute("class") || "") : "";
          return String(cls).split(/\s+/).some((c) => c.includes("disabled") || c.includes("unable"));
        };
        for (const s of dialogSels) {
          const root = document.querySelector(s);
          if (!root || !isVisible(root)) continue;
          for (const s of confirmSels) {
            for (const el of root.querySelectorAll(s)) {
              if (isVisible(el) && !isDisabled(el) && (el.textContent || "").includes(confirmText)) return true;
            }
          }
        }
        return false;
      }, RESUME_CHOOSE_DIALOG_SELECTORS, RESUME_CONFIRM_SELECTORS, RESUME_CONFIRM_TEXT).catch(() => false);
      if (ok) return true;
      await randSleep(500, 900);
    }
    return false;
  }

  async _invokeVueMethod(page, selectors, texts = [], preferred = [], matchText = "", rootSelectors = []) {
    return await page.evaluate(({ selectors, texts, preferred, matchText, rootSelectors, allowedMethods }) => {
      const isVisible = (el) => !!el && el.getClientRects().length > 0;
      const isDisabled = (el) => {
        if (!el || el.disabled) return true;
        if (el.getAttribute && el.getAttribute("aria-disabled") === "true") return true;
        const cls = el.getAttribute ? (el.getAttribute("class") || "") : "";
        return String(cls).split(/\s+/).some((c) => c.includes("disabled") || c.includes("unable"));
      };
      const roots = [];
      if (rootSelectors.length > 0) {
        for (const s of rootSelectors) {
          const root = document.querySelector(s);
          if (root && isVisible(root)) roots.push(root);
        }
        if (roots.length === 0) return { called: false, noRoot: true };
      } else {
        roots.push(document);
      }
      let target = null;
      const list = [];
      for (const root of roots) {
        for (const sel of selectors) {
          for (const el of root.querySelectorAll(sel)) {
            if (!isVisible(el) || isDisabled(el)) continue;
            const txt = (el.innerText || el.textContent || "").trim();
            if (matchText && !txt.includes(matchText)) continue;
            if (texts.length > 0 && !texts.some((t) => t && txt.includes(t))) continue;
            list.push(el);
          }
        }
      }
      if (list.length === 0) return { called: false };
      target = list.sort((a, b) => ((a.innerText || a.textContent || "").trim().length - (b.innerText || b.textContent || "").trim().length))[0];
      const methodCandidates = [];
      const addMethods = (obj) => {
        if (!obj) return;
        try {
          for (const k of Object.keys(obj)) {
            const fn = obj[k];
            if (typeof fn === "function" && !methodCandidates.some((c) => c.name === k)) {
              methodCandidates.push({ name: k, fn });
            }
          }
        } catch (e) {}
      };
      let node = target;
      let vm = null;
      while (node && !vm) {
        const candidate = node.__vue__ || node.__vueParentComponent;
        if (candidate) vm = candidate;
        else node = node.parentElement || (node.parentNode && node.parentNode.nodeType === 1 ? node.parentNode : null);
      }
      if (!vm) return { called: false };
      addMethods(vm);
      addMethods(vm.$options?.methods);
      addMethods(vm.methods);
      addMethods(vm.proxy);
      addMethods(vm.ctx);
      addMethods(Object.getPrototypeOf(vm));
      for (const name of preferred) {
        if (!allowedMethods.includes(name)) continue;
        const direct = vm.proxy ? vm.proxy[name] : vm[name];
        if (typeof direct === "function") {
          try {
            direct.call(vm.proxy || vm);
            return { called: true, method: name };
          } catch (e) {
            continue;
          }
        }
        const cand = methodCandidates.find((c) => c.name === name);
        if (cand) {
          try {
            cand.fn.call(vm.proxy || vm);
            return { called: true, method: name };
          } catch (e) {}
        }
      }
      return { called: false };
    }, { selectors, texts, preferred, matchText, rootSelectors, allowedMethods: VUE_ACTION_METHODS }).catch(() => ({ called: false }));
  }

  async _openResumeSendDialog(page, options = {}) {
    const clicked = await page.evaluate((selectors, texts) => {
      const isVisible = (el) => !!el && el.getClientRects().length > 0;
      const isDisabled = (el) => {
        if (!el || el.disabled) return true;
        if (el.getAttribute && el.getAttribute("aria-disabled") === "true") return true;
        const cls = el.getAttribute ? (el.getAttribute("class") || "") : "";
        return String(cls).split(/\s+/).some((c) => c.includes("disabled") || c.includes("unable"));
      };
      const list = [];
      for (const sel of selectors) {
        for (const el of document.querySelectorAll(sel)) {
          if (!isVisible(el) || isDisabled(el)) continue;
          const txt = (el.textContent || "").trim();
          if (texts.some((t) => txt.includes(t))) list.push(el);
        }
      }
      if (list.length === 0) return false;
      const target = list.sort((a, b) => (a.textContent || "").trim().length - (b.textContent || "").trim().length)[0];
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      target.click();
      return true;
    }, RESUME_SEND_BUTTON_SELECTORS, RESUME_SEND_BUTTON_TEXTS).catch(() => false);
    if (!clicked) {
      log("[resume] 未找到“发简历”入口");
      return false;
    }
    if (await this._waitForResumeDialog(page, 5000)) {
      if (!this._isResumeCurrent(options)) return false;
      log("[resume] 已通过“发简历”入口打开选择简历弹窗");
      return true;
    }
    if (await this._waitForResumeDialog(page, 1500)) {
      if (!this._isResumeCurrent(options)) return false;
      return true;
    }
    const vue = await this._invokeVueMethod(page, RESUME_SEND_BUTTON_SELECTORS, RESUME_SEND_BUTTON_TEXTS, ["handleClick"]);
    if (vue.called) log(`[resume] Vue 兜底打开发简历弹窗: ${vue.method}`);
    if (!vue.called) {
      log("[resume] 发简历入口未找到可用的 Vue 方法，放弃打开弹窗");
      return false;
    }
    const opened = await this._waitForResumeDialog(page, 6000);
    if (!opened) log("[resume] 发简历入口点击后未出现选择简历弹窗");
    if (!this._isResumeCurrent(options)) return false;
    return opened;
  }

  async _selectResumeFromDialog(page, resume, fileName, options = {}) {
    const matchNames = [resume?.name, fileName, "周礼洋简历.pdf"].map((n) => String(n || "").trim()).filter(Boolean);
    const chosen = await page.evaluate((dialogSels, itemSelector, names) => {
      const isVisible = (el) => !!el && el.getClientRects().length > 0;
      const isPdf = (el) => {
        const text = (el.innerText || el.textContent || "").trim();
        const cls = String((el.className && el.className.baseVal) || el.className || el.getAttribute?.("class") || "");
        return /\.pdf|icon-pdf/i.test(`${text} ${cls}`);
      };
      const dialog = dialogSels.map((s) => document.querySelector(s)).find((el) => el && isVisible(el));
      if (!dialog) return { found: false, noDialog: true };
      const items = Array.from(dialog.querySelectorAll(itemSelector)).filter(isVisible);
      if (items.length === 0) return { found: false, noPdf: true };
      const target =
        items.find((item) => {
          const txt = (item.innerText || item.textContent || "").trim();
          return names.some((n) => n && txt.includes(n)) && isPdf(item);
        }) ||
        items.find(isPdf) ||
        null;
      if (!target) return { found: false, noPdf: true };
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      target.click();
      return { found: true, text: (target.innerText || target.textContent || "").trim().slice(0, 80) };
    }, RESUME_CHOOSE_DIALOG_SELECTORS, RESUME_ITEM_SELECTOR, matchNames).catch(() => ({ found: false }));
    if (!chosen.found) {
      log(chosen.noDialog ? "[resume] 选择简历弹窗已关闭，无法选择 PDF" : "[resume] 选择简历弹窗中没有可选的 PDF 简历");
      return { ok: false, reason: chosen.noDialog ? "no_dialog" : "no_pdf" };
    }
    if (!this._isResumeCurrent(options)) return { ok: false, reason: "stopped" };
    if (await this._waitForResumeConfirmEnabled(page, 4000)) {
      if (!this._isResumeCurrent(options)) return { ok: false, reason: "stopped" };
      return { ok: true };
    }
    if (await this._waitForResumeConfirmEnabled(page, 1200)) {
      if (!this._isResumeCurrent(options)) return { ok: false, reason: "stopped" };
      return { ok: true };
    }
    const vue = await this._invokeVueMethod(page, [RESUME_ITEM_SELECTOR], [], ["handleClick"], chosen.text, RESUME_CHOOSE_DIALOG_SELECTORS);
    if (vue.called) log(`[resume] Vue 兜底选择简历: ${vue.method}`);
    if (!vue.called) {
      log("[resume] 简历项未找到可用的 Vue 方法");
      return { ok: false, reason: "resume_select_failed" };
    }
    if (await this._waitForResumeConfirmEnabled(page, 4000)) {
      if (!this._isResumeCurrent(options)) return { ok: false, reason: "stopped" };
      return { ok: true };
    }
    log(`[resume] 已点击简历项但确认按钮未变为可用: ${chosen.text}`);
    return { ok: false, reason: "resume_select_failed" };
  }

  async _waitForResumeSent(page, fileName, timeoutMs = 10000, altNames = [], options = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this._isResumeCurrent(options)) return false;
      if (await this._resumeSentMarker(page, fileName, { allowResidualInput: true, ...options }, altNames)) return true;
      await randSleep(700, 1200);
    }
    return false;
  }

  async _waitForResumeDialogSendDone(page, fileName, altNames = [], timeoutMs = 12000, options = {}) {
    const deadline = Date.now() + timeoutMs;
    let sendInEffect = false;
    let dialogOpen = true;
    if (!this._isResumeCurrent(options)) {
      return { ok: false, reason: "stopped", sendInEffect, dialogOpen };
    }
    while (true) {
      if (await this._resumeSentMarker(page, fileName, { allowResidualInput: true, ignoreConfirmVisible: true }, altNames)) {
        return { ok: true, reason: "sent", sendInEffect, dialogOpen };
      }
      sendInEffect = sendInEffect || await this._resumeSendInEffect(page);
      dialogOpen = await this._waitForResumeDialog(page, 0);
      if (!this._isResumeCurrent(options)) {
        return { ok: false, reason: "stopped", sendInEffect, dialogOpen };
      }
      if (Date.now() >= deadline) {
        return {
          ok: false,
          reason: sendInEffect ? "send_in_effect_unverified" : "unverified",
          sendInEffect,
          dialogOpen,
        };
      }
      await randSleep(1000, 1500);
    }
  }

  async _confirmResumeDialog(page, fileName, altNames = [], options = {}) {
    if (!this._isResumeCurrent(options)) {
      log("[resume] 确认发送前检测到任务已停止");
      return false;
    }
    const clicked = await page.evaluate((dialogSels, confirmSels, confirmText) => {
      const isVisible = (el) => !!el && el.getClientRects().length > 0;
      const isDisabled = (el) => {
        if (!el || el.disabled) return true;
        if (el.getAttribute && el.getAttribute("aria-disabled") === "true") return true;
        const cls = el.getAttribute ? (el.getAttribute("class") || "") : "";
        return String(cls).split(/\s+/).some((c) => c.includes("disabled") || c.includes("unable"));
      };
      for (const s of dialogSels) {
        const root = document.querySelector(s);
        if (!root || !isVisible(root)) continue;
        for (const cs of confirmSels) {
          for (const el of root.querySelectorAll(cs)) {
            if (isVisible(el) && !isDisabled(el) && (el.textContent || "").includes(confirmText)) {
              el.click();
              return true;
            }
          }
        }
      }
      return false;
    }, RESUME_CHOOSE_DIALOG_SELECTORS, RESUME_CONFIRM_SELECTORS, RESUME_CONFIRM_TEXT).catch(() => false);
    if (!clicked) {
      const alreadySent = await this._resumeSentMarker(page, fileName, { allowResidualInput: true, ignoreConfirmVisible: true }, altNames);
      if (alreadySent) {
        log("[resume] 未点击发送，但已存在强成功证据");
        return true;
      }
      log("[resume] 弹窗内未找到可用的“发送”按钮，且没有强成功证据");
      return false;
    }
    log("[resume] 已点击选择简历弹窗“发送”按钮");
    const waitResult = await this._waitForResumeDialogSendDone(page, fileName, altNames, 12000, options);
    if (waitResult.ok) return true;
    if (waitResult.reason === "stopped" || !this._isResumeCurrent(options)) {
      log("[resume] 等待强证据期间任务已停止");
      return false;
    }
    const sentBeforeVue = await this._resumeSentMarker(page, fileName, { allowResidualInput: true, ignoreConfirmVisible: true }, altNames);
    if (sentBeforeVue) return true;
    if (!this._isResumeCurrent(options)) {
      log("[resume] Vue 兜底前检测到任务已停止");
      return false;
    }
    const sendInEffect = waitResult.sendInEffect || await this._resumeSendInEffect(page);
    const dialogOpenBeforeVue = await this._waitForResumeDialog(page, 0);
    if (!this._isResumeCurrent(options)) {
      log("[resume] 评估 Vue 兜底时检测到任务已停止");
      return false;
    }
    if (!shouldUseResumeVueFallback({ sent: sentBeforeVue, dialogOpen: dialogOpenBeforeVue, sendInEffect })) {
      if (sendInEffect) {
        log("[resume] 发送请求已生效，继续等待强证据，不执行 Vue 兜底");
        const waitInEffect = await this._waitForResumeSent(page, fileName, 10000, altNames, { ignoreConfirmVisible: true, ...options });
        return this._isResumeCurrent(options) ? waitInEffect : false;
      }
      log("[resume] 未检测到强成功证据，返回未确认");
      return false;
    }
    if (!this._isResumeCurrent(options)) {
      log("[resume] Vue 兜底调用前检测到任务已停止");
      return false;
    }
    const vue = await this._invokeVueMethod(page, RESUME_CONFIRM_SELECTORS, [RESUME_CONFIRM_TEXT], ["confirmSend", "handleConfirm", "send", "confirm", "submit", "handleSend", "handleSubmit", "handleClick"], "", RESUME_CHOOSE_DIALOG_SELECTORS);
    if (vue.called) log(`[resume] Vue 兜底确认发送简历: ${vue.method}`);
    if (!vue.called) {
      log("[resume] 弹窗发送按钮未找到可用的 Vue 方法");
      return false;
    }
    const sentAfterVue = await this._waitForResumeSent(page, fileName, 10000, altNames, { ignoreConfirmVisible: true, ...options });
    if (!sentAfterVue) log("[resume] Vue 兜底发送后仍未出现强成功证据，不再重复调用");
    if (!this._isResumeCurrent(options)) return false;
    return sentAfterVue;
  }

  async _sendResumeViaDialog(page, resume, fileName, options = {}) {
    const altNames = [resume?.name, "周礼洋简历.pdf"].map((n) => String(n || "").trim()).filter(Boolean);
    log("[resume] 尝试 BOSS 选择简历弹窗流程");
    if (!(await this._openResumeSendDialog(page, options))) {
      if (!this._isResumeCurrent(options)) return this._stoppedResumeResult(fileName);
      return { ok: false, reason: "no_dialog", fileName };
    }
    if (!this._isResumeCurrent(options)) return this._stoppedResumeResult(fileName);
    const selected = await this._selectResumeFromDialog(page, resume, fileName, options);
    if (!selected.ok) {
      if (selected.reason === "stopped" || !this._isResumeCurrent(options)) return this._stoppedResumeResult(fileName);
      return { ok: false, reason: selected.reason || "resume_select_failed", fileName };
    }
    if (!this._isResumeCurrent(options)) return this._stoppedResumeResult(fileName);
    if (!(await this._confirmResumeDialog(page, fileName, altNames, options))) {
      if (!this._isResumeCurrent(options)) return this._stoppedResumeResult(fileName);
      return { ok: false, reason: "resume_confirm_failed", fileName };
    }
    if (!this._isResumeCurrent(options)) return this._stoppedResumeResult(fileName);
    log(`[resume] 选择简历弹窗发送成功: ${fileName}`);
    return { ok: true, fileName, reason: "sent" };
  }

  async _sendResume(page, resume, options = {}) {
    const effectiveOptions = options.generation == null && options.allowIdle !== true
      ? { ...options, requireRunning: true }
      : options;
    const fileName = resume?.filePath ? path.basename(resume.filePath) : "";
    if (!this._isResumeCurrent(effectiveOptions, true)) {
      return this._stoppedResumeResult(fileName);
    }
    if (!resume || !resume.filePath || !fs.existsSync(resume.filePath)) {
      log("[resume] 没有可发送的简历文件，跳过附件");
      return { ok: false, reason: "no_file" };
    }
    const altNames = [resume.name, "周礼洋简历.pdf"].map((n) => String(n || "").trim()).filter(Boolean);
    log("[resume] 开始发送附件简历: " + fileName);

    // 已发送预检：只认真实简历/附件强特征；竞争者PK/共人投递/查看详细分析不是附件已发送证据。
    // 不允许“聊天区出现文件名”单独成立——待发送文件 chip/历史同名文件会造成假阳性。
    const alreadySent = await this._resumeSentMarker(page, fileName, { allowResidualInput: true }, altNames);
    let selectedResumeSent = false;
    if (!alreadySent) {
      selectedResumeSent = await this._selectedResumeSent(page, fileName, altNames);
    }
    if (!this._isResumeCurrent(effectiveOptions, true)) {
      return this._stoppedResumeResult(fileName);
    }
    if (alreadySent || selectedResumeSent) {
      log(`[resume] 预检发现简历已发送，跳过重复上传: ${fileName}`);
      return { ok: true, reason: "already_sent", fileName };
    }

    const unavailable = await this._isResumeSendUnavailable(page);
    if (!this._isResumeCurrent(effectiveOptions, true)) {
      return this._stoppedResumeResult(fileName);
    }
    if (unavailable) {
      if (selectedResumeSent || await this._selectedResumeSent(page, fileName, altNames)) {
        log(`[resume] 发简历入口不可用但当前选中会话最后一条为简历文件，视为已发送: ${fileName}`);
        return { ok: true, reason: "already_sent", fileName };
      }
      log(`[resume] 发简历入口不可用（双方回复后可用），跳过附件上传: ${fileName}`);
      return { ok: false, reason: "resume_unavailable", fileName };
    }

    if (await this._isOnChatPage(page)) {
      if (!this._isResumeCurrent(effectiveOptions, true)) return this._stoppedResumeResult(fileName);
      const dialogResult = await this._sendResumeViaDialog(page, resume, fileName, effectiveOptions);
      if (!this._isResumeCurrent(effectiveOptions, true) || dialogResult?.reason === "stopped") {
        return this._stoppedResumeResult(fileName);
      }
      return dialogResult;
    }

    // 优先在所有 input[type=file] 中找 accept 含 pdf/doc/msword/document 的简历输入框。
    // 真实聊天页第一个可见文件输入框是图片（accept 只含 image），不能用 page.$ 取第一个。
    const fileInputs = await page.$$("input[type=file]").catch(() => []);
    let resumeInput = null;
    for (const el of fileInputs) {
      const accept = await el.evaluate((n) => (n.getAttribute("accept") || "") || "").catch(() => "");
      if (isResumeFileAccept(accept)) { resumeInput = el; break; }
    }

    let selected = false;
    if (resumeInput) {
      if (!this._isResumeCurrent(effectiveOptions, true)) {
        return this._stoppedResumeResult(fileName);
      }
      try {
        await resumeInput.uploadFile(resume.filePath);
        selected = true;
        log("[resume] 已通过简历文件输入框选择文件");
      } catch (e) {
        log("[resume] 简历文件输入框上传失败: " + (e.message || "").slice(0, 60));
      }
      if (!this._isResumeCurrent(effectiveOptions, true)) {
        return this._stoppedResumeResult(fileName);
      }
    }

    if (!selected) {
      // 找不到简历输入框：仅在聊天页才可点击聊天工具栏“发简历”并等待 file chooser；
      // 绝不在职位页点击任意含“简历/附件”的控件（会误入“完善在线简历/新增附件简历”）。
      if (await this._isOnChatPage(page)) {
        if (!this._isResumeCurrent(effectiveOptions, true)) {
          return this._stoppedResumeResult(fileName);
        }
        const chooserPromise = page.waitForFileChooser({ timeout: 5000 }).then((c) => c).catch(() => null);
        const clicked = await this._clickTextControl(page, RESUME_SEND_TEXTS, { match: "includes" });
        const chooser = await chooserPromise;
        if (chooser) {
          if (!this._isResumeCurrent(effectiveOptions, true)) {
            return this._stoppedResumeResult(fileName);
          }
          await chooser.accept([resume.filePath]);
          selected = true;
          log("[resume] 已通过文件选择器选择简历");
          if (!this._isResumeCurrent(effectiveOptions, true)) {
            return this._stoppedResumeResult(fileName);
          }
        } else {
          if (!this._isResumeCurrent(effectiveOptions, true)) {
            return this._stoppedResumeResult(fileName);
          }
          log(`[resume] 聊天页未找到发简历入口，跳过附件: ${fileName}`);
          return { ok: false, reason: "no_resume_input", fileName };
        }
      } else {
        if (!this._isResumeCurrent(effectiveOptions, true)) {
          return this._stoppedResumeResult(fileName);
        }
        log(`[resume] 未找到简历文件输入框且不在聊天页，跳过附件: ${fileName}`);
        return { ok: false, reason: "no_resume_input", fileName };
      }
    }

    await this._humanWait(1.5, 3);
    if (!this._isResumeCurrent(effectiveOptions, true)) {
      return this._stoppedResumeResult(fileName);
    }
    const confirmResult = await this._confirmResumeUpload(page, fileName, effectiveOptions);
    if (confirmResult.stopped || !this._isResumeCurrent(effectiveOptions, true)) {
      return this._stoppedResumeResult(fileName);
    }
    if (confirmResult.sent) {
      const sent = await this._resumeSentMarker(page, fileName, { allowResidualInput: true }, altNames);
      if (!this._isResumeCurrent(effectiveOptions, true)) {
        return this._stoppedResumeResult(fileName);
      }
      log(`[resume] 附件已自动发送，跳过普通发送: ${fileName} ${sent ? "确认" : "未确认"}`);
      return { ok: sent, fileName, reason: sent ? "auto_sent" : "unverified" };
    }
    if (confirmResult.seen) {
      if (!confirmResult.closed) {
        if (!this._isResumeCurrent(effectiveOptions, true)) {
          return this._stoppedResumeResult(fileName);
        }
        log(`[resume] 上传附件确认弹窗超时，跳过普通发送: ${fileName}`);
        return { ok: false, reason: "upload_confirm_timeout", fileName };
      }
      log(`[resume] 上传附件确认弹窗已处理: ${fileName}`);
      await this._humanWait(2, 4);
      if (!this._isResumeCurrent(effectiveOptions, true)) {
        return this._stoppedResumeResult(fileName);
      }
      const allowFileName = !!confirmResult.clicked;
      const allowResidualInput = confirmResult.seen || !!confirmResult.sent;
      let sent = await this._resumeSentMarker(page, fileName, { allowFileName, allowResidualInput }, altNames);
      if (!sent) {
        await randSleep(2, 4);
        if (!this._isResumeCurrent(effectiveOptions, true)) {
          return this._stoppedResumeResult(fileName);
        }
        sent = await this._resumeSentMarker(page, fileName, { allowFileName, allowResidualInput }, altNames);
      }
      log(`[resume] 附件发送复核: ${sent ? "已发送" : "未确认"} (${fileName})`);
      return { ok: sent, fileName, reason: sent ? "sent" : "unverified" };
    }
    if (!confirmResult.fallback) {
      if (!this._isResumeCurrent(effectiveOptions, true)) {
        return this._stoppedResumeResult(fileName);
      }
      log(`[resume] 附件上传状态未完成，跳过普通发送: ${fileName}`);
      return { ok: false, fileName, reason: confirmResult.reason || "pending" };
    }
    // 上传是异步的：发送按钮不可用（class disabled / aria-disabled / property disabled）时
    // 不硬点，轮询等待按钮可用后再点；始终不可用则跳过点击，靠下方异步复查判定。
    let sendButtonClicked = false;
    for (let attempt = 0; attempt < 3 && !sendButtonClicked; attempt++) {
      if (!this._isResumeCurrent(effectiveOptions, true)) {
        return this._stoppedResumeResult(fileName);
      }
      if (await this._hasVisibleSend(page)) {
        if (!this._isResumeCurrent(effectiveOptions, true)) {
          return this._stoppedResumeResult(fileName);
        }
        sendButtonClicked = await this._clickSendButton(page);
        if (!this._isResumeCurrent(effectiveOptions, true)) {
          return this._stoppedResumeResult(fileName);
        }
      }
      if (!sendButtonClicked) {
        if (!this._isResumeCurrent(effectiveOptions, true)) {
          return this._stoppedResumeResult(fileName);
        }
        await randSleep(1.5, 2.5);
      }
    }
    await this._humanWait(1.5, 3);
    if (!this._isResumeCurrent(effectiveOptions, true)) {
      return this._stoppedResumeResult(fileName);
    }

    // 点击发送按钮后增加一轮短延时复查：上传/发送是异步过程，首轮判定未确认时
    // 再复查一轮再定论，避免待发送 chip 尚未消失、强特征尚未出现导致误判未发送。
    let sent = await this._resumeSentMarker(page, fileName, { allowFileName: sendButtonClicked, allowResidualInput: sendButtonClicked }, altNames);
    if (!sent) {
      await randSleep(2, 4);
      if (!this._isResumeCurrent(effectiveOptions, true)) {
        return this._stoppedResumeResult(fileName);
      }
      sent = await this._resumeSentMarker(page, fileName, { allowFileName: sendButtonClicked, allowResidualInput: sendButtonClicked }, altNames);
    }
    log(`[resume] 附件发送复核: ${sent ? "已发送" : "未确认"} (${fileName})`);
    if (!this._isResumeCurrent(effectiveOptions, true)) {
      return this._stoppedResumeResult(fileName);
    }
    return { ok: sent, fileName, reason: sent ? "sent" : "unverified" };
  }

  async _countOwnImageMessages(page) {
    return await page.evaluate(() => {
      const record = document.querySelector(".chat-record");
      if (!record) return 0;
      let count = 0;
      for (const item of record.querySelectorAll("li.message-item.item-myself")) {
        const content = item.querySelector(".message-content");
        if (!content) continue;
        if (content.querySelector("img")) {
          count++;
          continue;
        }
        const hasImageClass = Array.from(content.querySelectorAll("[class]")).some((el) => {
          const cls = String(el.className || el.getAttribute("class") || "").toLowerCase();
          return cls.includes("image") || cls.includes("img") || cls.includes("picture");
        });
        if (hasImageClass) count++;
      }
      return count;
    }).catch(() => 0);
  }

  async _sendResumeScreenshot(page, resume, options = {}) {
    const effectiveOptions = options.generation == null && options.allowIdle !== true
      ? { ...options, requireRunning: true }
      : options;
    let fileName = resume?.filePath ? path.basename(resume.filePath) : "";
    if (!this._isResumeCurrent(effectiveOptions, true)) {
      return this._stoppedResumeResult(fileName);
    }

    let screenshotPath;
    try {
      screenshotPath = await ensureResumeScreenshot(resume);
      fileName = path.basename(screenshotPath);
    } catch (e) {
      log(`[resume-screenshot] 简历截图生成失败: ${(e?.message || "").slice(0, 80)}`);
      return { ok: false, reason: "screenshot_failed", fileName };
    }
    if (!this._isResumeCurrent(effectiveOptions, true)) {
      return this._stoppedResumeResult(fileName);
    }

    let screenshotBase64;
    try {
      screenshotBase64 = fs.readFileSync(screenshotPath).toString("base64");
    } catch (e) {
      log(`[resume-screenshot] 读取简历截图失败: ${(e?.message || "").slice(0, 80)}`);
      return { ok: false, reason: "upload_failed", fileName };
    }
    if (!this._isResumeCurrent(effectiveOptions, true)) {
      return this._stoppedResumeResult(fileName);
    }

    const beforeCount = await this._countOwnImageMessages(page);
    log(`[resume-screenshot] 开始上传简历截图: ${fileName}，发送前图片消息数=${beforeCount}`);
    const uploadResult = await page.evaluate(async ({ base64, fileName }) => {
      const imageBtnEl = document.querySelector('[aria-label="发送图片"], [aria-label="图片"], [class*="icon-image"], [class*="image-btn"], [class*="img-btn"], button[title*="图片"], [class*="toolbar"] [class*="image"], [class*="chat"] [class*="image"]');
      if (!imageBtnEl) return { reason: "no_image_input" };

      let component = null;
      let sendMethod = null;
      const methodNames = ["sendImageMsg", "sendImage", "sendPicture", "sendImg", "uploadImage"];
      for (let node = imageBtnEl; node && node !== document.documentElement; node = node.parentElement) {
        let vm = node.__vue__ || node.__vueParentComponent;
        while (vm) {
          const target = vm.proxy || vm;
          const found = methodNames.find((name) => typeof target[name] === "function");
          if (found) {
            component = target;
            sendMethod = found;
            break;
          }
          vm = vm.$parent || vm.parent || null;
        }
        if (component) break;
      }
      if (!component || !sendMethod) return { reason: "image_send_method_missing" };

      const conversation = component.conversation$ ||
        component.$data?.conversation$ ||
        component.$props?.conversation$ ||
        null;
      const gid = conversation?.gid;
      const securityId = conversation?.securityId;
      if (!gid && !securityId) return { reason: "upload_failed" };

      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const formData = new FormData();
      if (gid) {
        formData.append("gid", gid);
        formData.append("source", "chat");
      } else {
        formData.append("securityId", securityId);
        formData.append("source", "chat_file");
      }
      formData.append("file", new File([bytes], fileName, { type: "image/png" }));

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch("/wapi/zpupload/image/uploadSingle", {
          method: "POST",
          credentials: "include",
          body: formData,
          signal: controller.signal,
        });
        if (!response.ok) return { reason: "upload_failed" };
        const json = await response.json();
        if (json?.code !== 0 || !json?.zpData?.url || !json?.zpData?.tinyUrl) {
          return { reason: "upload_failed" };
        }
        try {
          const sent = component[sendMethod]({ url: json.zpData.url, tinyUrl: json.zpData.tinyUrl });
          if (sent && typeof sent.catch === "function") await sent;
        } catch (e) {
          return { reason: "upload_failed" };
        }
        return { reason: "sent" };
      } catch (e) {
        return { reason: "upload_failed" };
      } finally {
        clearTimeout(timer);
      }
    }, { base64: screenshotBase64, fileName }).catch(() => ({ reason: "upload_failed" }));

    if (!this._isResumeCurrent(effectiveOptions, true)) {
      return this._stoppedResumeResult(fileName);
    }
    if (uploadResult.reason === "no_image_input") {
      log("[resume-screenshot] 未找到发送图片控件");
      return { ok: false, reason: "no_image_input", fileName };
    }
    if (uploadResult.reason === "image_send_method_missing") {
      log("[resume-screenshot] 未找到 ImageBtn sendImageMsg 方法");
      return { ok: false, reason: "image_send_method_missing", fileName };
    }
    if (uploadResult.reason !== "sent") {
      log(`[resume-screenshot] 图片上传失败: ${uploadResult.reason || "upload_failed"} ${uploadResult.message || ""}`);
      return { ok: false, reason: "upload_failed", fileName };
    }

    log("[resume-screenshot] 图片上传成功，等待聊天图片消息确认");
    let afterCount = await this._countOwnImageMessages(page);
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && afterCount <= beforeCount) {
      if (!this._isResumeCurrent(effectiveOptions, true)) {
        return this._stoppedResumeResult(fileName);
      }
      await sleep(500);
      afterCount = await this._countOwnImageMessages(page);
    }
    if (!this._isResumeCurrent(effectiveOptions, true)) {
      return this._stoppedResumeResult(fileName);
    }
    if (afterCount > beforeCount) {
      log(`[resume-screenshot] 图片消息已确认: ${fileName} (${beforeCount} -> ${afterCount})`);
      return { ok: true, reason: "sent", fileName };
    }
    if (!this._isResumeCurrent(effectiveOptions, true)) {
      return this._stoppedResumeResult(fileName);
    }
    log(`[resume-screenshot] 图片消息发送未确认: ${fileName} (${beforeCount} -> ${afterCount})`);
    return { ok: false, reason: "unverified", fileName };
  }

  async _sendPreferredResume(page, resume, options = {}) {
    if (options.sendResumeScreenshot === false) {
      return await this._sendResume(page, resume, options);
    }
    const result = await this._sendResumeScreenshot(page, resume, options);
    const fallbackReasons = ["no_image_input", "screenshot_failed", "upload_failed", "image_send_method_missing"];
    if (!result?.ok && fallbackReasons.includes(result?.reason) && options.sendResume !== false) {
      log(`[resume] 截图发送不可用(${result.reason})，回退发送附件简历: ${resume?.filePath || ""}`);
      return await this._sendResume(page, resume, options);
    }
    return result;
  }

  async _collectCurrentChatIdentity(page) {
    return await page.evaluate(() => {
      const conversation = document.querySelector(".chat-conversation");
      if (!conversation || !conversation.getClientRects || conversation.getClientRects().length === 0) return null;
      const name = (conversation.querySelector(".name-text")?.textContent || "").trim();
      const company = (conversation.querySelector(".user-info")?.textContent || "").trim();
      const jobTitle = (conversation.querySelector(".position-name")?.textContent || "").trim();
      if (!name && !company) return null;
      return { name, company, jobTitle };
    }).catch(() => null);
  }

  async _sendResumeForChat(chat, resume, options = {}) {
    const runOptions = options.generation == null ? { ...options, allowIdle: true } : options;
    const useScreenshot = options.sendResumeScreenshot !== false;
    const fileName = resume?.filePath ? path.basename(resume.filePath) : "";
    const isCurrent = () => this._isResumeCurrent(runOptions);
    let effectiveChat = chat;
    const finish = (result) => this._finishResumeForChat(effectiveChat, result, runOptions);
    if (!isCurrent()) return finish(this._stoppedResumeResult(fileName));
    const page = await this._getPage();
    await this._navigateToChat();
    if (!isCurrent()) return finish(this._stoppedResumeResult(fileName));
    const hadChatIdentity = [chat?.name, chat?.company, chat?.href, chat?.rowId]
      .some((value) => String(value || "").trim());
    if (!hadChatIdentity) {
      const currentIdentity = await this._collectCurrentChatIdentity(page);
      if (currentIdentity) {
        effectiveChat = { ...chat, ...currentIdentity };
        log(`[resume] 已从当前会话读取身份: ${currentIdentity.name || ""} ${currentIdentity.company || ""} ${currentIdentity.jobTitle || ""}`);
      }
    }
    if (hadChatIdentity && !(await this._selectChatRow(page, effectiveChat))) {
      log(`[resume] 未选中会话，跳过附件: ${effectiveChat?.name || effectiveChat?.company || "未知会话"}`);
      return finish({ ok: false, reason: "chat_not_found", fileName });
    }

    const attempt = async () => {
      if (!isCurrent()) return this._stoppedResumeResult(fileName);
      return await this._sendPreferredResume(page, resume, {
        ...runOptions,
        sendResumeScreenshot: useScreenshot,
      });
    };

    let result = await attempt();
    const retryReasons = useScreenshot
      ? ["no_image_input", "screenshot_failed", "upload_failed", "image_send_method_missing", "resume_unavailable", "no_dialog"]
      : ["resume_unavailable", "no_dialog"];
    if (retryReasons.includes(result?.reason) && !runOptions.noRetry) {
      log(`[resume] ${result.reason}，等待后重试发送: ${resume?.filePath || ""}`);
      await randSleep(Number(runOptions.retryDelayMin ?? 2500), Number(runOptions.retryDelayMax ?? 4000));
      if (!isCurrent()) return finish(this._stoppedResumeResult(fileName));
      result = await attempt();
    }
    return finish(result);
  }

  async _selectChatRow(page, chat) {
    const found = await page.evaluate((chat, selectors) => {
      const name = String(chat?.name || "");
      const company = String(chat?.company || "");
      const msg = String(chat?.msg || "");
      const rowId = String(chat?.rowId || "");
      const href = String(chat?.href || "");
      const candidates = [];
      for (const s of selectors) {
        for (const el of document.querySelectorAll(s)) {
          if (candidates.indexOf(el) >= 0) continue;
          const className = String(el.className || el.getAttribute?.("class") || "");
          const isSessionContainer = ["conversation-list", "conversation-container", "conversation-list-content", "chat-container", "chat-list", "user-list"]
            .some((token) => className.includes(token)) && !className.includes("item");
          if (isSessionContainer) continue;
          if (className.includes("chat-conversation") || (el.closest && el.closest(".chat-conversation"))) continue;
          candidates.push(el);
        }
      }
      const clickRow = (el) => {
        const inner = Array.from(el.querySelectorAll(".friend-content, [d-c='62001']") || [])
          .find((node) => node.offsetParent && node.getClientRects().length > 0);
        if (inner) {
          inner.click();
        } else {
          el.click();
        }
      };
      for (const el of candidates) {
        if (!el.offsetParent || el.getClientRects().length === 0) continue;
        const txt = (el.innerText || "");
        const attrs = [el.getAttribute("data-id"), el.getAttribute("data-sessionid"), el.getAttribute("data-conversation-id")];
        const link = el.querySelector("a[href]");
        const elHref = link ? (link.getAttribute("href") || "") : "";
        if (rowId && attrs.indexOf(rowId) >= 0) {
          clickRow(el);
          return true;
        }
        if (href && elHref && (elHref.includes(href) || href.includes(elHref))) {
          clickRow(el);
          return true;
        }
        if (name && company && msg && txt.includes(name) && txt.includes(company) && txt.includes(msg)) {
          clickRow(el);
          return true;
        }
        if (name && msg && txt.includes(name) && txt.includes(msg)) {
          clickRow(el);
          return true;
        }
        if (name && txt.includes(name)) {
          clickRow(el);
          return true;
        }
        if (company && txt.includes(company)) {
          clickRow(el);
          return true;
        }
        if (msg && txt.includes(msg)) {
          clickRow(el);
          return true;
        }
      }
      return false;
    }, chat || null, CHAT_SESSION_SELECTORS).catch(() => false);
    if (found) await randSleep(800, 1600);
    return found;
  }

  async autoApply(jobs, options = {}) {
    const page = await this._getPage();
    let applied = 0;
    let failed = 0;
    let skipped = 0;
    const results = [];
    const total = (jobs || []).length;
    const useScreenshot = options.sendResumeScreenshot !== false;
    const resumeNoteFor = (result) => {
      if (useScreenshot) {
        return result?.ok
          ? "简历截图-已发送"
          : result?.reason === "screenshot_failed"
            ? "简历截图-生成失败"
            : result?.reason === "no_image_input"
              ? "简历截图-未找到发送入口"
              : result?.reason === "resume_unavailable"
                ? "简历截图-待HR回复后发"
                : "简历截图-未确认";
      }
      return result?.ok
        ? "简历-已发送"
        : result?.reason === "no_dialog"
          ? "简历-未发送"
          : result?.reason === "resume_unavailable"
            ? "简历-待HR回复后发"
            : "简历-未确认";
    };
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
        let detailState = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          detailState = await this._collectJobDetailState(page);
          if (isJobDetailReady(detailState)) break;
          if (attempt === 0) {
            log(`[${i + 1}/${total}] 未进入职位详情页，重新打开职位页: ${title}`);
            await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
            await this._humanWait(2.5, 5);
            try { await page.waitForSelector("body", { timeout: 8000 }); } catch (e) {}
          }
        }
        if (!detailState || !isJobDetailReady(detailState)) {
          failed++;
          results.push({ job: title, status: "page_not_ready", reason: "页面未进入职位详情" });
          log(`[${i + 1}/${total}] 页面未进入职位详情，跳过，避免误点城市首页: ${title}`);
          try { await page.screenshot({ path: path.join(DATA_ROOT, "data", "last_fail.png"), fullPage: false }).catch(() => {}); } catch (e) {}
          if (this.running && i < total - 1) await this._humanWait(delayMin, delayMax);
          continue;
        }

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

        this._progress(options, i + 1, total, title, "定位投递/沟通按钮");
        let clicked = false;
        let resumeOpenedBySubmit = false;
        // 新沟通优先 data-url API，成功后再 goto redirect-url；无 data-url 才直接 goto；
        // 返回 "skip" 表示已沟通过跳过，true 表示已进入聊天流程，CHAT_NOT_READY 则失败跳过。
        const startResult = await this._startChatWithJob(page);
        if (resolveChatStartState(startResult).action === "skip_job") {
          failed++;
          results.push({ job: title, status: "chat_not_ready", reason: "聊天页未就绪" });
          log(`[${i + 1}/${total}] 聊天页未就绪，跳过职位页兜底: ${title}`);
          try { await page.screenshot({ path: path.join(DATA_ROOT, "data", "last_fail.png"), fullPage: false }).catch(() => {}); } catch (e) {}
          if (this.running && i < total - 1) await this._humanWait(delayMin, delayMax);
          continue;
        }
        if (startResult === "skip") {
          clicked = "skip";
        } else if (startResult === true) {
          clicked = true;
          log(`[${i + 1}/${total}] 已通过 startchat 流程打开会话: ${title}`);
        } else {
          // 当前 _startChatWithJob 不可用时返回 CHAT_NOT_READY，不会进入此分支。
          // 保留该兜底仅用于兼容旧返回 false 的调用方。
          if (options.sendResume !== false) {
            resumeOpenedBySubmit = await this._clickResumeSubmitButton(page);
            if (resumeOpenedBySubmit) {
              clicked = true;
              log(`[${i + 1}/${total}] 已通过投递简历按钮打开会话: ${title}`);
            }
          }
          if (!clicked) {
            clicked = await this._clickFirst(page, START_CHAT_SELECTORS, {
              skipTexts: ["继续沟通", "查看聊天"],
              onLocate: () => this._progress(options, i + 1, total, title, "移动鼠标点击沟通"),
            });
            if (clicked !== "skip" && clicked !== true) {
              const fallback = await this._clickTextControl(page, START_TEXTS, { match: "includes" });
              if (fallback) clicked = true;
            }
          }
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

          const profile = options.profile || {};
          const resume = options.sendResume !== false ? this._findResumeForJob(job) : null;
          let resumeResult = { ok: false, reason: "skipped" };

          if (state1 && (state1.hasDelivered || state1.hasGreeted)) {
            if (resumeOpenedBySubmit) {
              // 投递按钮已点，不再重复发送附件；但只有页面出现简历发送强特征才算已发送
              const resumeAltNames = [resume?.name, "周礼洋简历.pdf"].map((n) => String(n || "").trim()).filter(Boolean);
              const resumeSent = await this._resumeSentMarker(page, resume?.filePath ? path.basename(resume.filePath) : "", { allowFileName: false, allowResidualInput: true }, resumeAltNames);
              resumeResult = resumeSent
                ? { ok: true, reason: "button_submit", fileName: resume?.filePath }
                : { ok: false, reason: "button_pending", fileName: resume?.filePath };
              if (resumeSent) {
                log(`[${i + 1}/${total}] 已通过投递按钮提交简历，跳过附件重复发送: ${title}`);
              } else {
                log(`[${i + 1}/${total}] 投递按钮已点，简历待确认: ${title}`);
              }
            } else {
              resumeResult = await this._sendPreferredResume(page, resume, options);
            }
            applied++;
            const resumeNote = resumeNoteFor(resumeResult);
            const notes = ["打招呼-复核通过", resumeNote].filter(Boolean).join("; ");
            try { applicationDb.create({ jobId: job.id, resumeId: job.resumeId || null, status: "pending", notes }); } catch (e) {}
            results.push({ job: title, status: "ok", verified: true, resumeSent: !!resumeResult?.ok });
            log(`[${i + 1}/${total}] 已存在沟通状态，确认打过招呼: ${title}`);
          } else {
            const greeting = buildGreeting(job, profile, options.greeting || this.style.greeting || profile.greeting || "");
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
            if (resumeOpenedBySubmit) {
              // 投递按钮已点，不再重复发送附件；但只有页面出现简历发送强特征才算已发送
              const resumeAltNames = [resume?.name, "周礼洋简历.pdf"].map((n) => String(n || "").trim()).filter(Boolean);
              const resumeSent = await this._resumeSentMarker(page, resume?.filePath ? path.basename(resume.filePath) : "", { allowFileName: false, allowResidualInput: true }, resumeAltNames);
              resumeResult = resumeSent
                ? { ok: true, reason: "button_submit", fileName: resume?.filePath }
                : { ok: false, reason: "button_pending", fileName: resume?.filePath };
              if (resumeSent) {
                log(`[${i + 1}/${total}] 已通过投递简历按钮提交，跳过附件重复发送: ${title}`);
              } else {
                log(`[${i + 1}/${total}] 投递按钮已点，简历待确认: ${title}`);
              }
            } else {
              resumeResult = await this._sendPreferredResume(page, resume, options);
            }

            const v1 = await this._checkPageState(page);
            await this._humanWait(2, 4);
            const v2 = await this._checkPageState(page);
            const verified = this._isVerified(state1, v1) || this._isVerified(state1, v2);
            log(`[${i + 1}/${total}] 复核确认: ${verified ? "已打过招呼" : "未确认到打招呼"} (送达=${v2?.hasDelivered ? "是" : "否"}, 按钮状态=${v2?.btn || "无"}, 输入框=${v2?.inputValue ? "有内容" : "已清空"})`);

            if (verified) {
              applied++;
              const resumeNote = resumeNoteFor(resumeResult);
              const notes = ["打招呼-复核通过", resumeNote].filter(Boolean).join("; ");
              try { applicationDb.create({ jobId: job.id, resumeId: job.resumeId || null, status: "pending", notes }); } catch (e) {}
              results.push({ job: title, status: "ok", verified: true, resumeSent: !!resumeResult?.ok });
              log(`[${i + 1}/${total}] 复核通过，确认已打招呼: ${title}`);
            } else {
              failed++;
              results.push({ job: title, status: "unverified", reason: "复核未确认", resumeSent: !!resumeResult?.ok });
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
        // 致命浏览器错误（浏览器/CDP 连接断开、页面/目标关闭）：此后任何页面操作都不可能
        // 成功，继续遍历剩余职位只会全部失败空转，直接终止本轮投递。running 复位由
        // handleApply 的 finally 统一处理，这里只记录日志并返回已处理的结果。
        if (isFatalBrowserError(e)) {
          log(`[${i + 1}/${total}] 致命浏览器错误，终止投递: ${(e?.message || "").slice(0, 80)}`);
          this.running = false;
          return { applied, failed, skipped, total: applied + failed, results };
        }
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

  async monitorChat(onMsg, interval, options = {}) {
    const autoReply = options.autoReply !== false;
    const once = options.once === true;
    // 记录本轮代际：stop()/重启会使 generation 递增，旧轮 check 借此识别自己已失效
    const generation = this.generation;
    let firstScan = true;
    let scanned = 0;
    let replied = 0;
    let manual = 0;
    let resumeSent = 0;
    // 尝试回复但没送达的条数（未确认/无输入框/未就绪/异常）。replied+failed 才等于"处理过"，
    // 轮次汇总必须同时报告两者，否则"回复 N 条"又会和实际送达数脱节。
    let failed = 0;
    const check = async () => {
      // 互斥：setInterval 不等待 async check 完成，若上一轮 check 仍在本轮执行中，
      // 本次定时触发直接丢弃，避免同代两个 check 并发处理/回复同一会话。
      // 注意：stop()/restart 后旧轮若仍占着 _checking（例如正在 sendReply 中 await 页面操作），
      // 新轮的首轮 check 会被这里的互斥吞掉，要等下一 interval 才真正扫描——这是为避免新旧
      // 两轮并发驱动同一页面而接受的保守行为：宁可延迟一个 interval，也不并发。
      if (this._checking) return;
      this._checking = true;
      try {
        const data = await this._scanChatSessions(firstScan);
        firstScan = false;
        scanned = data.length;

        log(`[chat] 扫描到 ${data.length} 个会话`);
        const screenshotResumeEnabled = options.sendResumeScreenshot !== false;
        const sendResumeEnabled = options.sendResumeScreenshot !== false || options.sendResume !== false;
        let resumeAttemptsThisCheck = 0;
        const attemptResumeForChat = async (c) => {
          if (!sendResumeEnabled || resumeAttemptsThisCheck >= 2) return null;
          const app = this._findApplicationForChat(c);
          if (!app) return null;
          if (
            String(app.notes || "").includes("简历-已发送") ||
            String(app.notes || "").includes("简历截图-已发送")
          ) return null;
          if (screenshotResumeEnabled ? !chatState.shouldTryResumeScreenshot(c) : !chatState.shouldTryResume(c)) return null;
          const resume = this._findResumeForChat(c);
          resumeAttemptsThisCheck++;
          const result = await this._sendResumeForChat(c, resume, { generation, sendResumeScreenshot: screenshotResumeEnabled });
          return result;
        };
        for (const c of data) {
          // 用户点停止或新轮已启动后，旧轮立即终止，不再回复后续未读会话
          if (!this.running || generation !== this.generation) return;
          if (c.hrLast && c.unread) {
            log(`[chat] 收到 ${c.name} 的消息: ${(c.msg || "").slice(0, 30)}`);
            if (!autoReply) {
              log(`[chat] 自动回复已关闭，仅同步状态: ${c.name || c.company || "未知会话"}`);
              continue;
            }
            if (!chatState.shouldReply(c)) {
              log(`[chat] 该消息已回复过，跳过: ${c.name || c.company || "未知会话"}`);
              continue;
            }
            let replyResult = { ok: false, reason: "no_handler" };
            try {
              // 把本轮代际传给回调：sendReply 借此在 stop()/重启后识别自己已失效
              if (onMsg) replyResult = (await onMsg(c, { generation })) || replyResult;
            } catch (e) {
              log(`[chat] 自动回复异常: ${(e?.message || "").slice(0, 60)}`);
            }
            // 若 stop/重启发生在本轮 onMsg（sendReply）执行期间：旧轮不得再写回复状态或投递记录，
            // 否则新轮会与旧轮并发驱动同一页面/重复记账。
            if (!this.running || generation !== this.generation) return;
            if (replyResult?.needManual) {
              manual++;
              log(`[chat] 需要人工确认，不自动发送: ${c.name || c.company || "未知会话"} - ${replyResult.reason || "面试/Offer需人工确认"}`);
              chatState.markManualPending(c, replyResult.reason || "面试/Offer需人工确认", replyResult);
            } else if (replyResult?.ok) {
              replied++;
              chatState.markReplied(c, replyResult.reply || c.msg, replyResult);
              const apps = applicationDb.findAll();
              const app = this._findApplicationByCompany(apps, c.company || c.name);
              if (app) {
                applicationDb.updateStatus(app.id, "replied", "自动回复: " + String(replyResult.reply || c.msg).slice(0, 80));
              }
              const resumeResult = await attemptResumeForChat(c);
              if (resumeResult?.ok) resumeSent++;
            } else {
              // 尝试过但没送达（未确认/无输入框/未就绪/异常）：计 failed，不标 replied，
              // chatState 保持"未回复"，下一轮会自然重试。轮次汇总据此报告真实送达数。
              failed++;
              log(`[chat] 回复未送达，稍后重试: ${c.name || c.company || "未知会话"} - ${replyResult?.reason || "no_result"}`);
            }
          } else if (c.hrLast && !c.unread) {
            const resumeResult = await attemptResumeForChat(c);
            if (resumeResult?.ok) resumeSent++;
          }
        }
        // 用户点停止或新轮启动后不再继续执行反馈同步，直接结束本轮扫描
        if (!this.running || generation !== this.generation) return;
        await this.syncFeedback(data);
      } catch (e) {
        if (isFatalBrowserError(e)) {
          // 代际已失效（stop 后重启 / 新轮已启动）：旧轮 fatal 不得再改 running、
          // 清 timer 或调 onFatal，否则会误清新轮状态、误报 onFatal，直接退出本轮。
          if (generation !== this.generation) return;
          // 运行期浏览器断开/页面关闭等致命错误：继续扫描只会空转。语义与 stop() 一致——
          // 先递增代际，使本轮所有挂起的 check（含正在 sendReply 中 await 的）恢复后
          // 都会因代际不符而不再写回复状态；再复位 running、清掉本轮 timer，最后通知
          // 调用方复位 state，否则 b.running/state.chatActive 残留 true，后续请求全部 409。
          log(`[chat] 监控异常终止: ${(e?.message || "").slice(0, 80)}`);
          this.generation++;
          this.running = false;
          // 代际已递增，新轮建立 timer 前必先校验 running 与代际，故 this._timer 只可能是本轮遗留
          if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
          }
          if (options.onFatal) {
            try { await options.onFatal(e); } catch (err) {
              log(`[chat] onFatal 回调异常: ${(err?.message || "").slice(0, 60)}`);
            }
          }
          return;
        }
        // 普通 DOM 异常（元素未找到、渲染抖动等）仍可恢复，只记日志，不终止监控
        log(`[chat] 扫描异常: ${(e?.message || "").slice(0, 60)}`);
      } finally {
        // 无论正常结束、fatal 提前 return 还是普通异常，都释放互斥，允许下一轮定时触发
        this._checking = false;
      }
    };

    await this._getPage();
    await check();
    if (once) return { scanned, replied, failed, manual, resumeSent };
    // stop 后立即 start：旧轮可能仍在本轮首轮 check 中，只有当前代仍有效才建立 timer
    if (!this.running || generation !== this.generation) return;
    // 竞态防御：stop/restart 或 fatal/restart 交错时旧 interval 可能未及时清理，
    // 直接覆盖 this._timer 会让旧 interval 继续跑旧 check，先清掉再建新 timer。
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._timer = setInterval(check, interval || 30000);
  }

  async sendReply(hrName, msg, chat = null, options = {}) {
    const text = String(msg || "").trim();
    if (!text) {
      log("[chat] 回复内容为空，放弃发送");
      return { ok: false, reason: "empty_reply" };
    }
    // options.generation 代际检查（仅自动回复传入）：monitorChat 把本轮 generation 传给
    // onMsg 回调，stop()/fatal/restart 会使 running=false 或 generation 递增，旧 sendReply
    // 在导航、输入、点击发送、发送等待等关键步骤之间检测到失效立即返回，不再继续驱动
    // 页面，避免新旧两轮并发驱动同一页面/重复发送。手动回复（/api/chat/send 不传
    // generation）isCurrent 恒为 true，行为不变。
    const isCurrent = () => isGenerationCurrent(this.running, options.generation, this.generation);
    let result = { ok: false, reason: "error" };
    try {
      // 导航前先查一代：stop()/重启后旧轮立即放弃，不再执行可能耗时约 20 秒的 _navigateToChat
      if (!isCurrent()) {
        log("[chat] 回复已停止（stop/重启），不再导航");
        return { ok: false, reason: "stopped", reply: text };
      }
      await this._navigateToChat();
      if (!isCurrent()) {
        log("[chat] 回复已停止（stop/重启），不再继续导航/输入");
        return { ok: false, reason: "stopped", reply: text };
      }

      // 关键闸门（2026-09-19 假回执修复）：聊天页是 SPA，导航后可能还是空壳（无消息区/无输入框），
      // 此前 sendReply 从不等待就绪就往下走，导致"未找到聊天输入框"或打进错误会话，
      // 却仍打出"已回复 …"日志 —— 报告数与实际送达数就此背离。空壳时 reload 一次，仍不就绪则放弃本次发送。
      if (!(await this._waitForChatReadyOrReload(this.page))) {
        log(`[chat] 聊天页未就绪，放弃本次回复: ${hrName || "HR"}`);
        result = { ok: false, reason: "chat_not_ready", reply: text };
        return result;
      }

      if (!isCurrent()) {
        log("[chat] 回复已停止（stop/重启），不再选择会话");
        return { ok: false, reason: "stopped", reply: text };
      }
      // 会话行必须真实选中才能输入。此前 _selectChatRow 的返回值被忽略、名字兜底结果也被丢弃，
      // 定位失败时照样往"当前恰好打开的会话"里打字发送——这是"报了回复、实际发错/没发"的直接根因。
      let selected = chat ? await this._selectChatRow(this.page, chat) : false;
      if (!selected && hrName) {
        selected = await this.page.evaluate((name) => {
          const items = document.querySelectorAll("[class*='session'], [class*='chat-item'], [class*='conversation'], li[role='listitem']");
          for (const el of items) {
            if ((el.textContent || "").includes(name) && el.offsetParent !== null) {
              el.click(); return true;
            }
          }
          return false;
        }, hrName).catch(() => false);
        if (selected) await randSleep(800, 1600);
      }
      if (!selected && hrName) {
        log(`[chat] 未能定位会话「${hrName}」，放弃盲发`);
        result = { ok: false, reason: "row_not_selected", reply: text };
        return result;
      }

      const typed = await this._humanType(this.page, text);
      if (!isCurrent()) {
        log("[chat] 回复已停止（stop/重启），不再发送");
        return { ok: false, reason: "stopped", reply: text };
      }
      if (!typed) {
        log("[chat] 未找到聊天输入框");
        result = { ok: false, reason: "no_input", reply: text };
        return result;
      }

      // 发送前记录聊天区长度，用于“长度明显增长”的确认
      const beforeLen = await this.page.evaluate((areaSels) => {
        let chatArea = null;
        for (const s of areaSels) {
          const el = document.querySelector(s);
          if (el && el.getClientRects().length > 0) { chatArea = el; break; }
        }
        return chatArea ? chatArea.innerText.length : (document.body?.innerText || "").length;
      }, CHAT_AREA_SELECTORS).catch(() => 0);

      if (!isCurrent()) {
        log("[chat] 回复已停止（stop/重启），取消点击发送");
        return { ok: false, reason: "stopped", reply: text };
      }
      const sent = await this._clickSendButton(this.page);
      if (!sent) {
        log("[chat] 未找到发送按钮，按回车发送");
        await this.page.keyboard.press("Enter").catch(() => {});
        await randSleep(600, 1000);
      }
      await this._humanWait(1.5, 3);

      if (!isCurrent()) {
        log("[chat] 回复已停止（stop/重启），跳过发送复核");
        return { ok: false, reason: "stopped", reply: text };
      }
      const verifiedInfo = await this.page.evaluate((replyText, prevLen, inputSelectors, areaSels) => {
        const body = document.body?.innerText || "";
        // 与 _humanType 共用聊天作用域输入框选择器，避免选到页面其他输入框（如职位搜索框）。
        const isUsableChatInput = (el) => {
          if (!el || el.type === "file") return false;
          const cls = String((el.className && el.className.baseVal) || el.className || el.getAttribute?.("class") || "");
          const label = el.getAttribute ? (el.getAttribute("aria-label") || "") : "";
          const type = String(el.type || "").toLowerCase();
          return !(cls.includes("search") || label.includes("搜索") || type === "search");
        };
        let input = null;
        for (const s of inputSelectors) {
          const found = document.querySelector(s);
          if (found && found.getClientRects().length > 0 && isUsableChatInput(found)) { input = found; break; }
        }
        const inputExists = !!input;
        const val = input ? (input.value || (input.isContentEditable ? input.innerText : "") || "").trim() : "";
        // 当前会话区域（消息区优先），不能拿左侧会话列表的“送达/已发送”当当前会话成功证据
        // 聊天容器多为 fixed/absolute 布局，offsetParent 为 null，用 getClientRects 判可见
        let chatArea = null;
        for (const s of areaSels) {
          const el = document.querySelector(s);
          if (el && el.getClientRects().length > 0) { chatArea = el; break; }
        }
        const areaText = chatArea ? chatArea.innerText : body;
        // 输入框不存在时必须视为未确认，不能当作“已清空”，否则聊天区/body 的历史送达标记会误判成功
        const inputCleared = inputExists && !val;
        const snippet = String(replyText || "").slice(0, 30);
        const replyInArea = !!snippet && areaText.includes(snippet);
        const sentMarker = /已发送|送达/.test(areaText);
        const grew = prevLen > 0 && areaText.length >= prevLen + Math.max(10, Math.round(String(replyText || "").length * 0.5));
        return { inputExists, inputCleared, replyInArea, sentMarker, grew };
      }, text, beforeLen, CHAT_INPUT_SELECTORS, CHAT_AREA_SELECTORS).catch(() => null);

      // 成功必须 inputExists 且 inputCleared；replyInArea 可直接成功，否则 sentMarker 必须与 grew 同时成立。
      // sentMarker 不能独立成功：历史“已发送/送达”标记会残留，须有本次发送新增内容（grew）佐证。
      const verified = !!verifiedInfo && isReplyVerified(verifiedInfo);

      result = { ok: verified, reason: verified ? "sent" : "unverified", reply: text };
      // 日志措辞就是"回执"：ok:false 时绝不能写"已回复"，否则上层（autopilot 轮次汇总、
      // 用户读日志）会把未确认的发送当成送达。已送达才说"已回复…确认发送"。
      log(verified
        ? `已回复 ${hrName || "HR"}: ${String(text || "").slice(0, 20)}... 确认发送`
        : `发送未确认 ${hrName || "HR"}: ${String(text || "").slice(0, 20)}...（不计入已回复，稍后重试）`);
    } catch (e) {
      log(`[chat] 回复失败: ${(e?.message || "").slice(0, 60)}`);
    }
    return result;
  }

  async generateReply(hrMsg, name, skills, options = {}) {
    const result = await llmProvider.generateReply(hrMsg, name, skills, options);
    if (result && result.needManual) return result;
    if (typeof result === "string") return result;
    return result?.reply || "";
  }

  stop() {
    this.running = false;
    // 代际递增：即使旧轮 check 正在 onMsg/sendReply 执行中，返回后也会发现代际不符而不再写状态
    this.generation++;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    log("自动化已停止");
  }
}
