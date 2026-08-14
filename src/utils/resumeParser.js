import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import mammoth from "mammoth";
import { ocrImage } from "./ocr.js";
import { extractSkills } from "./skills.js";

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".bmp", ".webp"]);

const SECTION_RULES = [
  {
    key: "targetRole",
    test: /^(?:求职意向|意向岗位|目标岗位|应聘岗位|应聘职位)\s*[:：]?\s*(.+)$/,
  },
  {
    key: "education",
    test: /^(?:教育经历|教育背景|学历背景)\s*[:：]?\s*$/,
  },
  {
    key: "work",
    test: /^(?:工作经历|实习经历|工作履历|职业经历)\s*[:：]?\s*$/,
  },
  {
    key: "projects",
    test: /^(?:项目经历|项目经验|项目实践)\s*[:：]?\s*$/,
  },
  {
    key: "summary",
    test: /^(?:个人优势|自我评价|个人简介|个人总结|个人综述|简介)\s*[:：]?\s*$/,
  },
  {
    key: "skills",
    test: /^(?:专业技能|技能|技能证书|技术栈|掌握技能)\s*[:：]?\s*$/,
  },
];

const SKILL_LABELS = new Set([
  "熟悉",
  "掌握",
  "精通",
  "了解",
  "熟练",
  "技能",
  "专业技能",
  "技术栈",
]);

function cleanLine(value) {
  return String(value || "").trim();
}

function collapseSpaces(value) {
  return String(value || "").replace(/[ \t]+/g, " ").trim();
}

function sectionKey(line) {
  const text = cleanLine(line);
  if (!text || text.length > 40) return null;
  for (const rule of SECTION_RULES) {
    const match = text.match(rule.test);
    if (match) return { key: rule.key, rest: cleanLine(match[1] || "") };
  }
  return null;
}

function extractSections(text) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  const sections = {};
  let current = null;
  for (const rawLine of lines) {
    const line = cleanLine(rawLine);
    if (!line) continue;
    const hit = sectionKey(line);
    if (hit) {
      current = hit.key;
      if (hit.rest && !sections.targetRole) sections.targetRole = hit.rest;
      continue;
    }
    if (current) {
      if (!sections[current]) sections[current] = [];
      sections[current].push(line);
    }
  }
  return sections;
}

function joinSection(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return "";
  return collapseSpaces(lines.join("\n")).slice(0, 4000);
}

