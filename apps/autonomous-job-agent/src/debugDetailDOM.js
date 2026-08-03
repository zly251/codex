// src/debugDetailDOM.ts
// 诊断详情页 DOM — 不复位，只读用户已打开的页面
import puppeteer from "puppeteer-core";
async function main() {
    const browser = await puppeteer.connect({
        browserURL: "http://127.0.0.1:9222",
        defaultViewport: null,
    });
    const pages = await browser.pages();
    console.log(`Edge 中有 ${pages.length} 个页面:\n`);
    let targetPage = null;
    for (const p of pages) {
        const url = p.url();
        const title = (await p.title().catch(() => "?")) || "?";
        console.log(`  ${url.includes("zhipin") ? "💼" : "📄"}  ${title.slice(0, 60)}`);
        console.log(`       ${url.slice(0, 100)}`);
        // 找 Boss 详情页（含 job_detail）或搜索页（含 geek/job）
        if (url.includes("job_detail") ||
            (url.includes("zhipin.com") && !url.includes("/user/"))) {
            targetPage = p;
        }
    }
    if (!targetPage) {
        console.log("\n❌ 未找到 Boss 页面。请在 Edge 中打开一个职位详情页或搜索页。");
        await browser.disconnect();
        return;
    }
    console.log(`\n✅ 目标页面: ${targetPage.url().slice(0, 80)}`);
    // ── 分析 DOM ──
    const dom = await targetPage.evaluate(() => {
        const result = {};
        // 1. 页面所有 CSS 类名（前 80）
        const allClasses = [...new Set([...document.querySelectorAll("[class]")].map((el) => el.className).flatMap((c) => c.split(/\s+/)))]
            .filter(Boolean)
            .sort();
        result.allClasses = allClasses.slice(0, 80);
        // 2. 全部标签/徽章（可能包含学历、经验、城市）
        const tags = [...document.querySelectorAll("[class*=tag], [class*=badge], [class*=label], [class*=info]")].slice(0, 20).map((el) => ({
            cls: (el.className || "").slice(0, 40),
            text: (el.textContent || "").trim().slice(0, 30),
        }));
        result.tags = tags;
        // 3. 所有包含"公司"的元素
        result.companies = [...document.querySelectorAll("[class*=company], [class*=com-]")]
            .slice(0, 5)
            .map((el) => ({
            cls: (el.className || "").slice(0, 40),
            text: (el.textContent || "").trim().slice(0, 40),
        }));
        // 4. 所有包含"位置"/"城市"的元素
        result.locations = [...document.querySelectorAll("[class*=location], [class*=city], [class*=area], [class*=address]")].slice(0, 5).map((el) => ({
            cls: (el.className || "").slice(0, 40),
            text: (el.textContent || "").trim().slice(0, 40),
        }));
        // 5. 主要文字区块（可能包含职位描述）
        result.textBlocks = [...document.querySelectorAll(".job-sec, .job-detail, [class*=job-sec], [class*=detail-content], " +
                "[class*=job-banner], .job-banner, [class*=job-description], " +
                ".job-description")].slice(0, 5).map((el) => ({
            cls: (el.className || "").slice(0, 40),
            // 第一个 child 看是不是标题
            firstChild: (el.children[0]?.textContent || "").trim().slice(0, 30),
            text: (el.textContent || "").trim().slice(0, 200),
        }));
        // 6. 页面 body 前 400 字（快速预览）
        result.bodyText = (document.body?.innerText || "").trim().slice(0, 400);
        return result;
    });
    console.log("\n" + "=".repeat(70));
    console.log("  DOM 诊断");
    console.log("=".repeat(70));
    console.log("\n--- 页面文本（前 400 字）---");
    console.log(dom.bodyText);
    console.log("\n--- 公司元素 ---");
    dom.companies.forEach((c) => console.log(`  [${c.cls}] "${c.text}"`));
    console.log("\n--- 位置元素 ---");
    dom.locations.forEach((l) => console.log(`  [${l.cls}] "${l.text}"`));
    console.log("\n--- 标签/徽章（学历、经验等）---");
    dom.tags.forEach((t) => console.log(`  [${t.cls}] "${t.text}"`));
    console.log("\n--- 文字区块 ---");
    dom.textBlocks.forEach((b) => {
        if (b.text) {
            console.log(`  [${b.cls}] 标题:"${b.firstChild}"`);
            console.log(`        内容: ${b.text.slice(0, 120)}`);
        }
    });
    console.log("\n--- 页面所有 CSS 类名（前 80）---");
    dom.allClasses.forEach((c) => console.log(`  .${c}`));
    await browser.disconnect();
}
main().catch(console.error);
