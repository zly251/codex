// M1 测试：距离（通勤）+ 宿舍维度进入评分与决策
// 使用临时 DB 路径，绝不触碰真实库 portable/data/job-agent.db。
// 断言器风格仿 scripts/test-multiagent-flow.mjs。
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const tmpDb = path.join(os.tmpdir(), `job-agent-m1-${process.pid}-${Date.now()}.db`);
process.env.JOB_AGENT_DB_PATH = tmpDb;
// 区域配置固定指向入库的通用示例（北京），保证测试与本地私有 config/region.json 无关
process.env.JOB_AGENT_REGION_CONFIG = path.join(__dirname, "..", "config", "region.example.json");
// 距离相关环境变量显式清空 -> 测默认家坐标（北京示例）
delete process.env.JOB_AGENT_HOME_LAT;
delete process.env.JOB_AGENT_HOME_LNG;

const { initDb, getDb } = await import("../src/db/index.js");
initDb();
const jobDb = await import("../src/db/job.js");

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log("  ✓ " + msg);
  } else {
    failed++;
    failures.push(msg);
    console.error("  ✗ " + msg);
  }
}

const {
  getHome, DEFAULT_HOME, DISTRICT_CENTERS, haversineKm, classifyDistance,
  applyDistanceToJob, matchDistrict, tierForDistance, isPlausibleCoord,
} = await import("../src/distance.js");
const { scoreJob, decideJob, sortJobsForApplyWithDistance, BASE_WEIGHTS, effectiveTier } = await import("../src/scoring.js");
const { BossApiScraper } = await import("../src/scrapers/bossApi.js");
const { enrichJobFromDetail, normalizeEnrichPayload, enrichmentPatch } = await import("../src/enrich.js");

// ─────────────────────────────────────────────
console.log("\n[getHome] 默认家坐标与 env 覆盖");
{
  const h = getHome();
  assert(h.lat === 39.9087 && h.lng === 116.3975, "默认家 = 北京示例 (39.9087,116.3975)");
  process.env.JOB_AGENT_HOME_LAT = "30.1";
  process.env.JOB_AGENT_HOME_LNG = "120.2";
  const h2 = getHome();
  assert(h2.lat === 30.1 && h2.lng === 120.2, "env JOB_AGENT_HOME_LAT/LNG 覆盖生效");
  delete process.env.JOB_AGENT_HOME_LAT;
  delete process.env.JOB_AGENT_HOME_LNG;
  assert(getHome().lat === DEFAULT_HOME.lat, "env 删除后回落默认");
}

// ─────────────────────────────────────────────
console.log("\n[haversine] 已知点对");
{
  const home = getHome();
  const dDongcheng = haversineKm(home, DISTRICT_CENTERS["东城区"]);
  assert(dDongcheng > 0 && dDongcheng < 6, `家→东城区中心 ${dDongcheng.toFixed(2)}km 在 (0,6) 区间（城内，合理）`);
  const dChaoyang = haversineKm(home, DISTRICT_CENTERS["朝阳区"]);
  assert(dChaoyang > 5 && dChaoyang < 15, `家→朝阳区中心 ${dChaoyang.toFixed(2)}km 落在 (5,15)，NEAR 档合理`);
  assert(tierForDistance(dChaoyang) === "NEAR", "朝阳中心距离 → NEAR");
  const dTongzhou = haversineKm(home, DISTRICT_CENTERS["通州区"]);
  assert(dTongzhou > 15, `家→通州中心 ${dTongzhou.toFixed(2)}km > 15km → FAR 侧`);
  assert(tierForDistance(dTongzhou) === "FAR", "通州距离 → FAR");
  const dTianjin = haversineKm(home, DISTRICT_CENTERS["和平区"]);
  assert(dTianjin > 100, `家→天津和平 ${dTianjin.toFixed(1)}km > 100km`);
  const dYanqing = haversineKm(home, DISTRICT_CENTERS["延庆区"]);
  assert(dYanqing > 40 && dYanqing < 80, `家→延庆 ${dYanqing.toFixed(1)}km 在 (40,80) 合理`);
  assert(haversineKm(null, home) === null, "坏输入返回 null");
  assert(haversineKm({ lat: "abc", lng: 1 }, home) === null, "非数字坐标返回 null");
}

