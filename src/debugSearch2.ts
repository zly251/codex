// src/debugSearch2.ts
// 诊断：复用已有 Boss 页面后，page.goto 到搜索页是否被拦截

import puppeteer from "puppeteer-core";

async function main() {
  const browser = await puppeteer.connect({
    browserURL: "http://127.0.0.1:9222",
    defaultViewport: null,
  });

  // 找到已有的 Boss 页面
  const pages = await browser.pages();
  const bossPage = pages.find(
    (p) => p.url().includes("zhipin.com") && !p.url().includes("/user/")
  );

  if (!bossPage) {
    console.log("❌ 未找到 Boss 页面");
    await browser.disconnect();
    return;
  }

  console.log("复用页面:", bossPage.url().slice(0, 80));
  console.log("页面标题:", (await bossPage.title()).slice(0, 40));

  // 尝试在当前页面导航到搜索 URL（同域，应不触反爬）
  const searchUrl =
    "https://www.zhipin.com/web/geek/job?query=Java&city=101210600";
  console.log("\n导航到搜索页:", searchUrl);

  try {
    await bossPage.goto(searchUrl, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
    console.log("导航完成");

    await new Promise((r) => setTimeout(r, 2000));

    console.log("当前URL:", bossPage.url());
    console.log("页面标题:", await bossPage.title().catch(() => "?"));

    const text = await bossPage
      .evaluate(() => document.body?.innerText?.slice(0, 200) || "")
      .catch(() => "读取失败");
    console.log("页面文字:", text.replace(/\n/g, " | "));

    const cards = await bossPage.evaluate(() => {
      const sel = "[class*=job-card], [class*=card-wrapper]";
      return document.querySelectorAll(sel).length;
    });
    console.log(`[class*=job-card] 数量: ${cards}`);
  } catch (e: any) {
    console.log("导航失败:", e.message?.slice(0, 60));
  }

  await browser.disconnect();
}

main().catch(console.error);
