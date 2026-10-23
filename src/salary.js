// 旧链薄壳（L3 冻结层入口，2026-10-08 起）
// 纯解析已下沉到 src/core/salary.js（L1），本文件保留排序/排名逻辑 + 全量 re-export，
// 保证所有 `import { ... } from "./salary.js"` 的旧调用点行为不变。
// ⚠️ 冻结层：不删不跑不改；语义变更一律改 core 后在此 re-export。

import { parseMonthlySalaryK, jobSalaryRange } from "./core/salary.js";

export { parseMonthlySalaryK, jobSalaryRange };

function expectedFloor(expectedSalary) {
  const parsed = typeof expectedSalary === "number"
    ? expectedSalary
    : parseMonthlySalaryK(expectedSalary);
  if (parsed == null) return null;
  if (typeof parsed === "number") return parsed;
  return parsed.min;
}

export function salaryRankForJob(job, expectedSalary) {
  const expected = expectedFloor(expectedSalary);
  if (expected == null) return 1;

  const { min, max } = jobSalaryRange(job);
  if (min == null && max == null) return 1;

  if (min != null && min > expected) return 0;
  if (max != null && max < expected) return 2;
  return 1;
}

export function sortJobsForApply(jobs, expectedSalary) {
  const ranked = Array.from(jobs || []).map(function (item) {
    const rank = Number.isFinite(item?.salaryRank)
      ? item.salaryRank
      : salaryRankForJob(item?.job || item, expectedSalary);
    return Object.assign({}, item, { salaryRank: rank });
  });
  return ranked.sort(function (a, b) {
    const aRank = a.salaryRank;
    const bRank = b.salaryRank;
    if (aRank !== bRank) return aRank - bRank;

    const aMatch = Number.isFinite(a?.match)
      ? a.match
      : Number.isFinite(a?.score)
        ? a.score / 100
        : 0;
    const bMatch = Number.isFinite(b?.match)
      ? b.match
      : Number.isFinite(b?.score)
        ? b.score / 100
        : 0;
    return bMatch - aMatch;
  });
}