// ─────────────────────────────────────────────
console.log("\n[classifyDistance] 三档 + UNKNOWN + OUT_OF_CITY");
{
  // 坐标输入：CORE（东城区内 ~家附近 2km 处）
  const core = classifyDistance({ city: "北京", lng: 116.3975, lat: 39.9257, district: "东城区" });
  assert(core.distanceTier === "CORE" && core.distanceKm < 5, `坐标在 5km 内 → CORE (${core.distanceKm?.toFixed(2)}km)`);
  assert(core.source === "coords" && core.approx === false, "坐标输入 source=coords 非近似");

  // 坐标输入：FAR（通州方向 >15km）
  const far = classifyDistance({ city: "北京", lng: 116.3975, lat: 40.0887, district: "通州区" });
  assert(far.distanceTier === "FAR" && far.distanceKm > 15, `坐标 >15km → FAR (${far.distanceKm?.toFixed(1)}km)`);

  // 仅区县命中：approx
  const approx = classifyDistance({ city: "北京", district: "朝阳区" });
  assert(approx.distanceTier === "NEAR" && approx.approx === true, "仅 district=朝阳区 → 区中心近似 NEAR + approx=true");
  assert(approx.source === "district", "仅区县 source=district");

  // district 文本脏数据也能命中
  const dirty = matchDistrict(" 朝阳 · 开发大楼 ");
  assert(dirty === "朝阳区", "district 脏文本子串命中 朝阳区");

  // 全缺 → UNKNOWN
  const unk = classifyDistance({ title: "无位置岗位" });
  assert(unk.distanceTier === "UNKNOWN" && unk.distanceKm === null, "坐标+区县全缺 → UNKNOWN");
  const unk2 = classifyDistance({});
  assert(unk2.distanceTier === "UNKNOWN", "空对象 → UNKNOWN");

  // 外市
  const out = classifyDistance({ city: "天津", district: "和平区" });
  assert(out.distanceTier === "OUT_OF_CITY", "city=天津 → OUT_OF_CITY");
  assert(typeof out.distanceKm === "number" && out.distanceKm > 100, "外市仍给出距离 km 供展示");

  // city 缺失但 district 命中外市区县 → OUT_OF_CITY
  const outNoCity = classifyDistance({ district: "和平区" });
  assert(outNoCity.distanceTier === "OUT_OF_CITY", "city 缺失 + 和平区（外市区县）→ OUT_OF_CITY");

  // 本市辖区但不在中心表（如街道级脏数据不匹配）→ UNKNOWN
  const noMatch = classifyDistance({ city: "北京", district: "某某未知街道" });
  assert(noMatch.distanceTier === "UNKNOWN", "北京 + 未知区县 → UNKNOWN");

  // 坐标优先于 district
  const prefer = classifyDistance({ city: "北京", district: "东城区", lng: 116.3975, lat: 40.4287 }); // 延庆方向坐标
  assert(prefer.source === "coords" && prefer.distanceTier === "FAR", "坐标与区县冲突时以坐标为准");
}

