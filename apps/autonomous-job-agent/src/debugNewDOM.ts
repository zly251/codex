// src/debugNewDOM.ts
// 分析详情页真实 DOM 结构 — 打印最外层容器 HTML

import puppeteer from "puppeteer-core";

async function main() {
  const browser = await puppeteer.connect({
    browserURL: "http://127.0.0.1:9222",
    defaultViewport: null,
  });

  const pages = await browser.pages();
  let page = pages.find((p) => p.url().includes("zhipin") && !p.url().includes("/user/"));
  if (!page) { page = pages[0]; }

  // 导航到第一个职位的详情页
  const jobUrl = "https://www.zhipin.com/job_detail/7396ce31efc2ba711HB42d29FlRX.html";
  console.log("导航到:", jobUrl);
  await page.goto(jobUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch((e) => {
    console.log("导航失败:", e.message?.slice(0, 60));
  });
  await new Promise((r) => setTimeout(r, 2000));

  console.log("当前URL:", page.url());
  console.log("标题:", await page.title().catch(() => "?"), "\n");

  const dom = await page.evaluate(() => {
    const r: any = {};

    // 整个 body 的 HTML 结构（去脚本/样式）
    const clone = document.body?.cloneNode(true) as HTMLElement;
    if (clone) {
      clone.querySelectorAll("script, style, link, meta").forEach((el) => el.remove());
      r.bodyHTML = clone.innerHTML.slice(0, 4000);
    }

    // 所有叶文本节点（含父元素 class）
    r.textNodes = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode()) && r.textNodes.length < 60) {
      const text = (node.textContent || "").trim();
      if (text.length > 1) {
        const parent = node.parentElement;
        r.textNodes.push({
          class: parent?.className?.slice?.(0, 60) || "",
          tag: parent?.tagName || "",
          text: text.slice(0, 40),
        });
      }
    }

    return r;
  });

  console.log("=".repeat(70));
  console.log("  Body HTML（前 4000 字符）");
  console.log("=".repeat(70));
  console.log(dom.bodyHTML);

  console.log("\n" + "=".repeat(70));
  console.log("  所有可见文本节点（含父元素 class）");
  console.log("=".repeat(70));
  dom.textNodes.forEach((n: any, i: number) => {
    console.log(`  [${i}] <${n.tag} class="${n.class.slice(0, 40)}"> "${n.text}"`);
  });

  await browser.disconnect();
}

main().catch(console.error);
