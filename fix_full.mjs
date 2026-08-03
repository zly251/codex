import fs from "fs";

const filePath = "E:\\autonomous-job-agent\\src\\scrapers\\bossScraper.ts";
let content = fs.readFileSync(filePath, "utf-8");

// Find the detailGoto function body and replace it completely
const funcStart = "async function detailGoto(label: string, dp: any, targetUrl: string, browser: any): Promise<\"OK\" | \"BLOCKED\"> {";
const funcEnd = "// ─── blocked rate 健康监控 ───";

const idxStart = content.indexOf(funcStart);
const idxEnd = content.indexOf(funcEnd);

if (idxStart < 0 || idxEnd < 0) {
  console.error("❌ Could not find function boundaries");
  process.exit(1);
}

const newFuncBody = `async function detailGoto(label: string, dp: any, targetUrl: string, browser: any): Promise<"OK" | "BLOCKED"> {
  try {
    console.log(\`  [bossScraper] [NAV] target=\${targetUrl.slice(0,60)}\`);
    await dp.goto(targetUrl, { waitUntil: "networkidle0", timeout: 30000 });
    console.log(\`  [bossScraper] [NAV] goto done, 等待内容稳定...\`);
    console.log(\`  [bossScraper] [NAV] url after goto: \${dp.url()}\`);
    // 稳定等待：最多 5 秒，每 500ms 检查一次 container
    for (let i = 0; i < 10; i++) {
      if (await checkDetailContainer(dp)) return "OK";
      await sleep(500);
      if (i === 1) console.log(\`  [bossScraper] [NAV] url at +1s: \${dp.url()}\`);
      if (i === 3) console.log(\`  [bossScraper] [NAV] url at +2s: \${dp.url()}\`);
    }
    console.log(\`  [bossScraper] [NAV] url at +5s: \${dp.url()}\`);
    console.log(\`  [bossScraper] ⛔ [BLOCKED] 5s 内未检测到 job container\`);
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
    // ─── 诊断：检查所有 browser contexts/pages ───
    const ctxPages = await (async () => {
      try {
        const contexts = browser.browserContexts();
        const result = [];
        for (const ctx of contexts) {
          const pages = await ctx.pages();
          const pageInfos = pages.map((p: any) => ({
            url: p.url()?.slice(0,100) || "",
            isClosed: p.isClosed?.() || false,
          }));
          result.push({ pages: pageInfos });
        }
        return JSON.stringify(result);
      } catch { return "读取失败"; }
    })();
    console.log(\`  [bossScraper] [DIAG] url: \${diagUrl}\`);
    console.log(\`  [bossScraper] [DIAG] title: \${diagTitle}\`);
    console.log(\`  [bossScraper] [DIAG] elementCount: \${diagElCount}\`);
    console.log(\`  [bossScraper] [DIAG] iframeSrcs: [\${diagIframeSrcs.join(", ")}]\`);
    console.log(\`  [bossScraper] [DIAG] innerText(1000): \${diagInnerText.replace(/\\n/g," | ").slice(0,300)}\`);
    console.log(\`  [bossScraper] [DIAG] innerHTML(3000): \${diagInnerHtml.replace(/\\n/g," | ").slice(0,300)}\`);
    console.log(\`  [bossScraper] [DIAG] allContextsPages: \${ctxPages}\`);
    try { await dp.screenshot({ path: \`E:\\\\autonomous-job-agent\\\\temp\\\\blocked_\${Date.now()}.png\` }).catch(() => {}); } catch {}
    return "BLOCKED";
  } catch (e: any) {
    console.error(\`  [bossScraper] [NAV] goto 异常(\${label}): \${e.message?.slice(0,80)}\`);
    try { await replacePooledPage(browser); } catch {}
    return "BLOCKED";
  }
}`;

const oldFuncContent = content.substring(idxStart, idxEnd);
content = content.replace(oldFuncContent, newFuncBody);

fs.writeFileSync(filePath, content, "utf-8");
console.log("✅ detailGoto fully rewritten with all diagnostics intact");