function skillTokens(value) {
  const tokens = String(value || "")
    .split(/[,，;；、/|]+/)
    .map(cleanLine)
    .filter((token) => {
      if (!token) return false;
      const lower = token.toLowerCase();
      return !SKILL_LABELS.has(lower) && !/^(?:岗位|职位|期望|姓名|电话|邮箱|手机|微信)$/.test(token);
    });
  return tokens;
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function uniqueSkills(values) {
  const seen = new Set();
  return values.filter((value) => {
    if (!value) return false;
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cleanTargetRole(value) {
  return String(value || "")
    .split(/[|｜]/)[0]
    .trim();
}

function educationLevel(sectionText) {
  const match = String(sectionText || "").match(/(大专|本科|硕士|博士|研究生)/);
  return match ? match[1] : "";
}

function experienceYears(text) {
  const match = String(text || "").match(/(?:经验|工作年限|从业年限)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*年/);
  return match ? match[1] + "年" : "";
}

function periodFromLine(value) {
  const match = String(value || "").match(
    /(20\d{2}[./年-]\d{1,2}(?:[月./-]\d{1,2})?\s*(?:-|~|—|至|到)\s*(?:20\d{2}[./年-]\d{1,2}(?:[月./-]\d{1,2})?|至今))/
  );
  return match ? match[1] : "";
}

function parseBlockItems(lines, kind) {
  if (!Array.isArray(lines) || lines.length === 0) return [];
  const blocks = joinSection(lines).split(/\n\s*\n/).filter(Boolean);
  const items = [];
  for (const block of blocks) {
    const blockLines = block.split("\n").map(cleanLine).filter(Boolean);
    if (blockLines.length === 0) continue;
    const first = blockLines[0];
    const period = periodFromLine(block);
    const rest = blockLines.slice(1).join("\n");
    if (kind === "educationList") {
      const degree = first.match(/(大专|本科|硕士|博士|研究生)/)?.[1] || "";
      items.push({
        school: first.replace(/(大专|本科|硕士|博士|研究生)\s*/, "").replace(period, "").trim(),
        degree,
        period,
        content: rest,
      });
      continue;
    }
    const withoutPeriod = first.replace(period, "").trim();
    const parts = withoutPeriod.split(/\s+/).map(cleanLine).filter(Boolean);
    const company = parts[0] || "";
    const title = parts.slice(1).join(" ") || "";
    items.push({
      company,
      title,
      period,
      content: rest,
    });
  }
  return items;
}

function firstName(text) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  for (const raw of lines) {
    const line = cleanLine(raw);
    if (!line || line.length > 16) continue;
    if (/^[\u4e00-\u9fa5·]{2,12}$/.test(line) && !sectionKey(line)) return line;
  }
  return "";
}

export function parseResumeText(text) {
  const normalized = String(text || "").replace(/\r\n?/g, "\n");
  const sections = extractSections(normalized);
  const phoneMatch = normalized.match(/(?<!\d)(1[3-9]\d{9})(?!\d)/);
  const emailMatch = normalized.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  const cityMatch = normalized.match(/(?:现居|所在城市|居住地)\s*[:：]?\s*([\u4e00-\u9fa5]{2,20})/);
  const birthMatch = normalized.match(/(?:出生|生日)\s*[:：]?\s*([0-9]{4}年?[0-9]{1,2}月?(?:[0-9]{1,2}日?)?)/);
  const targetRole = cleanTargetRole(sections.targetRole || normalized.match(/(?:求职意向|意向岗位|目标岗位|应聘岗位|应聘职位)\s*[:：]?\s*([^\n|｜]+)/)?.[1] || "");
  const parsedSkills = uniqueSkills([
    ...skillTokens(sections.skills),
    ...extractSkills(normalized),
  ]);
  const workItems = parseBlockItems(sections.work || [], "work");
  const projectItems = parseBlockItems(sections.projects || [], "projects");
  const educationItems = parseBlockItems(sections.education || [], "educationList");

  return {
    name: firstName(normalized),
    phone: phoneMatch ? phoneMatch[1] : "",
    email: emailMatch ? emailMatch[0] : "",
    city: cityMatch ? cleanLine(cityMatch[1]) : "",
    birthDate: birthMatch ? cleanLine(birthMatch[1]) : "",
    targetRole,
    education: educationLevel(joinSection(sections.education)),
    experience: experienceYears(joinSection([...(sections.work || []), ...(sections.projects || [])])),
    summary: joinSection(sections.summary),
    skills: parsedSkills.join(","),
    work: workItems,
    projects: projectItems,
    educationList: educationItems,
  };
}

async function extractPdfText(filePath) {
  const data = fs.readFileSync(filePath);
  const result = await pdfParse(data);
  const text = String(result?.text || "").trim();
  if (text.length >= 20) return text;
  return await ocrPdfFallback(filePath);
}

function runCommand(command, args, timeout = 30000) {
  try {
    return spawnSync(command, args, { encoding: "utf8", timeout });
  } catch (e) {
    return { error: e };
  }
}

async function ocrPdfFallback(filePath) {
  try {
    const pdfText = runCommand(
      "cmd.exe",
      ["/c", `pdftotext -enc UTF-8 "${filePath}" -`],
      15000
    );
    if (!pdfText.error && pdfText.status === 0 && String(pdfText.stdout || "").trim().length >= 20) {
      return String(pdfText.stdout).trim();
    }
  } catch (e) {}

  const prefix = path.join(os.tmpdir(), `job-agent-pdf-${Date.now()}-${process.pid}`);
  try {
    const converted = runCommand(
      "cmd.exe",
      ["/c", `pdftoppm -png -r 150 "${filePath}" "${prefix}"`],
      60000
    );
    if (converted.error || converted.status !== 0) return "";
    const files = fs.readdirSync(path.dirname(prefix))
      .filter((name) => name.startsWith(path.basename(prefix)) && /\.png$/i.test(name))
      .sort()
      .map((name) => path.join(path.dirname(prefix), name));
    if (files.length === 0) return "";
    const pages = [];
    for (const file of files) {
      const text = await ocrImage(file);
      if (text) pages.push(text);
    }
    return pages.join("\n\n").trim();
  } catch (e) {
    return "";
  }
}

async function extractDocxText(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  return String(result?.value || "").trim();
}

function extractLegacyDocText(filePath) {
  try {
    const antiword = spawnSync("antiword", [filePath], {
      encoding: "utf8",
      timeout: 10000,
    });
    if (!antiword.error && antiword.status === 0 && String(antiword.stdout || "").trim()) {
      return String(antiword.stdout).trim();
    }
  } catch (e) {}

  try {
    const script = [
      "$ErrorActionPreference='Stop'",
      "$w=New-Object -ComObject Word.Application",
      "$w.Visible=$false",
      "$d=$w.Documents.Open($env:JOB_AGENT_DOC_PATH,$false,$true)",
      "$t=$d.Content.Text",
      "$d.Close($false)",
      "$w.Quit()",
      "Write-Output $t",
    ].join(";");
    const ps = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        timeout: 30000,
        env: { ...process.env, JOB_AGENT_DOC_PATH: filePath },
      }
    );
    if (!ps.error && ps.status === 0 && String(ps.stdout || "").trim().length > 10) {
      return String(ps.stdout).trim();
    }
  } catch (e) {}

  const buf = fs.readFileSync(filePath);
  const candidates = [buf.toString("utf16le"), buf.toString("latin1")];
  const picked = candidates
    .map((value) => value.replace(/\u0000/g, ""))
    .map((value) => value.replace(/[^\u4e00-\u9fa5A-Za-z0-9.,;:()（）\[\]{}%+\-/@_#\s]/g, " "))
    .map((value) => value.replace(/\s{2,}/g, "\n").trim())
    .filter(Boolean)
    .sort((a, b) => (b.match(/[\u4e00-\u9fa5]/g) || []).length - (a.match(/[\u4e00-\u9fa5]/g) || []).length)[0] || "";
  return picked.slice(0, 20000);
}

export async function extractResumeText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_EXTS.has(ext)) {
    const text = await ocrImage(filePath);
    return String(text || "").trim();
  }
  if (ext === ".pdf") return extractPdfText(filePath);
  if (ext === ".docx") return extractDocxText(filePath);
  if (ext === ".doc") return extractLegacyDocText(filePath);
  return fs.readFileSync(filePath, "utf8").trim();
}

export function resumeFileType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return "ocr";
  if (ext === ".pdf") return "pdf";
  if (ext === ".docx") return "docx";
  if (ext === ".doc") return "doc";
  return "txt";
}

export function mergeResumeFromUpload(existing, parsed) {
  const editor = { ...(existing || {}) };
  const pick = (value) => String(value || "").trim();
  const preferred = (current, recognized) => pick(recognized) || pick(current);

  editor.name = preferred(editor.name, parsed.name);
  editor.phone = preferred(editor.phone, parsed.phone);
  editor.email = preferred(editor.email, parsed.email);
  editor.city = preferred(editor.city, parsed.city);
  editor.birthDate = preferred(editor.birthDate, parsed.birthDate);
  editor.targetRole = preferred(editor.targetRole, parsed.targetRole);
  editor.education = preferred(editor.education, parsed.education);
  editor.experience = preferred(editor.experience, parsed.experience);
  editor.summary = preferred(editor.summary, parsed.summary);
  editor.skills = uniqueSkills([...skillTokens(editor.skills), ...skillTokens(parsed.skills)]).join(",");
  if (Array.isArray(parsed.work) && parsed.work.length > 0 && (!Array.isArray(editor.work) || editor.work.length === 0)) {
    editor.work = parsed.work;
  }
  if (Array.isArray(parsed.projects) && parsed.projects.length > 0 && (!Array.isArray(editor.projects) || editor.projects.length === 0)) {
    editor.projects = parsed.projects;
  }
  if (Array.isArray(parsed.educationList) && parsed.educationList.length > 0 && (!Array.isArray(editor.educationList) || editor.educationList.length === 0)) {
    editor.educationList = parsed.educationList;
  }
  return editor;
}
