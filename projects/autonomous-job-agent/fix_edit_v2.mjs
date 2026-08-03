import fs from "fs";
import iconv from "iconv-lite";

const filePath = "E:\\autonomous-job-agent\\src\\scrapers\\bossScraper.ts";

// Try to detect encoding and decode
const buf = fs.readFileSync(filePath);
let content = iconv.decode(buf, "gbk");

// Verify by checking for a known string
if (content.includes("Boss直聘爬虫")) {
  console.log("✅ GBK decode successful");
} else {
  console.log("⚠️ GBK decode may not be correct, trying utf-8 fallback...");
  content = buf.toString("utf-8");
}

// ---- Edit 1: Remove createBrowserContext branch ----
const searchStr1 = `  // 独立 context（防止 attach mode 污染）
  try {
    const ctx = await browser.createBrowserContext?.();`;

if (content.includes(searchStr1)) {
  console.log("✅ Edit 1 - pattern found");
  
  const oldText1 = `  detailPoolPage = await browser.newPage();
  // 独立 context（防止 attach mode 污染）
  try {
    const ctx = await browser.createBrowserContext?.();
    if (ctx) {
      detailPoolPage = await ctx.newPage();
      console.log(\`  [bossScraper] 🆕 创建新 detail page (独立 context)\`);
    } else {
      detailPoolPage = await browser.newPage();
      console.log(\`  [bossScraper] 🆕 创建新 detail page (默认 context)\`);
    }
  } catch {
    detailPoolPage = await browser.newPage();
    console.log(\`  [bossScraper] 🆕 创建新 detail page (默认 context)\`);
  }`;

  const newText1 = `  detailPoolPage = await browser.newPage();
  console.log(\`  [bossScraper] 🆕 创建新 detail page (默认 context)\`);`;

  content = content.replace(oldText1, newText1);
  console.log("✅ Edit 1 applied");
} else {
  console.log("❌ Edit 1 - pattern NOT found - trying direct search");
  const idx1 = content.indexOf("createBrowserContext");
  if (idx1 >= 0) {
    console.log("createBrowserContext found at index", idx1);
    const blockStart = content.lastIndexOf("await browser.newPage();", idx1);
    const blockEnd = content.indexOf("attachPageLifecycleLogging(detailPoolPage);", idx1);
    if (blockStart >= 0 && blockEnd >= 0) {
      const fullBlock = content.substring(blockStart, blockEnd);
      console.log("Block to replace:", fullBlock.slice(0, 80));
      const replacement = `  detailPoolPage = await browser.newPage();
  console.log(\`  [bossScraper] 🆕 创建新 detail page (默认 context)\`);`;
      content = content.substring(0, blockStart) + replacement + content.substring(blockEnd);
      console.log("✅ Edit 1 applied (fallback)");
    }
  } else {
    console.log("❌ createBrowserContext not found at all");
  }
}

// ---- Edit 2: Replace security block ----
const searchStr2 = `if (isSecurity || diagText.includes`;
const idx2 = content.indexOf(searchStr2);
if (idx2 >= 0) {
  console.log("✅ Edit 2 - pattern found at index", idx2);
  const lineStart = content.lastIndexOf("\n", idx2) + 1;
  const afterBlock = content.indexOf("let detail", idx2);
  if (afterBlock >= 0) {
    const closeBrace = content.lastIndexOf("}", afterBlock);
    if (closeBrace >= idx2) {
      const oldBlock = content.substring(lineStart, closeBrace + 1);
      console.log("Old block:", oldBlock.slice(0, 100));
      const newBlock = `      if (isSecurity || diagText.includes("验证") || diagText.includes("安全检查")) {
        console.log(\`  [bossScraper] ⚠️ 安全页拦截\`);
        // ─── 诊断日志 ───
        const secUrl = dp.url();
        const secTitle = await dp.title().catch(() => "?");
        const secCookieLen = await dp.evaluate(\`document.cookie.length\`).catch(() => -1);
        const secBody = await dp.evaluate(\`document.body?.innerText?.slice(0,500) || ""\`).catch(() => "读取失败");
        const hasIframe = await dp.evaluate(\`document.querySelector('iframe') !== null\`).catch(() => false);
        const secHtmlSnippet = await dp.evaluate(\`document.body?.innerHTML?.slice(0,500) || ""\`).catch(() => "读取失败");
        let sameContext = "未知";
        try {
          const ctxA = page.browserContext?.();
          const ctxB = dp.browserContext?.();
          sameContext = (ctxA && ctxB && ctxA === ctxB) ? "是" : "否";
        } catch { sameContext = "比较失败"; }
        console.log(\`  [bossScraper] [DIAG] url: \${secUrl}\`);
        console.log(\`  [bossScraper] [DIAG] title: \${secTitle}\`);
        console.log(\`  [bossScraper] [DIAG] cookie.length: \${secCookieLen}\`);
        console.log(\`  [bossScraper] [DIAG] body(500): \${secBody.replace(/\\n/g," | ").slice(0,200)}\`);
        console.log(\`  [bossScraper] [DIAG] has iframe: \${hasIframe}\`);
        console.log(\`  [bossScraper] [DIAG] same context as search page: \${sameContext}\`);
        try { await dp.screenshot({ path: \`E:\\\\autonomous-job-agent\\\\temp\\\\security_\${Date.now()}.png\` }).catch(() => {}); } catch {}
      }`;
      content = content.substring(0, lineStart) + newBlock + content.substring(closeBrace + 1);
      console.log("✅ Edit 2 applied");
    } else {
      console.log("❌ Could not find closing brace");
    }
  }
} else {
  console.log("❌ Edit 2 - pattern NOT found");
}

// Write back as UTF-8
const outputBuf = iconv.encode(content, "utf-8");
fs.writeFileSync(filePath, outputBuf);
console.log("✅ File written successfully");
console.log("Verify - createBrowserContext:", content.includes("createBrowserContext") ? "❌" : "✅");
console.log("Verify - [DIAG]:", content.includes("[DIAG]") ? "✅" : "❌");
console.log("Verify - sameContext:", content.includes("sameContext") ? "✅" : "❌");
