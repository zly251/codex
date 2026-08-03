// Autonomous Job Search Agent
// Resume import script
// Usage: npx tsx scripts/import-resume.ts <file> [-n name] [-t tags] [-d] [--target role]

import { createWorker } from "tesseract.js";
import { readFileSync, existsSync } from "node:fs";
import { extname, basename, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { initDb } from "../src/db/index.js";
import * as resume from "../src/db/resume.js";
import { extractSkills } from "../src/utils/skills.js";

var __dirname = dirname(fileURLToPath(import.meta.url));
var TESSDATA = resolve(__dirname, "../tessdata") + "/";

var IMG = [".png", ".jpg", ".jpeg", ".bmp", ".webp"];
var TXT = [".txt", ".md"];

export function isImage(p) { return IMG.indexOf(extname(p).toLowerCase()) !== -1; }
export function isText(p) { return TXT.indexOf(extname(p).toLowerCase()) !== -1; }

export async function ocrImage(imagePath) {
  try {
    console.log("  [OCR] Loading local language data...");
    var w = await createWorker("chi_sim+eng", 1, {
      langPath: TESSDATA,
      gzip: true,
      logger: function(m) { if (m.status === "recognizing text") { process.stdout.write("."); } },
    });
    console.log("  [OCR] Recognizing...");
    var r = await w.recognize(imagePath);
    await w.terminate();
    var text = r.data.text || "";
    console.log("");
    console.log("  [OCR] Done: " + text.length + " chars");
    return text;
  } catch(e) {
    console.error("  [OCR] Failed: " + e.message);
    return null;
  }
}

export function parseArgs() {
  var opts = { filePath: null, name: null, tags: null, isDefault: false, targetRole: null };
  for (var i = 2; i < process.argv.length; i++) {
    var a = process.argv[i];
    if (a === "-n" || a === "--name") { i++; opts.name = process.argv[i]; }
    else if (a === "-t" || a === "--tags") { i++; opts.tags = process.argv[i]; }
    else if (a === "-d" || a === "--default") { opts.isDefault = true; }
    else if (a === "--target") { i++; opts.targetRole = process.argv[i]; }
    else { opts.filePath = a; }
  }
  return opts;
}

async function main() {
  var opts = parseArgs();
  if (!opts.filePath) {
    console.log("Usage: npx tsx scripts/import-resume.ts <file> [-n name] [-t tags] [-d] [--target role]");
    process.exit(1);
  }

  var fp = resolve(opts.filePath);
  if (!existsSync(fp)) { console.error("File not found: " + fp); process.exit(1); }
  console.log("File: " + fp);

  var text = null;
  if (isImage(fp)) {
    console.log("[OCR] Processing image...");
    text = await ocrImage(fp);
    if (!text) { console.error("OCR failed."); process.exit(1); }
  } else if (isText(fp)) {
    text = readFileSync(fp, "utf8");
    console.log("Text: " + text.length + " chars");
  } else {
    console.error("Unsupported file. Use .txt .md .png .jpg .jpeg .bmp .webp");
    process.exit(1);
  }

  var skills = extractSkills(text);
  console.log("Skills: " + (skills.length > 0 ? skills.join(", ") : "(none)"));

  initDb();
  var r = resume.create({
    name: opts.name || basename(fp, extname(fp)),
    targetRole: opts.targetRole || "",
    tags: opts.tags || "",
    isDefault: opts.isDefault,
    rawText: text.slice(0, 10000),
    filePath: fp,
    fileType: isImage(fp) ? "ocr" : "txt",
    skills: skills.join(","),
  });

  console.log("");
  console.log("OK! Resume imported:");
  console.log("  ID: " + r.id);
  console.log("  Name: " + r.name);
  console.log("  Skills: " + (r.skills || "(none)"));
  console.log("  Tags: " + (r.tags || "(none)"));
  console.log("");
}

main().catch(function(e) { console.error("Error: " + e.message); process.exit(1); });
