import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  ImageRun,
  Table,
  TableCell,
  TableRow,
  VerticalAlign,
  WidthType,
} from "docx";
import { RESUME_EDITOR_PATH } from "./paths.js";
import { findEdgePath } from "./edgeLauncher.js";

const MAX_TEXT = 4000;
const MAX_ITEMS = 50;

function cleanText(value) {
  return String(value || "").trim().slice(0, MAX_TEXT);
}

function cleanPhoto(value) {
  return String(value || "").trim();
}

function photoFileMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

function photoToDataUrl(photo) {
  if (!photo) return "";
  if (/^data:image\//i.test(photo)) return photo;
  const filePath = path.isAbsolute(photo)
    ? photo
    : path.join(path.dirname(RESUME_EDITOR_PATH), photo);
  try {
    if (!fs.existsSync(filePath)) return "";
    return "data:" + photoFileMime(filePath) + ";base64," + fs.readFileSync(filePath).toString("base64");
  } catch (e) {
    return "";
  }
}

function photoImageData(photo) {
  if (!photo) return null;
  if (/^data:image\//i.test(photo)) {
    const match = /^data:image\/(png|jpe?g|webp);base64,(.*)$/i.exec(photo);
    if (!match) return null;
    let type = match[1].toLowerCase();
    if (type === "jpeg") type = "jpg";
    if (!["jpg", "png", "gif", "bmp"].includes(type)) return null;
    return {
      data: Buffer.from(match[2], "base64"),
      type,
    };
  }
  const filePath = path.isAbsolute(photo)
    ? photo
    : path.join(path.dirname(RESUME_EDITOR_PATH), photo);
  try {
    if (!fs.existsSync(filePath)) return null;
    const ext = path.extname(filePath).toLowerCase();
    const type = ext === ".png" ? "png" : ext === ".gif" ? "gif" : ext === ".bmp" ? "bmp" : "jpg";
    return { data: fs.readFileSync(filePath), type };
  } catch (e) {
    return null;
  }
}

function cleanItems(value, fields) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, MAX_ITEMS)
    .map(function (item) {
      const out = {};
      for (const key of fields) out[key] = cleanText(item && item[key]);
      return out;
    })
    .filter(function (item) {
      return Object.values(item).some(Boolean);
    });
}

function normalizeResume(data) {
  const d = data || {};
  return {
    name: cleanText(d.name),
    targetRole: cleanText(d.targetRole),
    phone: cleanText(d.phone),
    email: cleanText(d.email),
    city: cleanText(d.city),
    status: cleanText(d.status),
    education: cleanText(d.education),
    experience: cleanText(d.experience),
    summary: cleanText(d.summary),
    skills: cleanText(d.skills),
    greeting: cleanText(d.greeting),
    photo: cleanPhoto(d.photo),
    work: cleanItems(d.work, ["company", "title", "period", "content"]),
    projects: cleanItems(d.projects, ["name", "role", "period", "content"]),
    educationList: cleanItems(d.educationList, ["school", "degree", "period", "content"]),
  };
}

export function loadResumeEditor(profile) {
  let saved = null;
  try {
    if (fs.existsSync(RESUME_EDITOR_PATH)) {
      saved = JSON.parse(fs.readFileSync(RESUME_EDITOR_PATH, "utf8"));
    }
  } catch (e) {}
  const p = profile || {};
  return {
    name: cleanText(saved?.name ?? p.name),
    targetRole: cleanText(saved?.targetRole ?? p.targetRole),
    phone: cleanText(saved?.phone),
    email: cleanText(saved?.email),
    city: cleanText(saved?.city),
    status: cleanText(saved?.status ?? p.status),
    education: cleanText(saved?.education ?? p.education),
    experience: cleanText(saved?.experience ?? p.experience),
    summary: cleanText(saved?.summary),
    skills: cleanText(saved?.skills ?? p.skills),
    greeting: cleanText(saved?.greeting ?? p.greeting),
    photo: cleanPhoto(saved?.photo),
    work: cleanItems(saved?.work, ["company", "title", "period", "content"]),
    projects: cleanItems(saved?.projects, ["name", "role", "period", "content"]),
    educationList: cleanItems(saved?.educationList, ["school", "degree", "period", "content"]),
  };
}

