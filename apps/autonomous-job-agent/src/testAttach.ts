// src/testAttach.ts
// 连接链路验证 — 使用 WebSocket 直连 Edge
// 输出当前所有 Page 列表 + 连接诊断

import puppeteer from "puppeteer-core";

const WS_ENDPOINT =
  "ws://127.0.0.1:9222/devtools/browser/11f52648-240e-45aa-901b-de4677e26d7f";

async function main() {
  console.log("=" .repeat(60));
  console.log("  BrowserManager 连接链路诊断");
  console.log("=" .repeat(60));

  // 1. 检查 json/version 状态
  console.log("\n[1/4] 检查 CDP HTTP 接口...");
  const verRes = await fetch("http://127.0.0.1:9222/json/version");
  const verJson = await verRes.json();
  console.log(`      Browser: ${verJson.Browser}`);
  console.log(`      Protocol: ${verJson["Protocol-Version"]}`);
  console.log(`      User: ${verJson.User}`);
  console.log(`      WebSocket: ${(verJson.webSocketDebuggerUrl || "").slice(0, 50)}...`);
  console.log("      ✅ HTTP 接口正常\n");

  // 2. 通过 WebSocket attach
  console.log("[2/4] 通过 WebSocket 连接...");
  const browser = await puppeteer.connect({
    browserWSEndpoint: WS_ENDPOINT,
    defaultViewport: null,
  });
  console.log(`      ✅ 连接成功`);
  console.log(`      Connected: ${browser.connected}\n`);

  // 3. 列出所有页面
  console.log("[3/4] 当前打开的 Pages:");
  const pages = await browser.pages();
  console.log(`      总数: ${pages.length}`);

  let hasChatGPT = false;
  for (const p of pages) {
    const url = p.url();
    const title = await p.title().catch(() => "(无标题)");
    const icon = url.includes("chatgpt.com")
      ? "🤖"
      : url.includes("zhipin.com")
        ? "💼"
        : url.includes("bing.com")
          ? "🔍"
          : url !== "about:blank"
            ? "📄"
            : "⬜";
    console.log(`       ${icon}  ${title.slice(0, 50)}`);
    console.log(`             ${url.slice(0, 80)}`);

    if (url.includes("chatgpt.com")) {
      hasChatGPT = true;
    }
  }

  console.log(`\n      ChatGPT 页面: ${hasChatGPT ? "✅ 已识别" : "❌ 未找到"}`);
  console.log(`      Boss直聘页面: ${pages.some((p) => p.url().includes("zhipin.com")) ? "✅ 已识别" : "❌ 未找到"}\n`);

  // 4. 验证 BrowserManager 可用性
  console.log("[4/4] BrowserManager 兼容性验证...");
  const wsEndpointUrl = verJson.webSocketDebuggerUrl;
  if (wsEndpointUrl && wsEndpointUrl.startsWith("ws://")) {
    console.log("      ✅ WebSocket 端点可用");
    console.log(`      协议: ws`);
    console.log(`      自动重连: 支持（需集成 BrowserManager）`);
  } else {
    console.log("      ❌ WebSocket 端点异常");
  }

  console.log("\n" + "=".repeat(60));
  console.log("  诊断完成");
  console.log("=".repeat(60));

  await browser.disconnect();
}

main().catch((err) => {
  console.error(`\n❌ 诊断失败: ${err.message}`);
  process.exit(1);
});
