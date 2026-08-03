import fs from "fs";

const filePath = "E:\\autonomous-job-agent\\src\\scrapers\\bossScraper.ts";
let content = fs.readFileSync(filePath, "utf-8");

// Fix line 321: the oldB replacement left trailing garbage
const corruption = `console.log(\`  [bossScraper] [NAV] url at +5s: \${dp.url()}\`);)()\`).catch(() => []);`;
const fixed = `console.log(\`  [bossScraper] [NAV] url at +5s: \${dp.url()}\`);`;

if (content.includes(corruption)) {
  content = content.replace(corruption, fixed);
  console.log("✅ Corrupted text fixed on +5s line");
} else {
  console.log("⚠️ Could not find corruption - showing context:");
  const idx5s = content.indexOf("url at +5s");
  if (idx5s >= 0) {
    console.log(content.substring(idx5s, idx5s + 80));
  }
}

// Check that the next diagnostics block is intact
const idxDiag = content.indexOf("const diagElCount");
if (idxDiag >= 0) {
  const before = content.substring(Math.max(0, idxDiag - 5), idxDiag);
  console.log("Before diagElCount:", JSON.stringify(before));
}

fs.writeFileSync(filePath, content, "utf-8");
console.log("✅ File saved");
