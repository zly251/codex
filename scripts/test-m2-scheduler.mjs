// Autonomous Job Search Agent
// M2 自检：决策真拦截（partitionByDecision + reviewQueue）+ 每日节奏计划（applyScheduler）
// 纯本地测试：临时 DB / 临时 chat-state，不触碰浏览器、不发任何网络请求。
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmpState = path.join(os.tmpdir(), `m2-chat-state-${process.pid}-${Date.now()}.json`);
process.env.JOB_AGENT_CHAT_STATE_PATH = tmpState;
const tmpDb = path.join(os.tmpdir(), `m2-scheduler-${process.pid}-${Date.now()}.db`);
process.env.JOB_AGENT_DB_PATH = tmpDb;

const { initDb: initTestDb, getDb: getTestDb } = await import("../src/db/index.js");
initTestDb();
const jobDb = await import("../src/db/job.js");
const reviewQueue = await import("../src/db/reviewQueue.js");
const routes = await import("../src/routes.mjs");
const {
  partitionByDecision,
  isApplyDryRun,
  handleReviewList,
  handleReviewApprove,
  handleReviewReject,
} = routes;
const sched = await import("../src/applyScheduler.js");

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log("  ✓ " + msg); }
  else { failed++; console.error("  ✗ " + msg); }
}

