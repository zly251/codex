// Minimal strategy engine: turn application feedback into funnel stats and a
// recommended minimum match threshold.
import * as applicationDb from "./db/application.js";
import * as jobDb from "./db/job.js";

const BASE_WEIGHTS = { skill: 0.6, experience: 0.2, education: 0.2 };

export function buildStrategy() {
  const apps = applicationDb.findAll();
  const stats = applicationDb.getStats();
  const total = apps.length;
  const funnel = {
    pending: stats.pending || 0,
    viewed: stats.viewed || 0,
    replied: stats.replied || 0,
    interview: stats.interview || 0,
    offer: stats.offer || 0,
    rejected: stats.rejected || 0,
    withdrawn: stats.withdrawn || 0,
  };
  const responded = funnel.replied + funnel.interview + funnel.offer + funnel.rejected;
  const viewed = funnel.viewed + responded;
  const replyRate = total ? responded / total : 0;
  const interviewRate = total ? (funnel.interview + funnel.offer) / total : 0;

  let recommendedMinMatch = 30;
  if (total >= 5 && replyRate === 0) recommendedMinMatch = 60;
  else if (total >= 3 && replyRate < 0.1) recommendedMinMatch = 45;
  else if (total >= 3 && replyRate >= 0.3) recommendedMinMatch = 30;

  let avgScore = 0;
  let scoredCount = 0;
  for (const a of apps) {
    const j = a.jobId ? jobDb.findById(a.jobId) : null;
    const score = j && typeof j.score === "number" ? j.score : null;
    if (score != null) {
      avgScore += score;
      scoredCount++;
    }
  }
  avgScore = scoredCount ? Math.round(avgScore / scoredCount) : 0;

  let insight = "先完成第一轮投递，积累反馈后再调整阈值";
  if (total > 0) {
    if (replyRate >= 0.3) insight = "回复率健康，保持当前筛选阈值";
    else if (replyRate > 0) insight = "回复率偏低，建议提高匹配度阈值";
    else insight = "暂未收到回复，建议只投高匹配职位";
  }

  return {
    totalApplications: total,
    funnel,
    conversion: {
      viewRate: total ? Math.round((viewed / total) * 100) : 0,
      replyRate: Math.round(replyRate * 100),
      interviewRate: Math.round(interviewRate * 100),
    },
    avgAppliedScore: avgScore,
    recommendedMinMatch,
    weights: BASE_WEIGHTS,
    insight,
  };
}
