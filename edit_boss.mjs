import fs from "fs";

const filePath = "E:\\autonomous-job-agent\\src\\scrapers\\bossScraper.ts";
let content = fs.readFileSync(filePath, "utf-8");

// Find the security block by looking for the marker
const marker = "isSecurity || diagText.includes";
const idx = content.indexOf(marker);
if (idx < 0) {
  console.error("❌ Could not find security block marker");
  process.exit(1);
}

// Find the full block: from "if (isSecurity..." to the closing "}" before "let detail"
const blockStart = content.lastIndexOf("if (", idx);
const afterBlock = content.indexOf("let detail", idx);
if (blockStart < 0 || afterBlock < 0) {
  console.error("❌ Could not find block boundaries");
  process.exit(1);
}

const oldBlock = content.substring(blockStart, afterBlock).trimEnd();
console.log("Found security block:");
console.log(oldBlock);
console.log("---");

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

content = content.replace(oldBlock, newBlock);

fs.writeFileSync(filePath, content, "utf-8");
console.log("✅ Edit 2 applied successfully");