// 固定 rng（LCG），保证计划确定性可复现
function makeRng(seed) {
  let s = seed || 1;
  return function () { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
}
function localToday(y, m, d, h) {
  const now = new Date();
  return new Date(now.getFullYear(), m - 1, d, h || 0, 0, 0);
}
function dayStartMs(date) { const d = new Date(date); d.setHours(0, 0, 0, 0); return d.getTime(); }
function deadlineMs(date, hour) { const d = new Date(date); d.setHours(hour, 0, 0, 0); return d.getTime(); }
function mockRes() {
  const r = { code: null, body: null };
  r.writeHead = function (s) { r.code = s; };
  r.end = function (d) { r.body = JSON.parse(d); };
  return r;
}

// ═══ 1. partitionByDecision：M1 三参接口（返回对象）分桶 ═══
console.log("[M2] partitionByDecision 决策分桶（M1 对象接口）");
{
  const core = { id: 1, title: "核心岗位", city: "北京", distanceTier: "CORE" };
  const unknown = { id: 2, title: "未知距离岗位" }; // 无 city/district/坐标 -> UNKNOWN
  const outTown = { id: 3, title: "跨市岗位", city: "杭州", distanceTier: "OUT_OF_CITY" };
  const farNoDorm = { id: 4, title: "远无宿舍", distanceTier: "FAR", hasDormitory: 0 };
  const farDorm = { id: 5, title: "远有宿舍", distanceTier: "FAR", hasDormitory: 1 };
  const scored = [
    { job: core, score: 80 },      // CORE+80 -> AUTO
    { job: core, score: 55 },      // CORE 门槛下调10 -> AUTO
    { job: { id: 6, title: "核心低分", distanceTier: "CORE" }, score: 40 }, // REVIEW
    { job: { id: 7, title: "核心极低", distanceTier: "CORE" }, score: 10 }, // IGNORE
    { job: unknown, score: 90 },   // UNKNOWN 封顶 REVIEW，绝不 AUTO
    { job: outTown, score: 90 },   // 跨市 -> IGNORE
    { job: farNoDorm, score: 90 }, // FAR 无宿舍 -> IGNORE
    { job: farDorm, score: 55 },   // FAR+宿舍 门槛下调 -> AUTO
  ];
  const buckets = partitionByDecision(scored, 30);
  assert(buckets.auto.length === 3 && buckets.review.length === 2 && buckets.ignore.length === 3,
    "8 岗位分桶 3 AUTO / 2 REVIEW / 3 IGNORE（阈值 30）");
  assert(buckets.auto.every(function (s) { return s.decision === "AUTO_APPLY"; }), "AUTO 桶 decision 字段正确");
  const unknownBucket = buckets.review.find(function (s) { return s.job.id === 2; });
  assert(!!unknownBucket, "UNKNOWN 档位 90 分被封顶为 REVIEW（不自动投递）");
  assert(/UNKNOWN/.test(unknownBucket.reason || ""), "REVIEW 理由取 M1 的 d.reason（含 UNKNOWN 说明）");
  assert(buckets.auto.some(function (s) { return s.job.id === 5; }), "FAR+宿舍 55 分按门槛下调进 AUTO");
  assert(buckets.ignore.filter(function (s) { return [3, 4].includes(s.job.id); }).length === 2, "跨市/远无宿舍高分也 IGNORE");
  assert(buckets.ignore.every(function (s) { return (s.reason || "").length > 0; }), "IGNORE 均带 M1 理由");
  // 2 参旧式调用（job=undefined 返回字符串）兼容：不传 job 的纯分数分桶
  const pure = partitionByDecision([{ job: { id: 99, title: "无档位" }, score: 20 }], 30);
  assert(pure.ignore.length === 1, "partitionByDecision 兼容字符串返回形态");
}

// ═══ 2. reviewQueue：入队/批准/拒绝/消费幂等 ═══
console.log("[M2] reviewQueue 队列表操作");
{
  reviewQueue.ensureTable();
  const j1 = jobDb.create({ title: "待确认一", url: "https://example.com/m2/j1", city: "北京", technologies: "C++" });
  const j2 = jobDb.create({ title: "待确认二", url: "https://example.com/m2/j2", city: "北京", technologies: "Java" });
  const r1 = reviewQueue.enqueue({ jobId: j1.id, score: 42, decision: "REVIEW", reason: "距离档位 UNKNOWN" });
  assert(!!r1 && r1.status === "pending" && r1.decision === "REVIEW", "入队 pending/REVIEW");
  const r1b = reviewQueue.enqueue({ jobId: j1.id, score: 45, decision: "REVIEW", reason: "刷新" });
  assert(r1b.id === r1.id && reviewQueue.findPending().length === 1, "同一 jobId 幂等（不重复入队）");
  assert(r1b.score === 45, "重复入队刷新分数");
  reviewQueue.enqueue({ jobId: j2.id, score: 38, decision: "REVIEW", reason: "r2" });
  assert(reviewQueue.findPending().length === 2, "两个待确认岗位");
  reviewQueue.approve(r1.id);
  assert(reviewQueue.findById(r1.id).status === "approved", "approve 置 approved");
  assert(reviewQueue.findApproved().length === 1 && reviewQueue.findApproved()[0].id === r1.id, "findApproved 只返回 approved");
  const pendingRow = reviewQueue.findPending()[0];
  assert(!!pendingRow && pendingRow.jobId === j2.id, "批准后 pending 只剩未处理的那条");
  reviewQueue.reject(pendingRow.id);
  assert(reviewQueue.findPending().length === 0, "拒绝后 pending 清空");
  assert(!reviewQueue.findApproved().some(function (x) { return x.status === "rejected"; }), "rejected 不进 approved 集合");
  const okConsumed = reviewQueue.markConsumed(r1.id);
  assert(okConsumed && reviewQueue.findById(r1.id).status === "consumed", "markConsumed：approved -> consumed");
  assert(!reviewQueue.markConsumed(r1.id), "consumed 后不可重复消费");
  assert(reviewQueue.releaseToApproved([r1.id]) === 1 && reviewQueue.findById(r1.id).status === "approved", "releaseToApproved 回退可重试");
  const stats = reviewQueue.countByStatus();
  assert(stats.approved === 1 && stats.rejected === 1, "countByStatus 统计正确");
}

// ═══ 3. handleReview* API（mock res，不启动服务器） ═══
console.log("[M2] /api/review 处理器");
{
  const j3 = jobDb.create({ title: "API岗位", url: "https://example.com/m2/j3", city: "北京", technologies: "Go" });
  reviewQueue.enqueue({ jobId: j3.id, score: 35, decision: "REVIEW", reason: "API 测试理由" });
  let res = mockRes();
  handleReviewList({}, res);
  assert(res.code === 200 && res.body.ok === true, "GET /api/review 返回 ok");
  const item = res.body.review.find(function (x) { return x.jobId === j3.id; });
  assert(!!item && item.job.title === "API岗位" && item.reason === "API 测试理由", "列表含岗位摘要 + 决策理由");
  assert(res.body.pending === res.body.review.length, "pending 计数与列表一致");

  res = mockRes();
  handleReviewApprove({}, res, { id: item.id });
  assert(res.code === 200 && res.body.ok === true && res.body.review.status === "approved", "approve API 成功");
  res = mockRes();
  handleReviewApprove({}, res, { id: item.id });
  assert(res.code === 409 && res.body.ok === false, "重复 approve 返回 409");
  res = mockRes();
  handleReviewApprove({}, res, { id: 999999 });
  assert(res.code === 404, "approve 不存在的 id 返回 404");
  res = mockRes();
  handleReviewApprove({}, res, {});
  assert(res.code === 400, "approve 缺 id 返回 400");
  res = mockRes();
  handleReviewReject({}, res, { id: item.id });
  assert(res.code === 409, "approved 后不可再 reject（409）");

  const j4 = jobDb.create({ title: "API岗位4", url: "https://example.com/m2/j4" });
  const r4 = reviewQueue.enqueue({ jobId: j4.id, score: 33, decision: "REVIEW", reason: "r4" });
  res = mockRes();
  handleReviewReject({}, res, { id: r4.id });
  assert(res.code === 200 && reviewQueue.findById(r4.id).status === "rejected", "reject API 成功");
}

// ═══ 4. 配额：remaining = quota - applied，planned <= remaining ═══
console.log("[M2] 每日配额约束");
{
  const cfg = sched.schedulerConfig({ quota: 150, appliedToday: 140 });
  assert(sched.remainingQuota(cfg) === 10, "剩余配额 = 150 - 140 = 10");
  const cfg2 = sched.schedulerConfig({ quota: 150, appliedToday: 160 });
  assert(sched.remainingQuota(cfg2) === 0, "超投不为负");
  const jobs = Array.from({ length: 100 }, function (_, i) { return { id: 9000 + i, title: "岗位" + i }; });
  const d = new Date();
  const nine = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9, 0, 0);
  const plan = sched.planSchedule(jobs, { now: nine, rng: makeRng(7), quota: 150, appliedToday: 140 });
  assert(plan.planned <= 10, "planned <= 剩余配额(10)");
  assert(plan.skippedQuota >= 90, "超出配额部分 skippedQuota >= 90");
  // 环境变量读取（只读）
  process.env.APPLY_DAILY_QUOTA = "80";
  assert(sched.schedulerConfig({ appliedToday: 0 }).quota === 80, "APPLY_DAILY_QUOTA 环境变量生效");
  delete process.env.APPLY_DAILY_QUOTA;
  assert(sched.schedulerConfig({}).quota === 150, "默认配额 150");
}

