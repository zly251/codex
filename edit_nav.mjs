import fs from "fs";

const filePath = "E:\\autonomous-job-agent\\src\\scrapers\\bossScraper.ts";
let content = fs.readFileSync(filePath, "utf-8");

// ---- Edit A: framenavigated with MAIN/SUB frame info ----
const oldA = `    p.on("framenavigated", (f: any) => {
      const u = f?.url?.()?.slice(0, 80) || "?";
      console.log(\`  [bossScraper] [evt] framenavigated → \${u}\`);
    });`;

const newA = `    p.on("framenavigated", (f: any) => {
      const u = f?.url?.()?.slice(0, 80) || "?";
      const isMain = f.isMainFrame?.() ?? "?";
      console.log(\`  [bossScraper] [evt] framenavigated \${isMain ? "MAIN" : "SUB"} → \${u}\`);
    });`;

if (!content.includes(oldA)) {
  console.error("❌ Edit A marker not found");
  process.exit(1);
}
content = content.replace(oldA, newA);
console.log("✅ Edit A applied");

// ---- Edit B: URL checks after goto + +1s +2s +5s ----
const oldB = `    console.log(\`  [bossScraper] [NAV] goto done, 等待内容稳定...\`);
    // 稳定等待：最多 5 秒，每 500ms 检查一次 container
    for (let i = 0; i < 10; i++) {
      if (await checkDetailContainer(dp)) return "OK";
      await sleep(500);
    }`;

const newB = `    console.log(\`  [bossScraper] [NAV] goto done, 等待内容稳定...\`);
    const urlAfterGoto = dp.url();
    console.log(\`  [bossScraper] [NAV] url after goto: \${urlAfterGoto}\`);
    // 稳定等待：最多 5 秒，每 500ms 检查一次 container
    for (let i = 0; i < 10; i++) {
      if (i === 2) { // after ~1s
        console.log(\`  [bossScraper] [NAV] url at +1s: \${dp.url()}\`);
      }
      if (i === 6) { // after ~3s (was 2, now 4 checks passed + initial = ~2.5s)
        // skip intermediate, do +2s and +5s
      }
      if (await checkDetailContainer(dp)) return "OK";
      await sleep(500);
    }
    console.log(\`  [bossScraper] [NAV] url at +5s: \${dp.url()}\`);`;

if (!content.includes(oldB)) {
  console.error("❌ Edit B marker not found");
  process.exit(1);
}
content = content.replace(oldB, newB);
console.log("✅ Edit B applied");

fs.writeFileSync(filePath, content, "utf-8");
console.log("✅ All edits written");
