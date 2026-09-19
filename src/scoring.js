import { salaryRankForJob, sortJobsForApply } from "./salary.js";
import { classifyDistance } from "./distance.js";

const EDU_RANK = { "博士": 5, "硕士": 4, "本科": 3, "大专": 2, "高中": 1, "中专": 1 };

// M1: 评分权重。skill/experience/education 为原主干，新增 distance/dormitory 两维。
// 权重参数化：scoreJob 第三参可覆盖任意键，留给 M5/Phase8 调权；总和应为 1。
export const BASE_WEIGHTS = { skill: 0.5, experience: 0.15, education: 0.15, distance: 0.15, dormitory: 0.05 };

// 距离子分映射（0-100）。OUT_OF_CITY 按用户规则"跨市不行"给 0。
export const DISTANCE_SUBSCORE = {
  CORE: 100,          // ≤5km
  NEAR: 70,           // ≤15km
  FAR_DORM: 60,       // >15km 但有员工宿舍/包住
  FAR_NO_DORM: 0,     // >15km 且无宿舍
  UNKNOWN: 50,        // 无坐标无区县信息
  OUT_OF_CITY: 0,     // 跨市
};

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

// 岗位的有效距离档位：优先已入库/已 enrich 的 distanceTier；缺失时按坐标
// 或区县中心点即时推断（纯内存，不回写；回写走 distance.applyDistanceToJob）。
export function effectiveTier(job) {
  if (job && typeof job.distanceTier === "string" && job.distanceTier) return job.distanceTier;
  const info = classifyDistance(job || {});
  return info.distanceTier;
}

function jobHasDormitory(job) {
  return !!(job && Number(job.hasDormitory) === 1);
}

function distanceSubScore(job) {
  const tier = effectiveTier(job);
  if (tier === "FAR") return jobHasDormitory(job) ? DISTANCE_SUBSCORE.FAR_DORM : DISTANCE_SUBSCORE.FAR_NO_DORM;
  const v = DISTANCE_SUBSCORE[tier];
  return v === undefined ? DISTANCE_SUBSCORE.UNKNOWN : v;
}

export function scoreJob(job, profile, weights) {
  profile = profile || {};
  const w = Object.assign({}, BASE_WEIGHTS, weights || {});
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

  const distanceScore = distanceSubScore(job) / 100;
  const dormitoryScore = jobHasDormitory(job) ? 1 : 0;

  const score = Math.round((skillScore * w.skill + experienceScore * w.experience + educationScore * w.education + distanceScore * w.distance + dormitoryScore * w.dormitory) * 100);
  const salaryRank = salaryRankForJob(job, profile.expectedSalary);
  return {
    score: Math.max(0, Math.min(100, score)),
    skillScore: Math.round(skillScore * 100),
    experienceScore: Math.round(experienceScore * 100),
    educationScore: Math.round(educationScore * 100),
    distanceScore: Math.round(distanceScore * 100),
    dormitoryScore: Math.round(dormitoryScore * 100),
    distanceTier: effectiveTier(job),
    salaryRank,
    salaryStatus: salaryRank === 0 ? "above" : salaryRank === 2 ? "below" : "compatible",
    matchedSkills: profileSkills.filter(function (s) { return combined.includes(s); }),
    missingSkills: profileSkills.filter(function (s) { return !combined.includes(s); }),
  };
}

// 原 AUTO 硬门槛（保留为主干）；AUTO 阈值下调常量用于 FAR+宿舍 / CORE 高优先。
const AUTO_THRESHOLD = 60;
const FAR_DORM_AUTO_BONUS = 10;   // FAR 有宿舍：AUTO 门槛下调 10 分
const CORE_AUTO_BONUS = 10;       // CORE：AUTO 门槛下调 10 分

/**
 * M1: 决策 = 原分数主干 + 距离/宿舍规则叠加。
 * 签名兼容（不加新必填参数）：
 *   - decideJob(score, reviewThreshold)           -> 返回纯字符串（原行为，零变化）
 *   - decideJob(score, reviewThreshold, job)      -> 返回 {decision, reason}，
 *     job 为岗位对象，距离/宿舍信息通过其属性（distanceTier/hasDormitory/lng/lat/district/city）传入。
 * M2 分桶接法：const d = decideJob(s, thr, job); const dec = typeof d === "string" ? d : d.decision;
 * 规则叠加（job 模式）：OUT_OF_CITY→IGNORE；FAR 无宿舍→IGNORE；FAR 有宿舍→AUTO 门槛下调 10；
 * UNKNOWN→最多 REVIEW 不 AUTO；CORE→AUTO 门槛下调 10。
 */