// ═══ 5. 固定 rng+now 的确定性时间轴 ═══
console.log("[M2] 随机节奏计划（确定性回归）");
{
  const d = new Date();
  const nine = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9, 0, 0);
  const jobs = Array.from({ length: 150 }, function (_, i) { return { id: 1 + i, title: "J" + i }; });
  const p1 = sched.planSchedule(jobs, { now: nine, rng: makeRng(42), quota: 150, appliedToday: 0 });
  const p2 = sched.planSchedule(jobs, { now: nine, rng: makeRng(42), quota: 150, appliedToday: 0 });
  assert(p1.planned === 150 || p1.planned > 0, "计划条数 > 0（planned=" + p1.planned + "）");
  assert(JSON.stringify(p1.items.map(function (i) { return i.atMs; })) === JSON.stringify(p2.items.map(function (i) { return i.atMs; })),
    "固定 rng+now 两次运行时间轴完全一致（确定性）");
  assert(p1.items[0].atMs === nine.getTime(), "首单从 now 开始");
  const dl = deadlineMs(nine, 22);
  assert(p1.items.every(function (it) { return it.atMs <= dl; }), "全部计划时间不越过 22:00");
  assert(p1.endMs <= dl && p1.startMs >= nine.getTime(), "start/end 均落在窗口内");
  const gaps = p1.items.slice(1).map(function (it) { return it.gapMs; });
  assert(gaps.every(function (g) { return g >= sched.GAP_MIN_MS; }), "所有间隔 >= 30s 下限");
  assert(p1.items.some(function (it) { return it.longRestBefore; }), "存在长休息插入点（每约20单）");
  const rests = p1.items.filter(function (it) { return it.longRestBefore; });
  assert(rests.every(function (it) { return it.gapMs >= sched.LONG_REST_MIN_MS && it.gapMs <= sched.LONG_REST_MAX_MS; }), "长休息在 5~15 分钟区间");
  assert(rests.length >= Math.floor((p1.planned - 1) / 20) - p1.skippedQuota, "长休息次数与单量匹配");
  const winMs = p1.endMs - p1.startMs;
  assert(winMs >= sched.WINDOW_MIN_MS * 0.5, "执行窗口跨度合理（>=1h 容差）：" + Math.round(winMs / 60000) + "min");
  // 已过 22:00：当日不再排
  const late = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 22, 30, 0);
  const pLate = sched.planSchedule(jobs, { now: late, rng: makeRng(3) });
  assert(pLate.planned === 0 && pLate.items.length === 0 && pLate.skippedQuota === 150, "22:30 计划为 0，全部跳过");
  // 临近 22:00：窗口不足必须截断且不越线
  const soon = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 21, 45, 0);
  const pSoon = sched.planSchedule(jobs.slice(0, 60), { now: soon, rng: makeRng(9), quota: 150, appliedToday: 0 });
  assert(pSoon.items.every(function (it) { return it.atMs <= deadlineMs(soon, 22); }), "21:45 起步的截断计划不越 22:00");
  assert(pSoon.planned < 60, "窗口不足时计划被截断（" + pSoon.planned + "/60）");
  // 空数组
  const pEmpty = sched.planSchedule([], { now: nine });
  assert(pEmpty.planned === 0 && pEmpty.items.length === 0, "空岗位列表返回空计划");
}