// ─────────────────────────────────────────────
console.log("\n[DB] M1 新列迁移 + create/update/updateEnrichment");
{
  const cols = getDb().prepare("PRAGMA table_info(Job)").all().map((r) => r.name);
  for (const c of ["lng", "lat", "distanceKm", "distanceTier", "hasDormitory", "dormitorySource"]) {
    assert(cols.includes(c), `Job 表含列 ${c}`);
  }
  // 幂等：再跑一次 initDb 不应炸（ALTER 重复列被忽略）
  let reinitOk = true;
  try { initDb(); } catch { reinitOk = false; }
  assert(reinitOk, "重复 initDb 迁移幂等（duplicate column 被忽略）");

  const created = jobDb.create({
    title: "C++工程师A", url: "https://www.zhipin.com/job_detail/test-m1-a.html",
    city: "北京", district: "东城区", technologies: "C++",
    lng: 116.4, lat: 39.92, distanceKm: 1.2, distanceTier: "CORE",
    hasDormitory: 1, dormitorySource: "card",
  });
  assert(created.lng === 116.4 && created.lat === 39.92, "create 写入 lng/lat");
  assert(created.distanceTier === "CORE" && created.hasDormitory === 1 && created.dormitorySource === "card", "create 写入 distanceTier/hasDormitory/dormitorySource");

  const enriched = jobDb.updateEnrichment(created.id, {
    distanceKm: 30.5, distanceTier: "FAR", hasDormitory: 0, dormitorySource: null,
    description: "JD 正文", lng: null, lat: null,
  });
  assert(enriched.distanceKm === 30.5 && enriched.distanceTier === "FAR", "updateEnrichment 更新距离字段");
  assert(enriched.hasDormitory === 0 && enriched.dormitorySource === null, "updateEnrichment 可清宿舍");
  assert(enriched.description === "JD 正文", "updateEnrichment 可写 description");

  const patched = jobDb.updateEnrichment(created.id, { notAColumn: 123, distanceTier: "NEAR" });
  assert(patched.distanceTier === "NEAR", "updateEnrichment 忽略非白名单字段仍可写合法字段");
  const noop = jobDb.updateEnrichment(created.id, {});
  assert(noop && noop.id === created.id, "updateEnrichment 空 patch 返回原记录不炸");

  // M1 风险修复回归：update() 必须容忍非 Job 列键（scraper 对象带 companyName 等），
  // 否则 re-scrape 时整条 UPDATE 失败、新列永远进不了已存在记录。
  const upd = jobDb.update(created.id, { companyName: "某某科技", title: "C++工程师A2", hasDormitory: 1, dormitorySource: "card" });
  assert(upd && upd.title === "C++工程师A2", "update 混入非列键 companyName 后仍成功写入合法列");
  assert(upd.hasDormitory === 1 && upd.dormitorySource === "card", "update 混入非列键时新列（宿舍）可写达");
}

// ─────────────────────────────────────────────
console.log("\n[applyDistanceToJob] 计算 + 回写");
{
  const j = jobDb.create({ title: "回写测试", url: "https://www.zhipin.com/job_detail/test-m1-b.html", city: "北京", district: "通州区" });
  const info = applyDistanceToJob(j, jobDb);
  assert(info.distanceTier === "FAR" && info.approx === true, "仅区县（通州区）→ FAR approx 回写值");
  const row = jobDb.findById(j.id);
  assert(row.distanceTier === "FAR" && typeof row.distanceKm === "number" && row.distanceKm > 15, "distanceKm/distanceTier 已落库");
  assert(j.distanceApprox === true && j.distanceTier === "FAR", "内存 job 对象同步更新（approx 标记只在内存/返回值）");

  const j2 = jobDb.create({ title: "坐标回写", url: "https://www.zhipin.com/job_detail/test-m1-c.html", city: "北京", lng: 116.3975, lat: 39.9257 });
  const info2 = applyDistanceToJob(j2, jobDb);
  assert(info2.distanceTier === "CORE" && jobDb.findById(j2.id).distanceTier === "CORE", "真实坐标 → CORE 并落库");

  const noId = { city: "北京", district: "东城区" };
  const r3 = applyDistanceToJob(noId, jobDb);
  assert(r3.distanceTier === "CORE" && noId.distanceTier === "CORE", "无 id 对象只改内存不回写（不抛错）");
}

