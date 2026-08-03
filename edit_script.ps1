param(
    [string]$filePath = "E:\autonomous-job-agent\src\scrapers\bossScraper.ts"
)

# Read the file
$content = Get-Content $filePath -Raw

# --- Edit 1: Remove createBrowserContext branch in getPooledPage ---
$old1 = @'
  detailPoolPage = await browser.newPage();
  // 独立 context（防止 attach mode 污染）
  try {
    const ctx = await browser.createBrowserContext?.();
    if (ctx) {
      detailPoolPage = await ctx.newPage();
      console.log(`  [bossScraper] 🆕 创建新 detail page (独立 context)`);
    } else {
      detailPoolPage = await browser.newPage();
      console.log(`  [bossScraper] 🆕 创建新 detail page (默认 context)`);
    }
  } catch {
    detailPoolPage = await browser.newPage();
    console.log(`  [bossScraper] 🆕 创建新 detail page (默认 context)`);
  }
'@

$new1 = @'
  detailPoolPage = await browser.newPage();
  console.log(`  [bossScraper] 🆕 创建新 detail page (默认 context)`);
'@

$content = $content -replace [regex]::Escape($old1), $new1

# --- Edit 2: Add diagnostics in security block ---
$old2 = @'
      if (isSecurity || diagText.includes("验证") || diagText.includes("安全检查")) {
        console.log(`  [bossScraper] ⚠️ 安全页拦截`);
        try { await dp.screenshot({ path: `E:\autonomous-job-agent\temp\security_${Date.now()}.png` }).catch(() => {}); } catch {}
      }
'@

$new2 = @'
      if (isSecurity || diagText.includes("验证") || diagText.includes("安全检查")) {
        console.log(`  [bossScraper] ⚠️ 安全页拦截`);
        // ─── 诊断日志 ───
        const secUrl = dp.url();
        const secTitle = await dp.title().catch(() => "?");
        const secCookieLen = await dp.evaluate(`document.cookie.length`).catch(() => -1);
        const secBody = await dp.evaluate(`document.body?.innerText?.slice(0,500) || ""`).catch(() => "读取失败");
        const hasIframe = await dp.evaluate(`document.querySelector('iframe') !== null`).catch(() => false);
        const secHtmlSnippet = await dp.evaluate(`document.body?.innerHTML?.slice(0,500) || ""`).catch(() => "读取失败");
        let sameContext = "未知";
        try {
          const ctxA = page.browserContext?.();
          const ctxB = dp.browserContext?.();
          sameContext = (ctxA && ctxB && ctxA === ctxB) ? "是" : "否";
        } catch { sameContext = "比较失败"; }
        console.log(`  [bossScraper] [DIAG] url: ${secUrl}`);
        console.log(`  [bossScraper] [DIAG] title: ${secTitle}`);
        console.log(`  [bossScraper] [DIAG] cookie.length: ${secCookieLen}`);
        console.log(`  [bossScraper] [DIAG] body(500): ${secBody.replace(/\n/g," | ").slice(0,200)}`);
        console.log(`  [bossScraper] [DIAG] has iframe: ${hasIframe}`);
        console.log(`  [bossScraper] [DIAG] same context as search page: ${sameContext}`);
        try { await dp.screenshot({ path: `E:\autonomous-job-agent\temp\security_${Date.now()}.png` }).catch(() => {}); } catch {}
      }
'@

$content = $content -replace [regex]::Escape($old2), $new2

# Write back
[System.IO.File]::WriteAllText($filePath, $content, [System.Text.UTF8Encoding]::new($false))
Write-Host "Done. Changes applied."
