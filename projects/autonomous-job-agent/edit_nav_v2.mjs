import fs from "fs";

const filePath = "E:\\autonomous-job-agent\\src\\scrapers\\bossScraper.ts";
let content = fs.readFileSync(filePath, "utf-8");

// ── Edit A: framenavigated with MAIN/SUB ──
const markerA = "p.on(\"framenavigated\", (f: any) => {";
const idxA = content.indexOf(markerA);
const lineEndA = content.indexOf(");", idxA);
const lineEndA2 = content.indexOf(");", lineEndA + 1);
const oldA = content.substring(idxA, lineEndA2 + 2);
const newA = oldA.replace(
  "console.log(\`  [bossScraper] [evt] framenavigated → \${u}\`);",
  "const isMain = f.isMainFrame?.() ?? \"?\";\n      console.log(\`  [bossScraper] [evt] framenavigated \${isMain ? \"MAIN\" : \"SUB\"} → \${u}\`);"
);
content = content.replace(oldA, newA);
console.log("✅ Edit A applied");

// ── Edit B: URL checks after goto + +1s +2s +5s ──
const idxB = content.indexOf("goto done");
const blockStart = content.lastIndexOf("\n", idxB - 3);
const findFor = content.indexOf("for (let i = 0; i < 10; i++)", idxB);
const findClose = content.indexOf("}", findFor);
const closeBrace = content.indexOf("}", findClose + 1);
const oldB = content.substring(blockStart + 1, closeBrace + 1);

const newB = `    console.log(\`  [bossScraper] [NAV] goto done, 等待内容稳定...\`);
    console.log(\`  [bossScraper] [NAV] url after goto: \${dp.url()}\`);
    // 稳定等待：最多 5 秒，每 500ms 检查一次 container
    for (let i = 0; i < 10; i++) {
      if (await checkDetailContainer(dp)) return "OK";
      await sleep(500);
      if (i === 1) console.log(\`  [bossScraper] [NAV] url at +1s: \${dp.url()}\`);
      if (i === 3) console.log(\`  [bossScraper] [NAV] url at +2s: \${dp.url()}\`);
    }
    console.log(\`  [bossScraper] [NAV] url at +5s: \${dp.url()}\`);`;

content = content.replace(oldB, newB);
console.log("✅ Edit B applied");

fs.writeFileSync(filePath, content, "utf-8");
console.log("✅ All done");
