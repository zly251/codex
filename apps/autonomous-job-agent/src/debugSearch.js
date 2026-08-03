// src/debugSearch.ts
// 诊断 bossScraper.search() — 先走首页再搜索
import { BrowserManager } from "./browser/browserManager.js";
async function main() {
    const manager = new BrowserManager();
    await manager.connect();
    const page = await manager.getPage();
    // 策略：先加载 Boss 首页（获取 cookie/登录态）
    console.log("1. 访问 Boss 首页...");
    await page.goto("https://www.zhipin.com", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
    });
    await new Promise((r) => setTimeout(r, 2000));
    console.log("   当前URL:", page.url());
    console.log("   标题:", await page.title().catch(() => "?"));
    // 检查是否跳转了（未登录可能跳转）
    const bodyLen = await page.evaluate(() => document.body?.innerText?.length || 0);
    console.log(`   body 长度: ${bodyLen} 字符`);
    if (bodyLen < 50) {
        console.log("   ⚠️ 页面似乎被拦截，尝试直接搜索...");
    }
    // 2. 搜索
    const searchUrl = "https://www.zhipin.com/web/geek/job?query=Java&city=101210600";
    console.log("\n2. 导航到搜索页...");
    await page.goto(searchUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
    });
    await new Promise((r) => setTimeout(r, 3000));
    console.log("   当前URL:", page.url());
    console.log("   标题:", await page.title().catch(() => "?"));
    const text = await page
        .evaluate(() => document.body?.innerText?.slice(0, 300) || "空")
        .catch(() => "读取失败");
    console.log("\n   页面文字:\n   " + text.replace(/\n/g, "\n   "));
    const cards = await page.evaluate(() => {
        const sel = "[class*=job-card], [class*=card-wrapper]";
        const all = document.querySelectorAll(sel);
        return { selector: sel, count: all.length };
    });
    console.log(`\n   [class*=job-card] 匹配数: ${cards.count}`);
    // 列出所有包含 class 的元素
    const allClasses = await page.evaluate(() => {
        const set = new Set();
        document.querySelectorAll("[class]").forEach((el) => {
            (el.className || "").split(/\s+/).forEach((c) => {
                if (c)
                    set.add(c);
            });
        });
        return [...set].slice(0, 20);
    });
    console.log("\n   前20个类名:", allClasses);
    await manager.close();
}
main().catch(console.error);
