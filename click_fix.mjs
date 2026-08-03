import fs from "fs";

const filePath = "E:\\autonomous-job-agent\\src\\scrapers\\bossScraper.ts";
let content = fs.readFileSync(filePath, "utf-8");

const oldBlock = `    // 1. 从 URL 中提取 path，找到对应卡片并点击
    let hrefPart: string;
    try { hrefPart = new URL(url).pathname; } catch { hrefPart = url; }
    // 简单转义特殊字符用于选择器
    const safeHref = hrefPart.replace(/[.*+?^$\{}()|[\]\\]/g, "\\$&");

    const clicked = await page.evaluate((part: string) => {
      const link = document.querySelector(\`a[href*='\${part}']\`) as HTMLAnchorElement | null;
      if (!link) return false;
      const card = link.closest(".job-card-box") || link;
      card.scrollIntoView({ block: "center" });
      link.click();
      return true;
    }, safeHref);

    if (!clicked) {
      console.log(\`  [bossScraper] ⚠️ 未找到匹配的职位卡片: \${url.slice(0,60)}\`);
      return null;
    }`;

const newBlock = `    // 1. 从 URL 中提取 path，构造精确 CSS 选择器
    let hrefPart: string;
    try { hrefPart = new URL(url).pathname; } catch { hrefPart = url; }
    const selector = \`a[href*="\${hrefPart}"]\`;

    // 先滚动到卡片可见区域
    await page.evaluate((sel: string) => {
      const el = document.querySelector(sel);
      if (el) el.closest(".job-card-box")?.scrollIntoView({ block: "center" });
    }, selector);
    await sleep(500);

    // 真实用户 click
    try {
      await page.click(selector, { timeout: 5000 });
    } catch {
      console.log(\`  [bossScraper] ⚠️ 未找到匹配的职位卡片: \${url.slice(0,60)}\`);
      return null;
    }`;

if (!content.includes(oldBlock)) {
  console.error("❌ oldBlock not found in file");
  process.exit(1);
}

content = content.replace(oldBlock, newBlock);
fs.writeFileSync(filePath, content, "utf-8");
console.log("✅ Patch applied: evaluate click → page.click");