export function decideJob(score, reviewThreshold = 30, job = undefined) {
  const s = Number(score) || 0;
  const base = s >= AUTO_THRESHOLD ? "AUTO_APPLY" : (s >= reviewThreshold ? "REVIEW" : "IGNORE");
  if (job === undefined) return base; // 旧签名调用：完全保留原行为

  const tier = effectiveTier(job);
  const dorm = jobHasDormitory(job);
  let decision = base;
  let reason;

  if (tier === "OUT_OF_CITY") {
    decision = "IGNORE";
    reason = "跨市岗位（OUT_OF_CITY），超出可接受范围，直接忽略 [原始判定 " + base + "]";
  } else if (tier === "FAR" && !dorm) {
    decision = "IGNORE";
    reason = "距离>15km 且无员工宿舍（FAR 无宿舍），通勤+住宿开销大，忽略 [原始判定 " + base + "]";
  } else if (tier === "FAR" && dorm) {
    decision = s >= AUTO_THRESHOLD - FAR_DORM_AUTO_BONUS ? "AUTO_APPLY" : (s >= reviewThreshold ? "REVIEW" : "IGNORE");
    reason = "距离>15km 但有员工宿舍（FAR+宿舍），高优先：AUTO 门槛下调 " + FAR_DORM_AUTO_BONUS + " 分至 " + (AUTO_THRESHOLD - FAR_DORM_AUTO_BONUS) + "（分数 " + s + "）";
  } else if (tier === "UNKNOWN") {
    decision = base === "AUTO_APPLY" ? "REVIEW" : base;
    reason = "距离信息未知（UNKNOWN），保守处理：最多 REVIEW 不自动投递 [原始判定 " + base + "]";
  } else if (tier === "CORE") {
    decision = s >= AUTO_THRESHOLD - CORE_AUTO_BONUS ? "AUTO_APPLY" : (s >= reviewThreshold ? "REVIEW" : "IGNORE");
    reason = "核心通勤圈 ≤5km（CORE），AUTO 门槛下调 " + CORE_AUTO_BONUS + " 分至 " + (AUTO_THRESHOLD - CORE_AUTO_BONUS) + "（分数 " + s + "）";
  } else {
    reason = "距离档位 " + tier + (dorm ? "（有宿舍）" : "（无宿舍信息）") + "，按原技能/薪资主干判定（分数 " + s + "）";
  }

  return { decision, reason, tier, hasDormitory: dorm };
}

// M1: 投递排序（tier 主键 + 原薪资键次键）。src/salary.js 的 sortJobsForApply
// 未改动；本函数在其比较链之前插入距离主键，供 routes/M2 接线替换使用：
//   import { sortJobsForApplyWithDistance } from "./scoring.js";
//   const ordered = sortJobsForApplyWithDistance(scored);   // 元素形状同 sortJobsForApply
// tierRank：CORE 最优；FAR+宿舍提到与 NEAR 之间（用户规则"远但有宿舍→高优先"
// 体现在不被 IGNORE 且排序优于 UNKNOWN）；OUT_OF_CITY 垫底。
export const TIER_SORT_RANK = { CORE: 0, NEAR: 1, FAR_DORM: 2, UNKNOWN: 3, FAR: 4, OUT_OF_CITY: 5 };

function tierRankOf(item) {
  const job = item && item.job ? item.job : item;
  const tier = effectiveTier(job);
  if (tier === "FAR") return jobHasDormitory(job) ? TIER_SORT_RANK.FAR_DORM : TIER_SORT_RANK.FAR;
  const r = TIER_SORT_RANK[tier];
  return r === undefined ? TIER_SORT_RANK.UNKNOWN : r;
}

export function sortJobsForApplyWithDistance(jobs, expectedSalary) {
  // 先用原薪资排序打底，再按 tier 做稳定主排序（V8 sort 稳定，同档内保持薪资序）。
  const salarySorted = sortJobsForApply(jobs, expectedSalary);
  const ranked = salarySorted.map(function (item) {
    return { item: item, rank: tierRankOf(item && item.job ? item.job : item) };
  });
  ranked.sort(function (a, b) { return a.rank - b.rank; });
  return ranked.map(function (r) { return r.item; });
}