// ─────────────────────────────────────────────
console.log("\n[scoreJob] 距离/宿舍子分 + 权重参数化");
{
  const profile = { skills: "C++,Qt,Linux", experience: "3年经验", education: "本科", expectedSalary: "10k" };
  const base = { title: "C++开发工程师", technologies: "C++,Qt", experience: "1-3年", education: "本科", url: "u" };

  const core = scoreJob(Object.assign({}, base, { city: "北京", lng: 116.39, lat: 39.91 }), profile);
  const far = scoreJob(Object.assign({}, base, { city: "北京", district: "通州区" }), profile);
  const farDorm = scoreJob(Object.assign({}, base, { city: "北京", district: "通州区", hasDormitory: 1 }), profile);
  const unk = scoreJob(Object.assign({}, base, { city: "北京" }), profile);

  assert(core.distanceScore === 100, "CORE 距离子分=100");
  assert(far.distanceScore === 0, "FAR 无宿 距离子分=0");
  assert(farDorm.distanceScore === 60, "FAR 有宿 距离子分=60");
  assert(unk.distanceScore === 50, "UNKNOWN 距离子分=50");
  assert(core.score > far.score, `CORE(${core.score}) > FAR无宿(${far.score})：距离并入综合`);
  assert(farDorm.score > far.score, `FAR有宿(${farDorm.score}) > FAR无宿(${far.score})：宿舍并入综合`);
  assert(core.distanceTier === "CORE" && far.distanceTier === "FAR", "score 结果带 distanceTier");

  // 权重参数化：distance 拉满 vs 归零
  const wNoDist = scoreJob(Object.assign({}, base, { city: "北京", district: "通州区" }), profile, { distance: 0, skill: 0.65, experience: 0.2, education: 0.15 });
  assert(wNoDist.score > far.score, `distance 权重=0 时分数(${wNoDist.score})回到接近旧版(${far.score})：权重参数生效`);
  const wAllDist = scoreJob(Object.assign({}, base, { city: "北京", lng: 116.39, lat: 39.91 }), profile, { distance: 0.7, skill: 0.1, experience: 0.1, education: 0.1 });
  assert(wAllDist.score === 100, "distance 权重 0.7 + CORE → 满分（极端权重验证参数化）");
  assert(BASE_WEIGHTS.skill === 0.5 && BASE_WEIGHTS.distance === 0.15 && BASE_WEIGHTS.dormitory === 0.05, "BASE_WEIGHTS 导出且为 M1 新值");
  const sum = Object.values(BASE_WEIGHTS).reduce((a, b) => a + b, 0);
  assert(Math.abs(sum - 1) < 1e-9, "BASE_WEIGHTS 权重和=1");
}

