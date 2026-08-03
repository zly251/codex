import fs from "fs";

const filePath = "E:\\autonomous-job-agent\\src\\scrapers\\bossScraper.ts";
const lines = fs.readFileSync(filePath, "utf-8").split("\n");

// Fix line 207 - use Array.from with proper quote nesting
lines[206] = "      const links = Array.from(document.querySelectorAll('a[href*=\"/job_detail/\"]'));";

fs.writeFileSync(filePath, lines.join("\n"), "utf-8");
console.log("✅ Fixed:", lines[206]);
