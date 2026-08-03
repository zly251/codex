import fs from "fs";

const filePath = "E:\\autonomous-job-agent\\src\\scrapers\\bossScraper.ts";
const lines = fs.readFileSync(filePath, "utf-8").split("\n");

// Find the exact block to replace (lines 199-220)
let startIdx = -1, endIdx = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].trimEnd() === "    // 1. 从 URL 中提取 jobId 子串，构造精确 CSS 选择器") startIdx = i;
  if (startIdx >= 0 && lines[i].trimEnd() === "      return null;" && i > startIdx) {
    if (i + 1 < lines.length && lines[i + 1].trimEnd() === "    }") {
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
  '    // 1. 从 URL 提取 jobId，遍历 DOM 匹配链接并原生点击',
  '    const jobId = url.match(/\\/job_detail\\/([^.?#]+)/)?.[1] || "";',
  '    if (!jobId) {',
  '      console.log(`  [bossScraper] ⚠️ 无法从 URL 提取 jobId: ${url.slice(0,60)}`);',
  '      return null;',
  '    }',
  '',
  '    const clicked = await page.evaluate((id: string) => {',
  '      const links = document.querySelectorAll(\'a[href*="/job_detail/"]\');',
  '      for (const link of links) {',
  '        const href = link.getAttribute("href") || "";',
  '        if (href.includes(id)) {',
  '          const card = link.closest(".job-card-box") || link;',
  '          card.scrollIntoView({ block: "center" });',
  '          (link as HTMLAnchorElement).click();',
  '          return true;',
  '        }',
  '      }',
  '      return false;',
  '    }, jobId);',
  '',
  '    if (!clicked) {',
  '      console.log(`  [bossScraper] ⚠️ 未找到匹配的职位卡片: ${url.slice(0,60)}`);',
  '      return null;',
  '    }',
  '    await sleep(500);',
];

const before = lines.slice(0, startIdx).join("\n");
const after = lines.slice(endIdx + 1).join("\n");
const newContent = before + "\n" + newBlock.join("\n") + "\n" + after;

fs.writeFileSync(filePath, newContent, "utf-8");
console.log("✅ Selector fixed: CSS selector → DOM traversal + native click");