// ─────────────────────────────────────────────
console.log("\n[decideJob] 距离/宿舍规则叠加 + 旧签名兼容");
{
  // 旧签名：两参数调用返回纯字符串（M2/routes 现有代码零改动仍可用）
  assert(decideJob(70) === "AUTO_APPLY", "旧签名 score=70 → AUTO_APPLY 字符串");
  assert(decideJob(40) === "REVIEW", "旧签名 score=40 → REVIEW");
  assert(decideJob(10) === "IGNORE", "旧签名 score=10 → IGNORE");

  const dFarNoDorm = decideJob(80, 30, { distanceTier: "FAR", hasDormitory: 0 });
  assert(dFarNoDorm.decision === "IGNORE", "FAR 无宿 + 高分80 → IGNORE（规则压制）");
  assert(/宿舍|通勤/.test(dFarNoDorm.reason), "理由含距离/宿舍依据");

  const dFarDorm = decideJob(55, 30, { distanceTier: "FAR", hasDormitory: 1 });
  assert(dFarDorm.decision === "AUTO_APPLY", "FAR 有宿 + fit中55（<60）→ AUTO 门槛下调10生效");
  assert(/门槛下调/.test(dFarDorm.reason), "FAR有宿理由写明门槛下调");
  const dFarDormLow = decideJob(50, 30, { distanceTier: "FAR", hasDormitory: 1 });
  assert(dFarDormLow.decision === "AUTO_APPLY", "FAR 有宿 + 边界分50（=下调后阈值 50，取 >=）→ AUTO");
  const dFarDormLower = decideJob(45, 30, { distanceTier: "FAR", hasDormitory: 1 });
  assert(dFarDormLower.decision === "REVIEW", "FAR 有宿 + 45（<50）→ 回落 REVIEW");

  const dUnknown = decideJob(90, 30, { city: "北京" });
  assert(dUnknown.decision === "REVIEW", "UNKNOWN + 高分90 → 最多 REVIEW 不许 AUTO");
  assert(/UNKNOWN|未知/.test(dUnknown.reason), "UNKNOWN 理由写明距离未知");

  const dOut = decideJob(95, 30, { distanceTier: "OUT_OF_CITY" });
  assert(dOut.decision === "IGNORE", "OUT_OF_CITY + 95 → IGNORE");

  const dCore = decideJob(52, 30, { distanceTier: "CORE" });
  assert(dCore.decision === "AUTO_APPLY", "CORE + fit52（≥60-10）→ 门槛下调 AUTO");
  const dCoreLow = decideJob(40, 30, { distanceTier: "CORE" });
  assert(dCoreLow.decision === "REVIEW", "CORE + 40 → REVIEW（未达50）");

  const dNear = decideJob(70, 30, { distanceTier: "NEAR" });
  assert(dNear.decision === "AUTO_APPLY", "NEAR + 70 走原主干 AUTO");

  // job 无 tier 字段时经坐标即时推断
  const dInfer = decideJob(80, 30, { city: "北京", lng: 116.39, lat: 39.91 });
  assert(dInfer.tier === "CORE" && dInfer.decision === "AUTO_APPLY", "job 只有坐标：decideJob 即时推断 CORE");
}

// ─────────────────────────────────────────────
console.log("\n[sortJobsForApplyWithDistance] tier 主键 + 薪资次键");
{
  const items = [
    { job: { title: "远无宿", salaryRaw: "20k", district: "通州区", city: "北京" }, match: 0.9 },
    { job: { title: "近低薪", salaryRaw: "6k", city: "北京", lng: 116.39, lat: 39.91 }, match: 0.3 },
    { job: { title: "外市高薪", salaryRaw: "30k", city: "天津" }, match: 0.95 },
    { job: { title: "远有宿", salaryRaw: "18k", district: "昌平区", city: "北京", hasDormitory: 1 }, match: 0.8 },
  ];
  const sorted = sortJobsForApplyWithDistance(items);
  assert(sorted[0].job.title === "近低薪", "CORE 排最前（薪资/匹配更低也让位距离）");
  assert(sorted[sorted.length - 1].job.title === "外市高薪", "OUT_OF_CITY 垫底");
  const titles = sorted.map((s) => s.job.title);
  assert(titles.indexOf("远有宿") < titles.indexOf("远无宿"), "FAR+宿舍 排在 FAR无宿 之前");
  assert(!("__tierRank" in sorted[0]), "输出对象不带内部字段");
  // 与原 sortJobsForApply 行为兼容：输入元素形状一致（{job, match}）
  const same = sortJobsForApplyWithDistance([]);
  assert(Array.isArray(same) && same.length === 0, "空数组输入返回空数组");
}

