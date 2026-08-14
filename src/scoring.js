import { salaryRankForJob } from "./salary.js";

const EDU_RANK = { "博士": 5, "硕士": 4, "本科": 3, "大专": 2, "高中": 1, "中专": 1 };

function parseYears(str) {
  if (!str) return null;
  const s = String(str).replace(/年/g, "").trim();
  if (s.includes("不限")) return { min: 0, max: Infinity };
  const range = s.match(/(\d+)\s*[-~至]\s*(\d+)/);
  if (range) return { min: Number(range[1]), max: Number(range[2]) };
  const n = s.match(/(\d+)/);
  if (!n) return null;
  const v = Number(n[1]);
  if (s.includes("以上")) return { min: v, max: Infinity };
  return { min: v, max: v };
}

function profileYears(profile) {
  const m = String(profile.experience || "").match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

function educationRank(text) {
  let rank = 0;
  for (const key of Object.keys(EDU_RANK)) {
    if (String(text || "").includes(key)) rank = Math.max(rank, EDU_RANK[key]);
  }
  return rank;
}

export function scoreJob(job, profile) {
  profile = profile || {};
  const profileSkills = String(profile.skills || "").split(",").map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
  const techs = String(job.technologies || "").split(",").map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
  const combined = ((job.title || "") + " " + (job.technologies || "") + " " + (job.description || "") + " " + (job.requirements || "")).toLowerCase();

  let skillScore = 0;
  if (techs.length > 0 && profileSkills.length > 0) {
    const matchedTechs = techs.filter(function (t) { return profileSkills.includes(t); });
    skillScore = Math.max(skillScore, matchedTechs.length / techs.length);
  }
  if (profileSkills.length > 0) {
    const hits = profileSkills.filter(function (s) { return combined.includes(s); }).length;
    skillScore = Math.max(skillScore, hits / profileSkills.length);
  }
  if (profileSkills.length === 0) skillScore = 1;

  let experienceScore = 1;
  const pYears = profileYears(profile);
  if (pYears != null) {
    const jr = parseYears(job.experience);
    if (jr) {
      if (pYears >= jr.min && pYears <= jr.max) experienceScore = 1;
      else if (jr.max < pYears) experienceScore = 0.8;
      else experienceScore = 0.6;
    }
  }

  let educationScore = 1;
  const jobEdu = String(job.education || "").trim();
  if (jobEdu && jobEdu !== "学历不限" && String(profile.education || "").trim()) {
    const pRank = educationRank(profile.education);
    const jRank = educationRank(jobEdu);
    if (jRank > 0) educationScore = pRank >= jRank ? 1 : pRank / jRank;
  }

  const score = Math.round((skillScore * 0.6 + experienceScore * 0.2 + educationScore * 0.2) * 100);
  const salaryRank = salaryRankForJob(job, profile.expectedSalary);
  return {
    score: Math.max(0, Math.min(100, score)),
    skillScore: Math.round(skillScore * 100),
    experienceScore: Math.round(experienceScore * 100),
    educationScore: Math.round(educationScore * 100),
    salaryRank,
    salaryStatus: salaryRank === 0 ? "above" : salaryRank === 2 ? "below" : "compatible",
    matchedSkills: profileSkills.filter(function (s) { return combined.includes(s); }),
    missingSkills: profileSkills.filter(function (s) { return !combined.includes(s); }),
  };
}

export function decideJob(score, reviewThreshold = 30) {
  if (score >= 60) return "AUTO_APPLY";
  if (score >= reviewThreshold) return "REVIEW";
  return "IGNORE";
}
