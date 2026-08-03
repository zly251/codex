// src/debugPages.ts
// 列出 Edge 中所有已打开的页面

import puppeteer from "puppeteer-core";

async function main() {
  const browser = await puppeteer.connect({
    browserURL: "http://127.0.0.1:9222",
    defaultViewport: null,
  });

  const pages = await browser.pages();
  console.log(`Edge 中打开了 ${pages.length} 个页面:\n`);

  for (const p of pages) {
    const url = p.url();
    const title = (await p.title().catch(() => "?")) || "?";
    const icon = url.includes("zhipin.com")
      ? "💼"
      : url.includes("chatgpt.com")
        ? "🤖"
        : url.includes("bing.com")
          ? "🔍"
          : url !== "about:blank"
            ? "📄"
            : "⬜";
    console.log(`  ${icon}  ${title.slice(0, 50)}`);
    console.log(`       ${url.slice(0, 90)}`);
  }

  // 检查是否有 Boss 页面的 cookie
  const bossPages = pages.filter((p) => p.url().includes("zhipin.com"));
  if (bossPages.length > 0) {
    console.log("\n✅ Boss直聘页面已打开");
    const cookies = await bossPages[0].cookies().catch(() => []);
    const hasSession = cookies.some((c) => c.name.includes("session") || c.name.includes("token"));
    console.log(`   会话Cookie: ${hasSession ? "✅ 有效" : "❌ 已过期"}`);
  } else {
    console.log("\n❌ 未打开 Boss直聘页面");
    console.log("   请在 Edge 中打开 https://www.zhipin.com 并登录");
  }

  await browser.disconnect();
}

main().catch(console.error);