// ─────────────────────────────────────────────
console.log("\n[_parseJobs] rawData 复活 + 防御式坐标 + 卡片宿舍标签");
{
  const scraper = new BossApiScraper(null);
  const items = [
    {
      encryptJobId: "J1", jobName: "C++工程师", salaryDesc: "10-15K", cityName: "北京",
      areaDistrict: "东城区", jobExperience: "1-3年", jobDegree: "本科",
      skills: ["C++", "包住"],                        // 卡片福利标签命中宿舍
      lat: "39.92", lng: "116.40",                    // 字符串坐标也要收
    },
    {
      encryptJobId: "J2", jobName: "后端开发", salaryDesc: "12K", cityName: "北京",
      areaDistrict: "通州区",
      geo: { latitude: 40.09, longitude: 116.40 },   // 嵌套坐标
      // 无宿舍标签
    },
    { encryptJobId: "J3", jobName: "无坐标岗", salaryDesc: "8K", cityName: "北京", areaDistrict: "西城区" },
    { encryptJobId: "J4", jobName: "坏坐标岗", lat: "abc", lng: 999 }, // 超量程/非数字 → null
    { jobName: "缺id丢弃", encryptJobId: "" },
  ];
  const out = scraper._parseJobs(items);
  assert(out.length === 4, "缺 id 项被丢弃，其余 4 项解析");

  const j1 = out.find((x) => x.url.includes("J1"));
  assert(j1.rawData && JSON.parse(j1.rawData).jobName === "C++工程师", "rawData 为整包 item 的 JSON（可回读）");
  assert(j1.lat === 39.92 && j1.lng === 116.40, "字符串坐标解析为 number");
  assert(j1.hasDormitory === 1 && j1.dormitorySource === "card", "卡片标签「包住」→ hasDormitory=1 source=card");

  const j2 = out.find((x) => x.url.includes("J2"));
  assert(j2.lat === 40.09 && j2.lng === 116.40, "嵌套 geo.latitude/longitude 兜底取到");
  assert(j2.hasDormitory === undefined, "无宿舍标签时不设置 hasDormitory 字段");

  const j3 = out.find((x) => x.url.includes("J3"));
  assert(j3.lat === null && j3.lng === null, "无坐标项 lat/lng = null");
  assert(typeof j3.rawData === "string", "无坐标项也带 rawData");

  const j4 = out.find((x) => x.url.includes("J4"));
  assert(j4.lat === null && j4.lng === null, "坏坐标（非数字/超量程）→ null 防呆");

  // DOM 兜底路径产出的 item 同经 _parseJobs，rawData 同理生成
  const domItem = { encryptJobId: "D1", jobName: "DOM岗位", salaryDesc: "9K", skills: [], technologyList: [] };
  const domOut = scraper._parseJobs([domItem]);
  assert(domOut[0].rawData && JSON.parse(domOut[0].rawData).jobName === "DOM岗位", "DOM 兜底 item 也获得 rawData");
}

// ─────────────────────────────────────────────
console.log("\n[enrichJobFromDetail] 注入假 page（不真开浏览器）");
{
  const fakePage = {
    async evaluate(fn) {
      // 模拟详情页：JD 正文 + 福利标签 + 坐标属性
      return {
        description: "负责服务端开发，提供员工宿舍。",
        requirements: "熟悉 C++/Linux",
        tags: ["五险一金", "员工宿舍", "双休"],
        lat: 39.92, lng: 116.40,
        fullText: "……",
      };
    },
  };
  const r = await enrichJobFromDetail(fakePage);
  assert(r.description.includes("服务端开发"), "evaluate 路径取到 JD 正文");
  assert(r.requirements.includes("Linux"), "取到 requirements");
  assert(r.hasDormitory === 1 && r.dormitorySource === "detail", "标签「员工宿舍」→ hasDormitory=1 source=detail");
  assert(r.lat === 39.92 && r.lng === 116.40, "详情页坐标属性被捞到");

  const noDormPage = { async evaluate() { return { description: "普通岗位", requirements: "", tags: ["五险一金"], fullText: "x" }; } };
  const r2 = await enrichJobFromDetail(noDormPage);
  assert(r2.hasDormitory === 0 && r2.dormitorySource === null, "无宿舍信号 → hasDormitory=0");

  const textDormPage = { async evaluate() { return { description: "包吃住，待遇从优", tags: [] }; } };
  const r3 = await enrichJobFromDetail(textDormPage);
  assert(r3.hasDormitory === 1, "正文「包吃住」也算宿舍信号");

  // content() 退化路径（假 HTML）
  const htmlPage = {
    async content() {
      return '<div class="job-sec-text">职位描述正文：可住宿</div><ul class="job-tags"><li>五险</li></ul>';
    },
  };
  const r4 = await enrichJobFromDetail(htmlPage);
  assert(r4.description.includes("职位描述正文"), "content() 退化路径提取 .job-sec-text");
  assert(r4.hasDormitory === 1, "content() 路径正文宿舍关键词命中");

  // evaluate 抛错也不炸
  const badPage = { async evaluate() { throw new Error("boom"); } };
  const r5 = await enrichJobFromDetail(badPage);
  assert(r5 && typeof r5.description === "string", "evaluate 失败返回空结构不抛错");

  let threw = false;
  try { await enrichJobFromDetail(null); } catch { threw = true; }
  assert(threw, "page=null 抛错（接口要求）");

  assert(normalizeEnrichPayload(null).hasDormitory === 0, "normalizeEnrichPayload 空输入安全");
}

