// src/debugDOM.ts
// 诊断 Boss 页面 DOM 结构 — 找职位卡片的实际选择器

import puppeteer from "puppeteer-core";

async function main() {
  const browser = await puppeteer.connect({
    browserURL: "http://127.0.0.1:9222",
    defaultViewport: null,
  });

  const pages = await browser.pages();
  const page = pages.find(
    (p) => p.url().includes("zhipin.com") && !p.url().includes("/user/")
  );
  if (!page) { console.log("未找到 Boss 页面"); return; }

  console.log("URL:", page.url().slice(0, 100));
  console.log("标题:", await page.title().catch(() => "?"));
  console.log("");

  // 找所有包含职位信息的卡片容器
  const classes = await page.evaluate(() => {
    // 找所有有子元素的块级容器
    const containers = document.querySelectorAll("[class]");
    const classCount: Record<string, number> = {};
    containers.forEach((el) => {
      const cls = el.className.trim();
      if (cls && cls.length > 3 && cls.length < 80) {
        // 只关注可能包含职位信息的元素（有多个子元素且包含文字）
        const text = (el.textContent || "").trim();
        if (text.length > 30 && text.length < 500) {
          classCount[cls] = (classCount[cls] || 0) + 1;
        }
      }
    });
    return Object.entries(classCount)
      .filter(([, count]) => count >= 3) // 出现3次以上
      .sort(([, a], [, b]) => b - a)
      .slice(0, 20);
  });

  console.log("出现 3 次以上的容器类名:");
  classes.forEach(([cls, count]) => console.log(`  .${cls}  (${count}x)`));

  // 看看是否包含职位标题的元素
  const titles = await page.evaluate(() => {
    const textEls: string[] = [];
    document.querySelectorAll("[class*=name], [class*=title]").forEach((el) => {
      const t = (el.textContent || "").trim();
      if (t && t.length > 5 && t.length < 40) textEls.push(t);
    });
    return textEls.slice(0, 20);
  });
  console.log("\n包含 name/title 的元素文本:");
  titles.forEach((t) => console.log(`  "${t}"`));

  await browser.disconnect();
}

main().catch(console.error);
