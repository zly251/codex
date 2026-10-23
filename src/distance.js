// 旧链薄壳（L3 冻结层入口，2026-10-08 起）
// 纯函数已下沉到 src/core/distance.js（L1），本文件只保留 DB 回写那一层 + 全量 re-export，
// 保证所有 `import { ... } from "./distance.js"` 的旧调用点行为不变。
// ⚠️ 冻结层：不删不跑不改；语义变更一律改 core 后在此 re-export。

import * as jobDb from "./db/job.js";

import {
  DEFAULT_HOME,
  getHome,
  DISTRICT_CENTERS,
  haversineKm,
  matchDistrict,
  TIERS,
  tierForDistance,
  isPlausibleCoord,
  classifyDistance,
} from "./core/distance.js";

export {
  DEFAULT_HOME,
  getHome,
  DISTRICT_CENTERS,
  haversineKm,
  matchDistrict,
  TIERS,
  tierForDistance,
  isPlausibleCoord,
  classifyDistance,
};

/**
 * 算距离并回写 DB（distanceKm / distanceTier）。approx 标记不落库（无列），
 * 只出现在返回值与 job.distanceApprox 上；distanceTier 始终存纯档位值，
 * 便于 M2 直接比较。job 无 id 时只改内存不回写。
 * @param {object} job 岗位对象（需含 city/district 或 lng/lat；有 id 才回写）
 * @param {object} [db] jobDb 访问层（测试可注入）
 * @returns {{distanceKm:number|null, distanceTier:string, approx:boolean, source:(string|null)}}
 */
export function applyDistanceToJob(job, db = jobDb) {
  const info = classifyDistance(job);
  if (job) {
    job.distanceKm = info.distanceKm;
    job.distanceTier = info.distanceTier;
    job.distanceApprox = info.approx;
  }
  if (job && job.id != null && db && typeof db.updateEnrichment === "function") {
    try {
      db.updateEnrichment(job.id, { distanceKm: info.distanceKm, distanceTier: info.distanceTier });
    } catch (e) {
      console.error("[distance] updateEnrichment failed for job " + job.id + ": " + (e && e.message));
    }
  }
  return info;
}