export function saveResumeEditor(data, profilePath) {
  const resume = normalizeResume(data);
  fs.mkdirSync(path.dirname(RESUME_EDITOR_PATH), { recursive: true });
  fs.writeFileSync(RESUME_EDITOR_PATH, JSON.stringify(resume, null, 2), "utf8");

  if (profilePath) {
    let profile = {};
    try {
      profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
    } catch (e) {}
    const fields = [
      "name",
      "targetRole",
      "phone",
      "email",
      "city",
      "status",
      "education",
      "experience",
      "summary",
      "skills",
      "greeting",
    ];
    for (const key of fields) {
      if (resume[key]) profile[key] = resume[key];
    }
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), "utf8");
  }
  return resume;
}

export function resumeToText(resume) {
  const r = resume || {};
  const lines = [
    `姓名: ${r.name || ""}`,
    `目标岗位: ${r.targetRole || ""}`,
    `联系方式: ${[r.phone, r.email].filter(Boolean).join(" / ")}`,
    `所在地: ${r.city || ""}`,
    `求职状态: ${r.status || ""}`,
    `学历: ${r.education || ""}`,
    `经验: ${r.experience || ""}`,
    `个人优势: ${r.summary || ""}`,
    `技能: ${r.skills || ""}`,
  ];
  for (const item of r.work || []) {
    lines.push(`工作经历: ${item.company || ""} ${item.title || ""} ${item.period || ""} ${item.content || ""}`);
  }
  for (const item of r.projects || []) {
    lines.push(`项目经历: ${item.name || ""} ${item.role || ""} ${item.period || ""} ${item.content || ""}`);
  }
  for (const item of r.educationList || []) {
    lines.push(`教育经历: ${item.school || ""} ${item.degree || ""} ${item.period || ""} ${item.content || ""}`);
  }
  return lines.filter(function (line) {
    return line.replace(/^[^:]+:\s*/, "").trim();
  }).join("\n");
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderItemHtml(item, main, sub) {
  const line = [escapeHtml(main), escapeHtml(sub)].filter(Boolean).join(" ");
  return (
    '<div class="item"><div><h4>' +
    line +
    '</h4><div class="content">' +
    escapeHtml(item.content || "") +
    '</div></div><div class="period">' +
    escapeHtml(item.period || "") +
    "</div></div>"
  );
}

function renderSectionHtml(title, html) {
  if (!html) return "";
  return '<div class="section-title">' + escapeHtml(title) + "</div>" + html;
}

export function renderResumeHtml(resume) {
  const r = resume || {};
  const contact = [r.targetRole, r.phone, r.email, r.city, r.status].filter(Boolean).join(" | ");
  const photoData = photoToDataUrl(r.photo);
  const workHtml = (r.work || []).map(function (item) {
    return renderItemHtml(item, item.company, item.title);
  }).join("");
  const projectHtml = (r.projects || []).map(function (item) {
    return renderItemHtml(item, item.name, item.role);
  }).join("");
  const educationHtml = (r.educationList || []).map(function (item) {
    return renderItemHtml(item, item.school, item.degree);
  }).join("");
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><style>
body{font-family:"Microsoft YaHei","PingFang SC",sans-serif;color:#1f2937;margin:0;padding:28px;line-height:1.65}
h1{margin:0 0 6px;font-size:26px}
.resume-header{display:flex;justify-content:space-between;align-items:flex-start;gap:22px;margin-bottom:18px}
.resume-header-main{min-width:0}
.resume-header h1{margin:0 0 6px;font-size:26px}
.resume-header .contact{color:#555;font-size:12px;margin:0}
.photo{width:96px;height:104px;object-fit:cover;border:1px solid #d1d5db;border-radius:6px}
.summary,.skills{white-space:pre-wrap;font-size:12px;color:#374151}
.section-title{font-size:15px;font-weight:700;border-bottom:1px solid #d1d5db;padding-bottom:5px;margin:20px 0 10px}
.item{display:grid;grid-template-columns:1fr 130px;gap:10px;margin-bottom:12px}
.item h4{margin:0 0 4px;font-size:13px}
.period{color:#666;font-size:12px;text-align:right;white-space:nowrap}
.content{white-space:pre-wrap;font-size:12px;color:#374151}
@media print{body{padding:0}}
</style></head><body>
<div class="resume-header">
<div class="resume-header-main">
<h1>${escapeHtml(r.name || "个人简历")}</h1>
<div class="contact">${escapeHtml(contact)}</div>
</div>
${photoData ? '<img class="photo" src="' + escapeHtml(photoData) + '" alt="证件照">' : ""}
</div>
${r.summary ? '<div class="section-title">个人优势</div><div class="summary">' + escapeHtml(r.summary) + "</div>" : ""}
${r.skills ? '<div class="section-title">技能</div><div class="skills">' + escapeHtml(r.skills) + "</div>" : ""}
${renderSectionHtml("工作经历", workHtml)}
${renderSectionHtml("项目经历", projectHtml)}
${renderSectionHtml("教育经历", educationHtml)}
</body></html>`;
}

function docxSection(title) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 280, after: 100 },
    children: [new TextRun({ text: title, bold: true, size: 24 })],
  });
}

function docxItem(item, main, sub) {
  const paragraphs = [];
  const heading = [main, sub].filter(Boolean).join(" ");
  paragraphs.push(
    new Paragraph({
      spacing: { before: 100, after: 40 },
      children: [
        new TextRun({ text: heading, bold: true, size: 22 }),
        new TextRun({ text: item.period ? "  " + item.period : "", color: "666666", size: 20 }),
      ],
    })
  );
  if (item.content) {
    paragraphs.push(new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: item.content, size: 20 })] }));
  }
  return paragraphs;
}

function buildDocxChildren(resume) {
  const r = resume || {};
  const children = [];
  const contact = [r.targetRole, r.phone, r.email, r.city, r.status].filter(Boolean).join(" | ");
  const nameParagraph = new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 80 },
    children: [new TextRun({ text: r.name || "个人简历", bold: true, size: 32 })],
  });
  const contactParagraph = contact
    ? new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 160 },
        children: [new TextRun({ text: contact, color: "555555", size: 20 })],
      })
    : null;
  const photo = photoImageData(r.photo);
  if (photo) {
    children.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({
            children: [
              new TableCell({
                width: { size: 72, type: WidthType.PERCENTAGE },
                verticalAlign: VerticalAlign.CENTER,
                margins: { top: 80, bottom: 80, left: 80, right: 80 },
                children: [nameParagraph, contactParagraph].filter(Boolean),
              }),
              new TableCell({
                width: { size: 28, type: WidthType.PERCENTAGE },
                verticalAlign: VerticalAlign.CENTER,
                margins: { top: 80, bottom: 80, left: 80, right: 80 },
                children: [
                  new Paragraph({
                    alignment: AlignmentType.RIGHT,
                    children: [
                      new ImageRun({
                        type: photo.type,
                        data: photo.data,
                        transformation: { width: 74, height: 80 },
                      }),
                    ],
                  }),
                ],
              }),
            ],
          }),
        ],
      })
    );
  } else {
    children.push(nameParagraph);
    if (contactParagraph) children.push(contactParagraph);
  }
  if (r.summary) {
    children.push(docxSection("个人优势"));
    children.push(new Paragraph({ children: [new TextRun({ text: r.summary, size: 20 })] }));
  }
  if (r.skills) {
    children.push(docxSection("技能"));
    children.push(new Paragraph({ children: [new TextRun({ text: r.skills, size: 20 })] }));
  }
  if ((r.work || []).length) {
    children.push(docxSection("工作经历"));
    for (const item of r.work) children.push(...docxItem(item, item.company, item.title));
  }
  if ((r.projects || []).length) {
    children.push(docxSection("项目经历"));
    for (const item of r.projects) children.push(...docxItem(item, item.name, item.role));
  }
  if ((r.educationList || []).length) {
    children.push(docxSection("教育经历"));
    for (const item of r.educationList) children.push(...docxItem(item, item.school, item.degree));
  }
  return children;
}

export async function generateDocxBuffer(resume) {
  const doc = new Document({
    sections: [{ properties: {}, children: buildDocxChildren(resume) }],
  });
  return await Packer.toBuffer(doc);
}

export async function generatePdfBuffer(resume) {
  const executablePath = findEdgePath();
  if (!executablePath) throw new Error("未找到 Edge/Chrome，无法生成 PDF");
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(renderResumeHtml(resume), { waitUntil: "networkidle0" });
    return Buffer.from(
      await page.pdf({
        format: "A4",
        printBackground: true,
        margin: { top: "16mm", right: "14mm", bottom: "16mm", left: "14mm" },
      })
    );
  } finally {
    await browser.close();
  }
}
