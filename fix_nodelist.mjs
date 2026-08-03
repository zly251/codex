import fs from "fs";

const filePath = "E:\\autonomous-job-agent\\src\\scrapers\\bossScraper.ts";
const lines = fs.readFileSync(filePath, "utf-8").split("\n");

// Line 207 (0-indexed: 206) needs to be fixed
const oldLine = lines[206];
console.log("Old line 207:", oldLine);

// Fix: wrap with [... ]
const newLine = `      const links = [...document.querySelectorAll('a[href*="/job_detail/"]')];`;
console.log("New line 207:", newLine);

lines[206] = newLine;
fs.writeFileSync(filePath, lines.join("\n"), "utf-8");
console.log("✅ NodeList spread fix applied");
