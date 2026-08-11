// src/browser/browserManager.js
// 浏览器连接管理层 — 启动（或复用）Edge 并通过 CDP attach
import puppeteer from "puppeteer-core";
import {
  launchEdge,
  waitForCDP,
  DEFAULT_PROFILE,
  FALLBACK_PROFILE,
} from "../edgeLauncher.js";
/**
 * 浏览器连接管理器
 *
 * 职责：
 *   - 需要时自动启动 Edge（--remote-debugging-port=9222），否则复用已运行实例
 *   - 通过 CDP WebSocket attach
 *   - 断线自动重连
 *   - 复用已有连接
 */
export class BrowserManager {
    browser = null;
    wsEndpoint = "";
    reconnectTimer = null;
    intentionalDisconnect = false;
    lastEdgeOptions = null;
    ownsBrowser = false;
    /**
     * 连接到 Edge 浏览器
     * @param host CDP host，默认 127.0.0.1
     * @param port CDP port，默认 9222
     */
    async connect(host = "127.0.0.1", port = 9222) {
        if (this.browser?.connected) {
            return this.browser;
        }
        const globalBrowser = globalThis.__JOB_AGENT_BROWSER__;
        if (globalBrowser?.connected) {
            this.browser = globalBrowser;
            this.ownsBrowser = false;
            this.wsEndpoint = globalBrowser.wsEndpoint?.() || "";
            return this.browser;
        }
        this.wsEndpoint = await this.resolveWSEndpoint(host, port);
        this.browser = await puppeteer.connect({
            browserWSEndpoint: this.wsEndpoint,
            defaultViewport: null,
            protocolTimeout: 60000,
        });
        this.ownsBrowser = false;
        // 监听断开事件，触发自动重连（非主动断开时）
        this.browser.on("disconnected", () => {
            this.browser = null;
            if (this.intentionalDisconnect)
                return;
            console.log("[browser] 连接断开，准备重连...");
            this.scheduleReconnect(host, port);
        });
        console.log(`[browser] ATTACH OK (${this.wsEndpoint.slice(0, 40)}...)`);
        return this.browser;
    }
    /**
     * 启动或复用 Edge，并把连接状态交给本管理器。
     */
    async ensureEdge({ profileDir, url = "https://www.zhipin.com", host = "127.0.0.1", port = 9222 } = {}) {
        if (this.browser?.connected) return this.browser;
        const globalBrowser = globalThis.__JOB_AGENT_BROWSER__;
        if (globalBrowser?.connected) {
            this.browser = globalBrowser;
            this.ownsBrowser = false;
            this.wsEndpoint = globalBrowser.wsEndpoint?.() || "";
            return this.browser;
        }
        this.lastEdgeOptions = { profileDir, url, host, port };
        const dirs = [
          profileDir || DEFAULT_PROFILE,
          FALLBACK_PROFILE,
        ];
        let lastErr = null;
        for (const dir of dirs) {
          try {
            await launchEdge({ profileDir: dir, url, host, port });
            const wsEndpoint = await waitForCDP(host, port, 25000);
            const browser = await puppeteer.connect({
                browserWSEndpoint: wsEndpoint,
                defaultViewport: null,
                protocolTimeout: 60000,
            });
            this.browser = browser;
            this.ownsBrowser = false;
            this.wsEndpoint = wsEndpoint;
            globalThis.__JOB_AGENT_BROWSER__ = browser;
            this.intentionalDisconnect = false;
            browser.on("disconnected", () => {
              if (globalThis.__JOB_AGENT_BROWSER__ === browser) {
                globalThis.__JOB_AGENT_BROWSER__ = null;
              }
              if (this.browser === browser) this.browser = null;
              if (this.intentionalDisconnect) return;
              console.log("[browser] Edge disconnected, reconnect scheduled.");
              this.scheduleReconnect(host, port);
            });
            return browser;
          } catch (e) {
            lastErr = e;
          }
        }
        throw lastErr || new Error("Edge launch failed.");
    }

    async openUrl(url) {
        const browser = await this.ensureEdge();
        const page = await this.getPage();
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(function () {});
        return page;
    }
    /**
     * 获取一个可用页面
     * 优先复用已有页面，否则创建新标签页
     */
    async getPage() {
        let b = this.browser;
        if (!b || !b.connected) {
            throw new Error("BrowserManager: 浏览器未连接，请先调用 connect()");
        }
    // 优先复用已有的 zhipin.com 页面，避免搜索/同步等后台操作抢焦点
    const pages = await b.pages();
    for (const p of pages) {
      const url = p.url();
      if (url.includes("zhipin.com") && !url.includes("/user/")) {
        return p;
      }
    }
    // 没有可用页面时创建新标签页
    return await b.newPage();
    }
    /**
     * 断开连接（不关闭浏览器）
     */
    async close() {
        this.intentionalDisconnect = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.browser) {
            if (this.ownsBrowser) {
                await this.browser.close();
            } else {
                await this.browser.disconnect();
            }
            this.browser = null;
            this.ownsBrowser = false;
        }
    }
    /**
     * 获取当前连接状态
     */
    get connected() {
        return this.browser?.connected ?? false;
    }
    // ─── 私有方法 ───
    /**
     * 从 CDP HTTP 接口获取 WebSocket Endpoint
     * 优先 /json/version，fallback 到 /json
     */
    async resolveWSEndpoint(host, port) {
        // 方法 1：从 /json/version 获取
        try {
            const res = await fetch(`http://${host}:${port}/json/version`, {
                signal: AbortSignal.timeout(5000),
            });
            const data = (await res.json());
            if (data.webSocketDebuggerUrl)
                return data.webSocketDebuggerUrl;
        }
        catch {
            // fallthrough
        }
        // 方法 2：从 /json 列表获取
        try {
            const res = await fetch(`http://${host}:${port}/json`, {
                signal: AbortSignal.timeout(5000),
            });
            const list = (await res.json());
            const entry = list.find((p) => p.webSocketDebuggerUrl);
            if (entry?.webSocketDebuggerUrl)
                return entry.webSocketDebuggerUrl;
        }
        catch {
            // fallthrough
        }
        throw new Error(`无法连接到 CDP (${host}:${port})。请确保 Edge 已通过 --remote-debugging-port=${port} 启动`);
    }
    /**
     * 调度自动重连
     */
    scheduleReconnect(host, port) {
        if (this.reconnectTimer)
            return;
        console.log("[browser] 5 秒后尝试重连...");
        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            try {
                if (this.lastEdgeOptions) {
                    await this.ensureEdge(this.lastEdgeOptions);
                } else {
                    await this.connect(host, port);
                }
                console.log("[browser] 重连成功");
            }
            catch {
                console.log("[browser] 重连失败，继续等待...");
                this.scheduleReconnect(host, port);
            }
        }, 5000);
    }
}
