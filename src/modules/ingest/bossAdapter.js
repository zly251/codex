// M1 Ingest — BOSS直聘 PlatformAdapter
// Implements the PlatformAdapter contract (20 hooks) defined in
// src/core/contracts/adapterContract.js.
//
// Job discovery logic extracted from src/scrapers/bossApi.js (BossApiScraper)
// and adapted to the PlatformAdapter interface. Uses cleaner.js for data
// processing and enricher.js for detail enrichment.
//
// Page/browser interaction requires a puppeteer browserManager injected
// at creation time. Config methods (getPlatformConfig, getRateLimit, etc.)
// are pure and work without a browser.

import { cleanSearchResults, rawItemToJobDraft, dedupJobs } from "./cleaner.js";
import { enrichFromPage, normalizeEnrichPayload, enrichmentPatch, mergeEnrichment, stripWatermark } from "./enricher.js";
import { classifyDistance } from "../../core/distance.js";
import { SCHEMA_VERSION } from "../../core/contracts/payloadContract.js";

// ══════════════════════════════════════════════════════════════════
// Platform constants (extracted from bossApi.js)
// ══════════════════════════════════════════════════════════════════

const BASE_URL = "https://www.zhipin.com";
const API_URLS = ["/search/joblist.json", "/job/detail.json"];

const CITY_CODES = {
  北京: "101010100",
  上海: "101020100",
  广州: "101280100",
  深圳: "101280600",
  杭州: "101210100",
  成都: "101270100",
  台州: "101210600",
  宁波: "101210400",
  温州: "101210700",
};

const SUPPORTED_CITIES = Object.keys(CITY_CODES);

const RATE_LIMIT = {
  searchPerHour: 30,
  detailPerMinute: 10,
  chatPerDay: 50,
};

const PLATFORM_CONFIG = {
  baseUrl: BASE_URL,
  jobsUrl: BASE_URL + "/web/geek/jobs",
  loginUrl: BASE_URL + "/web/user/?ka=header-login",
  selectors: {
    jobCard: ".job-card-box",
    jobDetailLink: "a[href*='/job_detail/']",
    jobTitle: ".job-name",
    salary: "[class*=salary]",
    company: "[class*=company]",
    city: "[class*=city]",
    district: ".job-area",
    experience: ".job-experience",
    education: ".job-education",
    tags: ".job-tags",
    description: ".job-sec-text",
    locationAddress: ".location-address",
    chatMessage: ".chat-msg",
    hrName: ".boss-name",
  },
  rateLimit: RATE_LIMIT,
};

// ══════════════════════════════════════════════════════════════════
// Factory
// ══════════════════════════════════════════════════════════════════

/**
 * Create a BOSS直聘 PlatformAdapter instance.
 * @param {Object} [browserManager] - puppeteer browser manager (optional for config-only use)
 * @returns {Object} PlatformAdapter with 20 hooks
 */
