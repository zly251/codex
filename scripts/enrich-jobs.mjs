// Autonomous Job Search Agent
// 存量岗位距离回填：对 Job 表逐条计算 distanceKm/distanceTier 并回写。
// 纯 DB 操作，不碰浏览器/BOSS。真实坐标缺失时按区县中心点近似（approx，
// 仅体现在输出，tier 正常入库；下次重新抓取时 rawData/坐标如有会自愈）。
// 用法：node scripts/enrich-jobs.mjs [--limit N] [--only-missing]
import "dotenv/config";
import { initDb, getDb } from "../src/db/index.js";
import { applyDistanceToJob } from "../src/distance.js";

initDb();

const argv = process.argv.slice(2);
function flagNum(name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const n = Number(argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}
const limit = flagNum("--limit");
const onlyMissing = argv.includes("--only-missing");

const sql = onlyMissing
  ? "SELECT * FROM Job WHERE distanceTier IS NULL OR distanceTier = ''"
  : "SELECT * FROM Job";
let jobs = getDb().prepare(sql).all();
if (limit != null) jobs = jobs.slice(0, limit);

const stats = { total: jobs.length, CORE: 0, NEAR: 0, FAR: 0, UNKNOWN: 0, OUT_OF_CITY: 0, approx: 0, failed: 0 };
for (const job of jobs) {
  try {
    const info = applyDistanceToJob(job);
    stats[info.distanceTier] = (stats[info.distanceTier] || 0) + 1;
    if (info.approx) stats.approx++;
  } catch (e) {
    stats.failed++;
    console.error("[enrich-jobs] job " + job.id + " failed: " + (e && e.message));
  }
}
console.log("[enrich-jobs] 回填完成:", JSON.stringify(stats));
