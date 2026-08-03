import fs from "fs";

const filePath = "E:\\autonomous-job-agent\\src\\scrapers\\bossScraper.ts";
const lines = fs.readFileSync(filePath, "utf-8").split("\n");

// Find the exact line range of the evaluate click block
const startMarker = '    // 1. 从 URL 中提取 path，找到对应卡片并点击';
const endMarker = '      return null;';
const afterEndMarker = '    }';

let startIdx = -1;
let endIdx = -1;

for (let i = 0; i < lines.length; i++) {
  if (lines[i].trimEnd() === startMarker) startIdx = i;
  // The block ends with "    }" after "      return null;"
  if (startIdx >= 0 && lines[i].trimEnd() === "      return null;") {
    // Next line should be the closing }
    if (i + 1 < lines.length && lines[i + 1].trimEnd() === afterEndMarker) {
      endIdx = i + 1;
      break;
    }
  }
}

if (startIdx < 0 || endIdx < 0) {
  console.error("❌ Block boundaries not found");
  process.exit(1);
}

const oldBlockLines = lines.slice(startIdx, endIdx + 1);
console.log(`Found block: lines ${startIdx + 1} to ${endIdx + 1} (${oldBlockLines.length} lines)`);

const newBlockLines = [
  '    // 1. 从 URL 中提取 path，构造精确 CSS 选择器',
  '    let hrefPart: string;',
  '    try { hrefPart = new URL(url).pathname; } catch { hrefPart = url; }',
  '    const selector = `a[href*="${hrefPart}"]`;',
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

// Replace
const oldContent = lines.join("\n");
const before = lines.slice(0, startIdx).join("\n");
const after = lines.slice(endIdx + 1).join("\n");
const newContent = before + "\n" + newBlockLines.join("\n") + "\n" + after;

fs.writeFileSync(filePath, newContent, "utf-8");
console.log("✅ Patch applied: evaluate click → page.click");
console.log(`Removed ${oldBlockLines.length} lines, added ${newBlockLines.length} lines`);