// ═══ 6. dryRunReport / throttleOptions / countAppliedToday ═══
console.log("[M2] 报告与节流映射");
{
  const d = new Date();
  const nine = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9, 0, 0);
  const jobs = Array.from({ length: 40 }, function (_, i) { return { id: 1 + i, title: "岗位" + i }; });
  const plan = sched.planSchedule(jobs, { now: nine, rng: makeRng(11), quota: 150, appliedToday: 0 });
  const report = sched.dryRunReport(plan);
  assert(typeof report === "string" && report.includes("计划投递") && report.includes("截止校验"), "dryRunReport 含关键段落");
  assert(report.includes("长休息插入点"), "报告含长休息统计");
  const emptyReport = sched.dryRunReport(sched.planSchedule([], { now: nine }));
  assert(emptyReport.includes("无可投递岗位"), "空计划报告有说明");

  const th = sched.throttleOptions(plan, { delayMin: 8, delayMax: 25 });
  assert(th.delayMin >= 1 && th.delayMax >= th.delayMin, "throttleOptions 秒级区间合法");
  assert(th.plan && th.plan.count === plan.planned && th.plan.longRests >= 1, "throttleOptions 透出计划元数据");
  const thEmpty = sched.throttleOptions(null, { delayMin: 8, delayMax: 25 });
  assert(thEmpty.delayMin === 8 && thEmpty.delayMax === 25 && thEmpty.plan === null, "无计划回退 fallback 节流");

  const utcToday = new Date().toISOString().slice(0, 10);
  const utcYesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const apps = [
    { createdAt: utcToday + " 01:02:03" },
    { createdAt: utcToday + " 09:00:00" },
    { createdAt: utcYesterday + " 23:59:59" },
    { appliedAt: utcToday + " 05:00:00", createdAt: null },
    { createdAt: "2020-01-01 00:00:00" },
  ];
  assert(sched.countAppliedToday(apps) === 3, "countAppliedToday：当日(UTC前缀)3 条，跨日/远古不计");
  assert(sched.countAppliedToday([]) === 0 && sched.countAppliedToday(null) === 0, "空输入计 0");
  assert(sched.countAppliedToday(apps, Date.now()) === sched.countAppliedToday(apps), "显式 nowMs 与默认一致");
}

// ═══ 7. APPLY_DRY_RUN 语义（默认 true） ═══
console.log("[M2] APPLY_DRY_RUN 解析");
{
  assert(isApplyDryRun({}) === true, "未配置 -> 默认 true");
  assert(isApplyDryRun({ APPLY_DRY_RUN: "" }) === true, "空串 -> true");
  assert(isApplyDryRun({ APPLY_DRY_RUN: "0" }) === false, "'0' -> false");
  assert(isApplyDryRun({ APPLY_DRY_RUN: " false " }) === false, "' false ' -> false");
  assert(isApplyDryRun({ APPLY_DRY_RUN: "off" }) === false, "'off' -> false");
  assert(isApplyDryRun({ APPLY_DRY_RUN: "1" }) === true, "'1' -> true");
  assert(isApplyDryRun({ APPLY_DRY_RUN: "true" }) === true, "'true' -> true");
}

// ═══ 8. 端到端回归：放行岗位必须能被下次投递取出（findApproved 消费路径） ═══
console.log("[M2] 放行->下次投递取出 端到端（DB 层）");
{
  const j5 = jobDb.create({ title: "放行回归岗位", url: "https://example.com/m2/j5", city: "北京", technologies: "C++", distanceTier: "NEAR" });
  const r5 = reviewQueue.enqueue({ jobId: j5.id, score: 40, decision: "REVIEW", reason: "e2e" });
  // pending 状态不可被取出
  assert(reviewQueue.findApproved().every(function (x) { return x.id !== r5.id; }), "pending 不在 findApproved（REVIEW 绝不自动投）");
  reviewQueue.approve(r5.id);
  const revived = reviewQueue.findApproved().filter(function (x) {
    const j = jobDb.findById(x.jobId);
    return j && (!j.status || j.status === "active");
  });
  assert(revived.some(function (x) { return x.jobId === j5.id; }), "放行后下次投递可经 findApproved 取出并回查岗位");
  reviewQueue.markConsumed(r5.id);
  assert(reviewQueue.findApproved().every(function (x) { return x.id !== r5.id; }), "consumed 后不再重复取出");
  assert(reviewQueue.findById(r5.id).status === "consumed", "最终状态 consumed");
}

// 清理
try { getTestDb().close(); } catch (e) {}
for (const f of [tmpDb, tmpState]) { try { fs.unlinkSync(f); } catch (e) {} }

console.log("\nM2 结果: " + passed + " 通过, " + failed + " 失败");
process.exit(failed > 0 ? 1 : 0);
