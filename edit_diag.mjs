import fs from "fs";

const filePath = "E:\\autonomous-job-agent\\src\\scrapers\\bossScraper.ts";
let content = fs.readFileSync(filePath, "utf-8");

// Find the exact block: [BLOCKED] logs + screenshot + return "BLOCKED"
const marker = `    console.log(\`  [bossScraper] ⛔ [BLOCKED] 5s 内未检测到 job container\`);
    try { await dp.screenshot({ path: \`E:\\\\autonomous-job-agent\\\\temp\\\\blocked_\${Date.now()}.png\` }).catch(() => {}); } catch {}
    return "BLOCKED";`;

const newBlock = `    console.log(\`  [bossScraper] ⛔ [BLOCKED] 5s 内未检测到 job container\`);
    // ─── 诊断日志（页面真实内容） ───
    const diagTitle = await dp.title().catch(() => "?");
    const diagInnerText = await dp.evaluate(\`document.body?.innerText?.slice(0,1000) || ""\`).catch(() => "读取失败");
    const diagInnerHtml = await dp.evaluate(\`document.body?.innerHTML?.slice(0,3000) || ""\`).catch(() => "读取失败");
    const diagIframeSrcs = await dp.evaluate(\`(() => {
      const iframes = document.querySelectorAll('iframe');
      return [...iframes].map(f => f.src || f.getAttribute('src') || '').filter(Boolean);
    })()\`).catch(() => []);
    const diagElCount = await dp.evaluate(\`document.querySelectorAll('*').length\`).catch(() => -1);
    const diagUrl = dp.url();
    console.log(\`  [bossScraper] [DIAG] url: \${diagUrl}\`);
    console.log(\`  [bossScraper] [DIAG] title: \${diagTitle}\`);
    console.log(\`  [bossScraper] [DIAG] elementCount: \${diagElCount}\`);
    console.log(\`  [bossScraper] [DIAG] iframeSrcs: [\${diagIframeSrcs.join(", ")}]\`);
    console.log(\`  [bossScraper] [DIAG] innerText(1000): \${diagInnerText.replace(/\\n/g," | ").slice(0,300)}\`);
    console.log(\`  [bossScraper] [DIAG] innerHTML(3000): \${diagInnerHtml.replace(/\\n/g," | ").slice(0,300)}\`);
    try { await dp.screenshot({ path: \`E:\\\\autonomous-job-agent\\\\temp\\\\blocked_\${Date.now()}.png\` }).catch(() => {}); } catch {}
    return "BLOCKED";`;

if (!content.includes(marker)) {
  console.error("❌ Could not find the exact marker text in file");
  process.exit(1);
}

content = content.replace(marker, newBlock);
fs.writeFileSync(filePath, content, "utf-8");
console.log("✅ Diagnostics added to BLOCKED path");