export function createBossAdapter(browserManager) {
  let _page = null;
  let _busy = false;

  // ── Internal helpers ──────────────────────────────────────────

  async function _getPage() {
    if (_page && !_page.isClosed()) {
      try {
        await _page.evaluate("1+1");
        return _page;
      } catch {}
    }
    if (!browserManager?.browser?.connected) throw new Error("browser not connected");
    _page = await browserManager.getPage();
    await _page.setViewport({ width: 1400, height: 900 });
    return _page;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const randSleep = (base, jitter) => sleep(base + Math.random() * jitter);

  // ── Adapter object ────────────────────────────────────────────

  const adapter = {
    name: "boss",
    version: "1.0.0",

    // ════════ 搜索与列表 ════════

    /**
     * Search for jobs on BOSS直聘.
     * Intercepts API responses (/search/joblist.json), falls back to DOM extraction.
     * @param {string} keyword - search keyword
     * @param {Object} [opts] - {city, page, limit}
     * @returns {Promise<Object[]>} JobListItem[] (as JobDraft with status=DRAFT)
     */
    async searchJobs(keyword, opts = {}) {
      const { city = "", page = 1, limit = 3 } = opts;
      if (!browserManager) throw new Error("searchJobs: browserManager not provided");

      if (_busy) return [];
      _busy = true;

      const page_ = await _getPage();
      let raw = [];

      page_.on("response", async (resp) => {
        try {
          if (!API_URLS.some((u) => resp.url().indexOf(u) >= 0)) return;
          const json = await resp.json();
          const list = json?.zpData?.jobList || [];
          if (list.length) raw = raw.concat(list);
        } catch (e) {}
      });

      try {
        const cc = CITY_CODES[city] || "";
        for (let p = 1; p <= limit; p++) {
          await page_
            .goto(
              `${BASE_URL}/web/geek/job?city=${cc}&query=${encodeURIComponent(keyword)}&page=${p}`,
              { waitUntil: "networkidle2", timeout: 30000 }
            )
            .catch(() => {});
          await randSleep(3000, 3000);
        }
      } catch (e) {
      } finally {
        page_.removeAllListeners("response");
        _busy = false;
      }

      // DOM fallback when API intercept returns nothing
      if (raw.length === 0) {
        try {
          for (let p = 1; p <= limit; p++) {
            const cc = CITY_CODES[city] || "";
            await page_
              .goto(
                `${BASE_URL}/web/geek/job?city=${cc}&query=${encodeURIComponent(keyword)}&page=${p}`,
                { waitUntil: "networkidle2", timeout: 30000 }
              )
              .catch(() => {});
            await randSleep(3000, 3000);
            const domJobs = await page_
              .evaluate(function () {
                var items = [];
                var cards = document.querySelectorAll(".job-card-box");
                for (var ci = 0; ci < cards.length; ci++) {
                  var c = cards[ci];
                  var link = c.querySelector("a[href*='/job_detail/']");
                  var idMatch = link
                    ? (link.getAttribute("href") || "").match(/\/job_detail\/([^\/.?]+)/)
                    : null;
                  if (!idMatch) continue;
                  var titleEl = link
                    ? link.querySelector(".job-name") || link.querySelector("[class*=job-name]")
                    : null;
                  var salaryEl = c.querySelector("[class*=salary]") || c.querySelector(".salary");
                  var companyEl = c.querySelector("[class*=company]") || c.querySelector("a[href*='/gongsi/']");
                  var cityEl = c.querySelector("[class*=city]") || c.querySelector(".job-area");
                  var districtEl = c.querySelector("[class*=district]") || c.querySelector(".job-area");
                  var expEl = c.querySelector("[class*=experience]") || c.querySelector(".job-experience");
                  var eduEl = c.querySelector("[class*=education]") || c.querySelector(".job-education");
                  var skillEl = c.querySelector("[class*=tags]") || c.querySelector(".job-tags");
                  items.push({
                    encryptJobId: idMatch[1],
                    jobName: titleEl ? (titleEl.textContent || "").trim() : (link ? (link.textContent || "").trim() : ""),
                    salaryDesc: salaryEl ? (salaryEl.textContent || "").trim() : "",
                    cityName: cityEl ? (cityEl.textContent || "").trim() : "",
                    areaDistrict: districtEl ? (districtEl.textContent || "").trim() : "",
                    jobExperience: expEl ? (expEl.textContent || "").trim() : "",
                    jobDegree: eduEl ? (eduEl.textContent || "").trim() : "",
                    skills: skillEl ? (skillEl.textContent || "").trim().split(/[,\s]+/).filter(function (s) { return s.trim(); }) : [],
                    jobDetail: "",
                    brandName: companyEl ? (companyEl.textContent || "").trim() : "",
                  });
                }
                return items;
              })
              .catch(() => []);
            if (domJobs.length > 0) raw = raw.concat(domJobs);
          }
        } catch (e) {}
      }

      return cleanSearchResults(raw);
    },

    /**
     * Get job detail from the detail page.
     * Navigates to detail URL, extracts JD text, tags, coords via enricher.
     * @param {string} jobId - encrypted job ID
     * @returns {Promise<Object>} JobDetail
     */
    async getJobDetail(jobId) {
      if (!browserManager) throw new Error("getJobDetail: browserManager not provided");
      const page_ = await _getPage();
      const url = `${BASE_URL}/job_detail/${jobId}.html`;
      await page_.goto(url, { waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});

      const enriched = await enrichFromPage(page_);

      // Build JobDetail
      const detail = {
        jobId,
        title: "",
        schemaVersion: SCHEMA_VERSION,
        source: "boss_detail",
        detailedAt: Date.now(),
      };
      if (enriched.description) detail.description = enriched.description;
      if (enriched.address) detail.address = enriched.address;
      if (enriched.lat != null) detail.lat = enriched.lat;
      if (enriched.lng != null) detail.lng = enriched.lng;
      detail.hasDormitory = !!enriched.hasDormitory;

      // Distance classification if we have coords
      if (enriched.lat != null && enriched.lng != null) {
        const distInfo = classifyDistance({ lat: enriched.lat, lng: enriched.lng });
        if (distInfo.distanceKm != null) detail.distanceKm = distInfo.distanceKm;
        if (distInfo.distanceTier) detail.distanceTier = distInfo.distanceTier;
      }

      return detail;
    },

    /**
     * Enrich a job list with distance and dormitory info.
     * Searches first, then optionally enriches each with distance.
     * @param {string} keyword
     * @param {Object} [opts] - {withDistance, withDormitory, city, page, limit}
     * @returns {Promise<Object[]>} enriched JobListItem[]
     */
    async enrichJobList(keyword, opts = {}) {
      const { withDistance = true, withDormitory = true, city = "", page = 1, limit = 3 } = opts;
      const drafts = await adapter.searchJobs(keyword, { city, page, limit });

      if (!withDistance && !withDormitory) return drafts;

      const results = [];
      for (const draft of drafts) {
        const enriched = { ...draft };

        if (withDistance && (enriched._lat != null || enriched.district)) {
          const distInfo = classifyDistance({
            lat: enriched._lat,
            lng: enriched._lng,
            city: enriched.city,
            district: enriched.district,
          });
          if (distInfo.distanceKm != null) enriched.distanceKm = distInfo.distanceKm;
          if (distInfo.distanceTier) enriched.distanceTier = distInfo.distanceTier;
        }

        // Dormitory already detected from card in cleaner; no extra step needed
        results.push(enriched);
      }
      return results;
    },

    // ════════ 聊天与消息 ════════

    /**
     * Get chat session for a job.
     * @param {string} jobId
     * @returns {Promise<Object>} ChatSession
     */
    async getChatSession(jobId) {
      if (!browserManager) throw new Error("getChatSession: browserManager not provided");
      const page_ = await _getPage();
      const url = `${BASE_URL}/web/geek/chat?jobId=${jobId}`;
      await page_.goto(url, { waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});

      const text = await page_
        .evaluate(function () {
          return document.body ? document.body.innerText : "";
        })
        .catch(() => "");

      return {
        jobId,
        hrName: "",
        messages: [],
        lastActiveAt: Date.now(),
        hasReplied: false,
      };
    },

    /**
     * Get chat history for a job.
     * @param {string} jobId
     * @param {number} [limit=50] - max messages
     * @returns {Promise<Object[]>} ChatMessage[]
     */
    async getChatHistory(jobId, limit = 50) {
      if (!browserManager) throw new Error("getChatHistory: browserManager not provided");
      const page_ = await _getPage();
      const url = `${BASE_URL}/web/geek/chat?jobId=${jobId}`;
      await page_.goto(url, { waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});

      const messages = await page_
        .evaluate(function (maxCount) {
          var msgs = [];
          var els = document.querySelectorAll(".chat-msg, [class*=chat-content] li, [class*=message-item]");
          for (var i = 0; i < els.length && i < maxCount; i++) {
            var el = els[i];
            var text = (el.textContent || "").trim();
            var sender = "system";
            if (el.className && /boss|hr|other/i.test(el.className)) sender = "hr";
            else if (el.className && /me|self|user/i.test(el.className)) sender = "me";
            msgs.push({
              id: "msg_" + i,
              sender: sender,
              text: text,
              timestamp: Date.now(),
              type: "text",
            });
          }
          return msgs;
        }, limit)
        .catch(() => []);

      return messages;
    },

    /**
     * Get the last HR message for a job.
     * @param {string} jobId
     * @returns {Promise<string>} message text
     */
    async getLastHrMessage(jobId) {
      const messages = await adapter.getChatHistory(jobId, 20);
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].sender === "hr") return messages[i].text;
      }
      return "";
    },

    // ════════ 页面状态 ════════

    /**
     * Check if logged in on BOSS直聘.
     * @returns {Promise<boolean>}
     */
    async isLoggedIn() {
      if (!browserManager) throw new Error("isLoggedIn: browserManager not provided");
      try {
        const page_ = await _getPage();
        return await page_.evaluate(function () {
          var text = document.body ? document.body.innerText : "";
          return text.indexOf("登录/注册") < 0;
        });
      } catch (e) {
        return false;
      }
    },

    /**
     * Get current page state.
     * @returns {Promise<{url:string, title:string, hasLogin:boolean}>}
     */
    async getPageState() {
      if (!browserManager) throw new Error("getPageState: browserManager not provided");
      try {
        const page_ = await _getPage();
        const url = page_.url();
        const title = await page_.title().catch(() => "");
        const loggedIn = await adapter.isLoggedIn();
        return { url, title, hasLogin: loggedIn };
      } catch (e) {
        return { url: "", title: "", hasLogin: false };
      }
    },

    // ════════ 数据提取（只读） ════════

    /**
     * Extract text content from the current page.
     * @returns {Promise<string>}
     */
    async extractPageText() {
      if (!browserManager) throw new Error("extractPageText: browserManager not provided");
      const page_ = await _getPage();
      return await page_
        .evaluate(function () {
          return document.body ? document.body.innerText : "";
        })
        .catch(() => "");
    },

    /**
     * Extract job card info from a DOM element.
     * @param {string} elementSelector - CSS selector for the card
     * @returns {Promise<Object>}
     */
    async extractJobCard(elementSelector) {
      if (!browserManager) throw new Error("extractJobCard: browserManager not provided");
      const page_ = await _getPage();
      return await page_
        .evaluate(function (sel) {
          var c = document.querySelector(sel);
          if (!c) return null;
          var link = c.querySelector("a[href*='/job_detail/']");
          var idMatch = link ? (link.getAttribute("href") || "").match(/\/job_detail\/([^\/.?]+)/) : null;
          return {
            jobId: idMatch ? idMatch[1] : "",
            title: c.querySelector(".job-name") ? (c.querySelector(".job-name").textContent || "").trim() : "",
            salary: c.querySelector("[class*=salary]") ? (c.querySelector("[class*=salary]").textContent || "").trim() : "",
            company: c.querySelector("[class*=company]") ? (c.querySelector("[class*=company]").textContent || "").trim() : "",
          };
        }, elementSelector)
        .catch(() => null);
    },

    // ════════ 用户操作回调（可选） ════════

    onUserSearch(keyword, results) {
      // Hook for when user performs a search; no-op by default
    },
    onUserViewDetail(jobId) {
      // Hook for when user views a job detail; no-op by default
    },
    onUserSendMessage(jobId, message) {
      // Hook for when user sends a message; no-op by default
    },

    // ════════ 配置与元数据 ════════

    /**
     * Get platform configuration.
     * @returns {Object} {baseUrl, selectors, rateLimit}
     */
    getPlatformConfig() {
      return { ...PLATFORM_CONFIG };
    },

    /**
     * Get supported cities.
     * @returns {string[]}
     */
    getSupportedCities() {
      return [...SUPPORTED_CITIES];
    },

    /**
     * Get rate limit configuration.
     * @returns {Object} {searchPerHour, detailPerMinute, chatPerDay}
     */
    getRateLimit() {
      return { ...RATE_LIMIT };
    },

    /**
     * Validate a BOSS job ID format.
     * BOSS encrypted job IDs are alphanumeric strings, typically 20-40 chars.
     * @param {string} jobId
     * @returns {boolean}
     */
    isValidJobId(jobId) {
      if (!jobId || typeof jobId !== "string") return false;
      // BOSS encryptJobId is a base64-like alphanumeric string
      return /^[A-Za-z0-9_-]{10,}$/.test(jobId);
    },

    // ════════ 账号信息（需要浏览器） ════════

    async getAccountInfo() {
      if (!browserManager) throw new Error("getAccountInfo: browserManager not provided");
      const page_ = await _getPage();
      return await page_
        .evaluate(function () {
          var nickEl = document.querySelector(".user-info .name, .header-user .name, [class*=nickname]");
          var avatarEl = document.querySelector(".user-info img, .avatar img, [class*=avatar] img");
          var vipEl = document.querySelector("[class*=vip], .vip-icon");
          return {
            nickname: nickEl ? (nickEl.textContent || "").trim() : "",
            avatar: avatarEl ? avatarEl.src || "" : "",
            vip: !!vipEl,
          };
        })
        .catch(() => ({ nickname: "", avatar: "", vip: false }));
    },

    async getResumeStatus() {
      if (!browserManager) throw new Error("getResumeStatus: browserManager not provided");
      const page_ = await _getPage();
      return await page_
        .evaluate(function () {
          var attachEls = document.querySelectorAll("[class*=resume-attach], [class*=attachment]");
          return {
            hasResume: attachEls.length > 0,
            attachmentCount: attachEls.length,
          };
        })
        .catch(() => ({ hasResume: false, attachmentCount: 0 }));
    },

    async getUnreadCount() {
      if (!browserManager) throw new Error("getUnreadCount: browserManager not provided");
      const page_ = await _getPage();
      return await page_
        .evaluate(function () {
          var badgeEl = document.querySelector("[class*=unread] .badge, .msg-count, [class*=badge]");
          if (!badgeEl) return 0;
          var text = (badgeEl.textContent || "").trim();
          var n = parseInt(text, 10);
          return isNaN(n) ? 0 : n;
        })
        .catch(() => 0);
    },
  };

  return adapter;
}
