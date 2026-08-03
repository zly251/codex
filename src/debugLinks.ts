// src/debugLinks.ts
// 诊断：职位卡片中的链接格式

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

  // 提取前 3 个卡片的链接结构
  const links = await page.evaluate(() => {
    const cards = document.querySelectorAll(".job-card-box");
    return [...cards].slice(0, 3).map((c) => {
      // 所有 a 标签
      const allLinks = [...c.querySelectorAll("a")].map((a) => ({
        href: a.getAttribute("href") || "",
        text: (a.textContent || "").trim().slice(0, 30),
      }));

      // 可能包含职位名称和链接的元素
      const nameEl = c.querySelector("[class*=name], [class*=title]");
      const salaryEl = c.querySelector("[class*=salary]");
      const companyEl = c.querySelector("[class*=company]");

      return {
        html: c.innerHTML.slice(0, 300).replace(/</g, "&lt;"),
        links: allLinks,
        name: nameEl?.textContent?.trim?.()?.slice(0, 30) || "",
        salary: salaryEl?.textContent?.trim?.()?.slice(0, 20) || "",
        company: companyEl?.textContent?.trim?.()?.slice(0, 20) || "",
      };
    });
  });

  links.forEach((l, i) => {
    console.log(`\n[卡片 ${i + 1}]`);
    console.log(`  名称: ${l.name}`);
    console.log(`  薪资: ${l.salary}`);
    console.log(`  公司: ${l.company}`);
    console.log(`  链接数: ${l.links.length}`);
    l.links.forEach((lk, j) => {
      console.log(`    链接[${j}]: href="${lk.href}"  text="${lk.text}"`);
    });
  });

  await browser.disconnect();
}

main().catch(console.error);
