import fs from "fs";

const filePath = "E:\\autonomous-job-agent\\src\\scrapers\\bossScraper.ts";
const lines = fs.readFileSync(filePath, "utf-8").split("\n");

// Find the block to replace
let startIdx = -1, endIdx = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].trimEnd() === '    // 1. 从 URL 中提取 path，构造精确 CSS 选择器') startIdx = i;
  if (startIdx >= 0 && lines[i].trimEnd() === '      return null;' && i > startIdx) {
    if (i + 1 < lines.length && lines[i + 1].trimEnd() === '    }') {
      endIdx = i + 1;
      break;
    }
  }
}

if (startIdx < 0 || endIdx < 0) {
  console.error("❌ Block not found");
  process.exit(1);
}

console.log(`Replacing lines ${startIdx + 1}–${endIdx + 1}`);

const newBlock = [
  '    // 1. 从 URL 中提取 jobId 子串，构造精确 CSS 选择器',
  '    const jobId = url.match(/\\/job_detail\\/([^.?#]+)/)?.[1] || "";',
  '    if (!jobId) {',
  '      console.log(`  [bossScraper] ⚠️ 无法从 URL 提取 jobId: ${url.slice(0,60)}`);',
  '      return null;',
  '    }',
  '    const selector = `a[href*="${jobId}"]`;',
  '',
  '    // 先滚动到卡片可见区域',
  '    await page.evaluate((sel: string) => {',
  '      const el = document.querySelector(sel);',
  '      if (el) el.closest(".job-card-box")?.scrollIntoView({ block: "center" });',
  '    }, selector);',
  '    await sleep(500);',
  '',
  '    // 真实用户 click',
  '    try {',
  '      await page.click(selector, { timeout: 5000 });',
  '    } catch {',
  '      console.log(`  [bossScraper] ⚠️ 未找到匹配的职位卡片: ${url.slice(0,60)}`);',
  '      return null;',
  '    }',
];

const before = lines.slice(0, startIdx).join("\n");
const after = lines.slice(endIdx + 1).join("\n");
const newContent = before + "\n" + newBlock.join("\n") + "\n" + after;

fs.writeFileSync(filePath, newContent, "utf-8");
console.log("✅ Selector fixed: full pathname → jobId substring");