// ─────────────────────────────────────────────
console.log("\n[回归] 真实 enrich 跑出的三类污染：占位坐标 / 反爬水印 / 详情页地址");
{
  // ① 页面占位坐标 0,0 不得顶掉区县近似（否则 0,0 距本市上万公里 → 全变 FAR）
  const junk = classifyDistance({ city: "北京", district: "朝阳区", lng: 0, lat: 0 });
  assert(junk.source === "district" && junk.distanceTier === "NEAR", "lat/lng=0,0（页面占位）→ 回落区县近似 NEAR，不是 FAR");
  const junkOut = classifyDistance({ city: "天津", district: "和平区", lng: 0, lat: 0 });
  assert(junkOut.distanceTier === "OUT_OF_CITY", "外市 + 0,0 占位坐标 → 仍 OUT_OF_CITY");
  const junkOnly = classifyDistance({ city: "北京", lng: 0, lat: 0 });
  assert(junkOnly.distanceTier === "UNKNOWN", "只有 0,0 坐标、无区县 → UNKNOWN（不是 FAR 上万公里）");
  assert(isPlausibleCoord(39.92, 116.40) && !isPlausibleCoord(0, 0), "isPlausibleCoord：真坐标可信、0,0 不可信");
  assert(!isPlausibleCoord(40, 0) && !isPlausibleCoord(NaN, 121), "isPlausibleCoord：境外/NaN 不可信");

  // ② 反爬水印不得进库
  const wm = normalizeEnrichPayload({ description: "岗boss位职责：负责BOSS直聘软件GUI开发", requirements: "负kanzhun责C++" });
  assert(wm.description === "岗位职责：负责软件GUI开发", "正文水印（boss/BOSS直聘/kanzhun）被剔除");
  assert(wm.requirements === "负责C++", "requirements 水印同步剔除");
  assert(normalizeEnrichPayload({ description: "提供直聘宿舍，待遇从优" }).hasDormitory === 1, "水印夹在宿舍关键词里仍能判出宿舍");
  assert(normalizeEnrichPayload({ tags: ["五boss险一金", "员工直聘宿舍"] }).hasDormitory === 1, "福利标签水印剔除后宿舍判定不变");

  // ③ 坐标占位值不落库
  const zc = normalizeEnrichPayload({ description: "x", lat: 0, lng: 0 });
  assert(zc.lat === undefined && zc.lng === undefined, "normalizeEnrichPayload 丢弃 0,0 占位坐标");

  // ④ 详情页地址 → 区县（M1 在列表卡没给区县时的唯一信息源）
  const patch = enrichmentPatch({ description: "x", hasDormitory: 0, dormitorySource: null, address: "北京市朝阳区某某科技园3号楼" });
  assert(patch.district === "朝阳区", "详情页地址「北京市朝阳区…」抽出本市区县");
  assert(enrichmentPatch({ hasDormitory: 0, dormitorySource: null }).district === undefined, "无地址时不写 district（不覆盖已有值）");
  const addrOut = await enrichJobFromDetail({
    async evaluate() { return { description: "岗直聘位职责：做事", address: "北京市通州区某某路 点击查看地图", tags: [] }; },
  });
  assert(addrOut.address === "北京市通州区某某路", "evaluate 路径取到 address 并去掉「点击查看地图」");
  assert(enrichmentPatch(addrOut).district === "通州区", "evaluate 路径地址 → district=通州区 打通 patch");

  // ⑤ 正文取不到时不再退回整页 innerText（非详情页会把导航文案写成 JD）
  const noJd = await enrichJobFromDetail({ async evaluate() { return { description: "", requirements: "", tags: [] }; } });
  assert(noJd.description === "", "取不到 .job-sec-text 时 description 留空，不写整页文案");
}

