// src/browser/browserManager.ts
// 浏览器连接管理层 — 稳定连接用户已有的 Edge 实例
// 不启动、不关闭浏览器，只通过 CDP 协议 attach
import puppeteer from "puppeteer-core";
/**
 * 浏览器连接管理器
 *
 * 职责：
 *   - 通过 CDP WebSocket 连接用户已有的 Edge
 *   - 断线自动重连
 *   - 复用已有连接
 *
 * 使用方式：
 *   1. 用户手动启动 Edge：msedge.exe --remote-debugging-port=9222
 *   2. BrowserManager.connect() 自动 attach
 *   3. manager.getPage() 获取页面进行操作
 *   4. manager.close() 断开连接（不关浏览器）
 */
export class BrowserManager {
    browser = null;
    wsEndpoint = "";
    reconnectTimer = null;
    intentionalDisconnect = false;
    /**
     * 连接到 Edge 浏览器
     * @param host CDP host，默认 127.0.0.1
     * @param port CDP port，默认 9222
     */
    async connect(host = "127.0.0.1", port = 9222) {
        if (this.browser?.connected) {
            return this.browser;
        }
        this.wsEndpoint = await this.resolveWSEndpoint(host, port);
        this.browser = await puppeteer.connect({
            browserWSEndpoint: this.wsEndpoint,
            defaultViewport: null,
        });
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
     * 获取一个可用页面
     * 优先复用已有页面，否则创建新标签页
     */
    async getPage() {
        let b = this.browser;
        if (!b || !b.connected) {
            throw new Error("BrowserManager: 浏览器未连接，请先调用 connect()");
        }
        // 优先复用已有的 zhipin.com 页面（已通过反爬验证）
        const pages = await b.pages();
        for (const p of pages) {
            const url = p.url();
            if (url.includes("zhipin.com") && !url.includes("/user/")) {
                try { await p.bringToFront(); } catch (e) {}
                return p;
            }
        }
        // 没有可用页面时创建新标签页
        const page = await b.newPage();
        try { await page.bringToFront(); } catch (e) {}
        return page;
    }
    /**
     * 断开连接（不关闭 Edge 浏览器）
     */
    async close() {
        this.intentionalDisconnect = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.browser) {
            await this.browser.disconnect();
            this.browser = null;
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
                await this.connect(host, port);
                console.log("[browser] 重连成功");
            }
            catch {
                console.log("[browser] 重连失败，继续等待...");
                this.scheduleReconnect(host, port);
            }
        }, 5000);
    }
}
