// src/debugRoot.ts
// 找详情页根容�?+ 所有区块的 class
import puppeteer from "puppeteer-core";
async function main() {
    const browser = await puppeteer.connect({
        browserURL: "http://127.0.0.1:9222",
        defaultViewport: null,
    });
    const pages = await browser.pages();
    let page = pages.find(p => p.url().includes("zhipin") && !p.url().includes("/user/"));
    if (!page)
        page = pages[0];
    const jobUrl = "https://www.zhipin.com/job_detail/7396ce31efc2ba711HB42d29FlRX.html";
    await page.goto(jobUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => { });
    await new Promise(r => setTimeout(r, 2000));
    const dom = await page.evaluate(() => {
        // body 所有直接子元素�?tag + class
        const bodyChildren = [...document.body.children].slice(0, 10).map(el => ({
            tag: el.tagName,
            cls: (el.className || "").slice(0, 60),
            id: (el.id || "").slice(0, 40),
            innerTextLen: (el.innerText || "").length,
        }));
        // 所有含 detailed/job/position 的容器元素的 class
        const containers = [...document.querySelectorAll("[class*='detail' i], [class*='job' i], [class*='position' i], [class*='main' i], [class*='content' i], [class*='container' i]")]
            .slice(0, 20)
            .map(el => ({
            tag: el.tagName,
            cls: (el.className || "").slice(0, 60),
            innerTextLen: (el.innerText || "").length,
        }));
        return { bodyChildren, containers };
    });
    console.log("=== body 直接子元�?===");
    dom.bodyChildren.forEach((c, i) => console.log(`  [${i}] <${c.tag} class="${c.cls}" id="${c.id}"> textLen=${c.innerTextLen}`));
    console.log("\n=== �?detail/job/main 等关键词的容器（textLen>50�?==");
    dom.containers
        .filter((c) => c.innerTextLen > 50)
        .forEach((c, i) => console.log(`  [${i}] <${c.tag} class="${c.cls}"> textLen=${c.innerTextLen}`));
    await browser.disconnect();
}
main().catch(console.error);
