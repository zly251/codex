import path from "node:path";

export function buildGreeting(job, profile, raw) {
  const p = profile || {};
  const j = job || {};
  const name = String(p.name || "").trim() || "求职者";
  const company = String(j.companyName || p.companyName || "").trim() || "贵司";
  const title = String(j.title || p.targetRole || "").trim() || "该职位";
  const skills = String(p.skills || j.technologies || "").trim();
  const role = String(p.targetRole || j.title || "").trim() || "该岗位";

  let text = String(raw || p.greeting || "").trim();
  if (!text) {
    text = "您好，我是{name}，有{skills}相关经验，对贵司的{job}岗位很感兴趣，方便沟通一下吗？";
  }

  // 个性化：raw 未提及 {job}/{role} 占位符，也未包含职位标题时，
  // 自动补一句职位相关表达，避免直接返回泛模板。
  const titleReal = title !== "该职位";
  const roleReal = role !== "该岗位";
  const mentionJob =
    text.includes("{job}") ||
    text.includes("{role}") ||
    (titleReal && text.includes(title)) ||
    (roleReal && text.includes(role));
  if (!mentionJob) {
    const jobPhrase = titleReal ? title : "贵司";
    text += ` 我对${jobPhrase}的岗位很感兴趣，方便沟通一下吗？`;
  }

  const map = {
    "{name}": name,
    "{company}": company,
    "{job}": title,
    "{role}": role,
    "{skills}": skills,
  };

  for (const [key, value] of Object.entries(map)) {
    text = text.split(key).join(value);
  }

  text = text.replace(/\s+/g, " ").trim();
  if (!text) {
    text = "您好，我对该职位很感兴趣，方便沟通一下吗？";
  }
  return text;
}

export function greetingFileName(job, profile, raw) {
  const text = buildGreeting(job, profile, raw);
  return text.slice(0, 20).replace(/[\\/:*?"<>|]/g, "");
}

export function resumeDisplayName(filePath) {
  return path.basename(String(filePath || ""));
}
