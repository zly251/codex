// src/diagDetail.ts
// 诊断: detailPage 是否独立？goto 后进入了什么页面？
import { BrowserManager } from "./browser/browserManager.js";
async function wait(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
async function main() {
    const manager = new BrowserManager();
    await manager.connect();
    // ─── Step 1: 获取 searchPage ───
    const searchPage = await manager.getPage();
    const searchId = searchPage.target?._targetId || "?";
    const searchUrl0 = searchPage.url();
    console.log("=".repeat(70));
    console.log("[DIAG] ===== 页面状态诊�?=====");
    console.log("=".repeat(70));
    console.log(`[DIAG] searchPage id:       ${searchId}`);
    console.log(`[DIAG] searchPage URL (初始): ${searchUrl0}`);
    console.log(`[DIAG] searchPage title:     ${await searchPage.title().catch(() => "?")}`);
    // ─── Step 2: 创建 detailPage ───
    console.log("\n[DIAG] --- 创建 detailPage ---");
    const browser = searchPage.browser?.();
    if (!browser) {
        console.log("[DIAG] �?无法获取 browser");
        return;
    }
    // 获取所有页面（用于对比 pageId�?  const allPages = await browser.pages();
    console.log(`[DIAG] 当前 Edge 总页面数: ${allPages.length}`);
    for (const p of allPages) {
        const pid = p.target?._targetId || "?";
        const u = p.url().slice(0, 80);
        console.log(`[DIAG]   �?${pid}: ${u}`);
    }
    const detailPage = await browser.newPage();
    const detailId = detailPage.target?._targetId || "?";
    console.log(`\n[DIAG] detailPage id:       ${detailId}`);
    console.log(`[DIAG] detailPage URL (创建�?: ${detailPage.url()}`);
    // ─── Step 3: detailPage 初始化到 zhipin.com ───
    console.log("\n[DIAG] --- detailPage 初始化（导航�?zhipin.com�?---");
    console.log(`[DIAG] 导航�?detailPage URL: ${detailPage.url()}`);
    try {
        await detailPage.goto("https://www.zhipin.com", {
            waitUntil: "domcontentloaded",
            timeout: 15000,
        });
    }
    catch (e) {
        console.log(`[DIAG] ⚠️ 初始化导�? ${e.message?.slice(0, 80)}`);
    }
    await wait(2000);
    console.log(`[DIAG] 导航�?detailPage URL: ${detailPage.url()}`);
    const initTitle = await detailPage.title().catch(() => "?");
    console.log(`[DIAG] 导航�?detailPage title: ${initTitle.slice(0, 60)}`);
    const initText = await detailPage
        .evaluate(() => document.body?.innerText?.slice(0, 200) || "")
        .catch(() => "读取失败");
    console.log(`[DIAG] 导航�?body 文本: ${initText.replace(/\n/g, " | ").slice(0, 150)}`);
    // ─── Step 4: searchPage 是否被影响？ ───
    console.log("\n[DIAG] --- 确认 searchPage 是否独立 ---");
    const spUrl = searchPage.url();
    const spTitle = await searchPage.title().catch(() => "?");
    console.log(`[DIAG] searchPage URL:    ${spUrl}`);
    console.log(`[DIAG] searchPage title:  ${spTitle.slice(0, 50)}`);
    console.log(`[DIAG] searchPage 独立:   ${spUrl === searchUrl0 ? "�?未被影响" : "⚠️ 被改变了"}`);
    if (spUrl !== searchUrl0) {
        console.log(`[DIAG]    原URL: ${searchUrl0}`);
        console.log(`[DIAG]    现URL: ${spUrl}`);
    }
    // ─── Step 5: detailPage 导航到详�?URL ───
    const detailUrl = "https://www.zhipin.com/job_detail/7396ce31efc2ba711HB42d29FlRX.html";
    console.log(`\n[DIAG] --- detailPage 导航到详情页 ---`);
    console.log(`[DIAG] 目标 URL: ${detailUrl}`);
    console.log(`[DIAG] 导航�?detailPage URL: ${detailPage.url()}`);
    let navSuccess = false;
    let navUrl = "";
    try {
        await detailPage.goto(detailUrl, {
            waitUntil: "domcontentloaded",
            timeout: 30000,
        });
        navSuccess = true;
    }
    catch (e) {
        console.log(`[DIAG] ⚠️ goto 超时/失败: ${e.message?.slice(0, 80)}`);
    }
    await wait(3000);
    navUrl = detailPage.url();
    const navTitle = await detailPage.title().catch(() => "?");
    const navText = await detailPage
        .evaluate(() => document.body?.innerText?.slice(0, 300) || "")
        .catch(() => "读取失败");
    console.log(`[DIAG] 导航后实�?URL:   ${navUrl}`);
    console.log(`[DIAG] 导航后页�?title: ${navTitle.slice(0, 60)}`);
    console.log(`[DIAG] 是否 security �? ${navUrl.includes("security") ? "�?�?(被拦�?" : navUrl.includes(detailUrl.split("/").pop() || "") ? "�?是详情页" : "⚠️ 其他页面"}`);
    console.log(`[DIAG] body 文本 (�?00�?:`);
    console.log(`       ${navText.replace(/\n/g, "\n       ").slice(0, 200)}`);
    // 保存截图
    try {
        const ssPath = `E:\\autonomous-job-agent\\temp\\diag_${Date.now()}.png`;
        await detailPage.screenshot({ path: ssPath, fullPage: false }).catch(() => { });
        console.log(`[DIAG] 截图保存: ${ssPath}`);
    }
    catch {
        console.log("[DIAG] 截图保存失败（可能无权限�?););
    }
    // ─── Step 6: 最终状�?───
    console.log("\n[DIAG] --- 最终状�?---");
    const allPagesFinal = await browser.pages();
    console.log(`[DIAG] 总页面数: ${allPagesFinal.length}`);
    for (const p of allPagesFinal) {
        const pid = p.target?._targetId || "?";
        const u = p.url().slice(0, 100);
        const t = (await p.title().catch(() => "?")) || "?";
        const marker = pid === searchId ? "�?searchPage" : pid === detailId ? "�?detailPage" : "";
        console.log(`[DIAG]   ${pid}: ${t.slice(0, 40)} | ${u.slice(0, 80)} ${marker}`);
    }
    console.log("\n[DIAG] ===== 诊断完成 =====");
    await detailPage.close().catch(() => { });
    await manager.close();
}
main().catch(console.error);
