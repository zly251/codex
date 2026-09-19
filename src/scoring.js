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

// 主投方向闸门（2026-09-19 用户签字：过渡岗为主，技术辅助类初级岗为次）。
// 为什么需要它：评分是 skill/experience/education/distance 加权，过渡岗的 technologies
// 基本为空 ⇒ 分数主要由"离家近"决定，于是后厨/护工/普工也能拿到 45 分进待确认队列；
// 一旦一键放行就会给这些岗位发打招呼。方向闸门在评分之前把不对口的岗位剔掉。
// 覆盖方式：调用方传 keywords（优先级更高）或 .env JOB_AGENT_DIRECTION_KEYWORDS。
export const DEFAULT_DIRECTION_KEYWORDS = [
  "外贸", "业务", "销售", "客服", "售前", "售后", "助理", "跟单", "采购", "内勤", "文员", "行政", "客户", "运营",
  // 下面几个来自《个人真实能力地图》2026-08-30 结论 2「短时间可变就业的：AI 辅助开发/测试/产品验收方向的初级岗」
  "数据", "文档", "资料", "技术支持", "实施", "测试",
];

export function directionKeywords(env = process.env) {
  const raw = String(env.JOB_AGENT_DIRECTION_KEYWORDS || "").trim();
  const list = raw ? raw.split(/[,，/|]/) : DEFAULT_DIRECTION_KEYWORDS;
  return list.map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
}

// 岗位是否落在主投方向关键词内（title/technologies/description 任一命中）。
export function matchesDirection(job, keywords) {
  const kws = keywords || directionKeywords();
  if (!kws.length) return true;
  const j = job || {};
  const combined = [j.title, j.technologies, j.description].map(function (v) { return String(v || ""); }).join(" ").toLowerCase();
  return kws.some(function (kw) { return combined.includes(kw); });
}

// 经验相关度（0-100，纯排序用，不参与 scoreJob 的加权总分——改了总分会让既有
// 断言的期望值全部失效）。词来自《个人真实能力地图》里"真正能拿出来工作的"三项：
// 需求定义与业务表达 L3、体感验收 L2-L3、AI 协作交付/文档体系 L2。
export const EXPERIENCE_TERMS = [
  "需求", "业务", "沟通", "对接", "验收", "质量", "文档", "资料", "整理", "归档",
  "数据", "报表", "表格", "excel", "信息管理", "客户", "英语", "培训", "讲解", "演示",
];

export function experienceRelevance(job, terms) {
  const list = terms || EXPERIENCE_TERMS;
  const j = job || {};
  const combined = [j.title, j.description, j.requirements, j.technologies]
    .map(function (v) { return String(v || ""); }).join(" ").toLowerCase();
  if (!combined.trim()) return 0;
  let hits = 0;
  for (const t of list) if (combined.includes(t)) hits++;
  return Math.min(100, hits * 25);
}

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