// ─────────────────────────────────────────────
console.log("\n[effectiveTier] 已存 tier 优先，缺失即时推断");
{
  assert(effectiveTier({ distanceTier: "NEAR" }) === "NEAR", "已存 distanceTier 直接采用");
  assert(effectiveTier({ city: "天津" }) === "OUT_OF_CITY", "无 tier 时按 city 推断 OUT_OF_CITY");
  assert(effectiveTier({}) === "UNKNOWN", "无任何信息 → UNKNOWN");
}

// ─────────────────────────────────────────────
console.log("\n[主投方向闸门 + 经验相关度]（2026-09-19：按签字方向与能力地图过滤/排序）");
{
  const { directionKeywords, matchesDirection, experienceRelevance, DEFAULT_DIRECTION_KEYWORDS } = await import("../src/scoring.js");
  assert(matchesDirection({ title: "外贸业务员" }), "外贸业务员 → 通过方向闸门");
  assert(matchesDirection({ title: "客服专员" }), "客服专员 → 通过方向闸门");
  assert(matchesDirection({ title: "软件测试工程师" }), "软件测试工程师 → 通过（能力地图结论 2：测试方向初级岗）");
  assert(!matchesDirection({ title: "后厨" }), "后厨 → 被方向闸门挡掉");
  assert(!matchesDirection({ title: "护工陪护" }), "护工陪护 → 被方向闸门挡掉");
  assert(!matchesDirection({ title: "中央空调维修普工" }), "空调维修普工 → 被方向闸门挡掉");
  const before = process.env.JOB_AGENT_DIRECTION_KEYWORDS;
  process.env.JOB_AGENT_DIRECTION_KEYWORDS = "只看这个";
  assert(directionKeywords().join(",") === "只看这个", ".env JOB_AGENT_DIRECTION_KEYWORDS 可覆盖默认方向词");
  assert(!matchesDirection({ title: "外贸业务员" }), "覆盖后默认词失效（确实以 env 为准）");
  if (before === undefined) delete process.env.JOB_AGENT_DIRECTION_KEYWORDS;
  else process.env.JOB_AGENT_DIRECTION_KEYWORDS = before;
  assert(directionKeywords().includes("外贸"), "默认方向词含外贸");
  assert(DEFAULT_DIRECTION_KEYWORDS.length >= 15, `默认方向词数量合理（${DEFAULT_DIRECTION_KEYWORDS.length}）`);

  const good = experienceRelevance({ title: "外贸业务员", description: "负责客户沟通、订单资料整理与文档归档，需要英语" });
  const bad = experienceRelevance({ title: "后厨", description: "负责备菜" });
  assert(good > bad, `能力地图词命中多 → 相关度更高（${good} vs ${bad}）`);
  assert(good >= 75 && good <= 100, `命中 3+ 词给到 75~100（${good}）`);
  assert(experienceRelevance({ title: "x" }) === 0, "无 JD 正文 → 相关度 0（不瞎猜）");
}

// 清理临时库
try { fs.unlinkSync(tmpDb); } catch {}

console.log("\n════════════════════════════════");
console.log(`M1 距离+宿舍模块: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("失败项：\n  " + failures.join("\n  "));
  process.exit(1);
}
