// src/debugDOMSelectors.ts
// 精准定位 company / description / requirements / technologies 的 DOM 节点

import puppeteer from "puppeteer-core";

async function main() {
  const browser = await puppeteer.connect({
    browserURL: "http://127.0.0.1:9222",
    defaultViewport: null,
  });

  const pages = await browser.pages();
  let page = pages.find(p => p.url().includes("zhipin") && !p.url().includes("/user/"));
  if (!page) page = pages[0];

  const jobUrl = "https://www.zhipin.com/job_detail/7396ce31efc2ba711HB42d29FlRX.html";
  await page.goto(jobUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 2000));

  console.log("URL:", page.url());
  console.log("标题:", await page.title().catch(() => "?"), "\n");

  const dom = await page.evaluate(() => {
    const r: any = {};

    // ─── 1. company：所有含"公司"含义的节点 ───
    r.companyCandidates = [...document.querySelectorAll(
      "[class*=company], [class*=com-], [class*=company-text], [class*=boss-info], " +
      "a[href*='/gongsi/'], a[href*='/company/'], " +
      "[class*=job-company], [class*=name]"
    )].slice(0, 10).map(el => ({
      tag: el.tagName,
      cls: (el.className || "").slice(0, 50),
      text: (el.textContent || "").trim().slice(0, 50),
      href: (el as HTMLAnchorElement).href?.slice(0, 60) || "",
    }));

    // ─── 2. description：职位描述主体区域 ───
    r.descCandidates = [...document.querySelectorAll(
      ".job-detail-container, .job-detail-box, .job-sec, [class*=job-detail]"
    )].slice(0, 5).map(el => ({
      cls: (el.className || "").slice(0, 50),
      firstChild: ((el.children[0] as HTMLElement)?.textContent || "").trim().slice(0, 30),
      textLen: (el.textContent || "").length,
      text200: (el.textContent || "").trim().slice(0, 200),
    }));

    // ─── 3. 所有 label 和 tag 元素 ───
    r.allTags = [...document.querySelectorAll("label, [class*=tag], [class*=label]")]
      .slice(0, 30).map(el => ({
        tag: el.tagName,
        cls: (el.className || "").slice(0, 40),
        text: (el.textContent || "").trim().slice(0, 30),
      }));

    // ─── 4. 页面上所有相对独立的文本块（含父元素 class）───
    r.textBlocks = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (n) => {
        const el = n as HTMLElement;
        const text = (el.textContent || "").trim();
        if (text.length < 5 || text.length > 1000) return NodeFilter.FILTER_SKIP;
        // 只取叶容器（没有子 block 级元素）
        if (el.querySelectorAll("p, div, li, section, article").length > 2) return NodeFilter.FILTER_SKIP;
        return NodeFilter.FILTER_ACCEPT;
      }
    } as any);
    let n;
    while ((n = walker.nextNode()) && r.textBlocks.length < 40) {
      const el = n as HTMLElement;
      const text = (el.textContent || "").trim();
      if (text.length > 5) {
        r.textBlocks.push({
          tag: el.tagName,
          cls: (el.className || "").slice(0, 50),
          text: text.slice(0, 60),
        });
      }
    }

    return r;
  });

  console.log("=".repeat(70));
  console.log("1. 公司候选元素");
  console.log("=".repeat(70));
  dom.companyCandidates.forEach((c: any, i: number) => {
    console.log(`[${i}] <${c.tag} class="${c.cls}">`);
    console.log(`     text: "${c.text}"`);
    if (c.href) console.log(`     href: ${c.href}`);
  });

  console.log("\n" + "=".repeat(70));
  console.log("2. 描述区域候选");
  console.log("=".repeat(70));
  dom.descCandidates.forEach((d: any, i: number) => {
    if (d.textLen > 10) {
      console.log(`[${i}] class="${d.cls}" len=${d.textLen}`);
      console.log(`     标题: "${d.firstChild}"`);
      console.log(`     内容前200: ${d.text200.slice(0, 100)}`);
    }
  });

  console.log("\n" + "=".repeat(70));
  console.log("3. 所有标签元素 (label/tag)");
  console.log("=".repeat(70));
  dom.allTags.forEach((t: any, i: number) => {
    console.log(`[${i}] <${t.tag} class="${t.cls}"> "${t.text}"`);
  });

  console.log("\n" + "=".repeat(70));
  console.log("4. 相对独立文本块（前40）");
  console.log("=".repeat(70));
  dom.textBlocks.forEach((b: any, i: number) => {
    console.log(`[${i}] <${b.tag} class="${b.cls}">`);
    console.log(`     "${b.text}"`);
  });

  await browser.disconnect();
}

main().catch(console.error);
