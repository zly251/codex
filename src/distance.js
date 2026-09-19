// Autonomous Job Search Agent
// M1: 距离（通勤）维度。家坐标 + 区县中心点表 + haversine + 分档。
//
// ── 坐标系说明 ─────────────────────────────────────────────
// BOSS 页面/接口给出的坐标一般是 GCJ02（火星坐标），而家坐标与下面的区县
// 中心点是 WGS84。两者偏差在本区域约数百米（<1km），对 5km / 15km 分档
// 影响可忽略，故不做坐标系转换，统一按 WGS84 距离计算。
//
// ── DISTRICT_CENTERS 来源 ─────────────────────────────────
// OpenStreetMap Nominatim（format=jsonv2, countrycodes=cn, limit=1），
// 本机实查于 2026-09-19 19:57 (本地时间)，查询词为「台州市XX区」/
// 「杭州市XX区」，返回均为 type=administrative / category=boundary 的
// 行政区关系对象（lat/lon 为其标称中心点）。全部 14 个地名均命中，无
// 「未验证」项。杭州 6 区仅作外市岗位距离兜底展示（tier 仍是 OUT_OF_CITY）。
// ─────────────────────────────────────────────────────────

import * as jobDb from "./db/job.js";

// 家（用户指定：台州椒江大润发，WGS84）。env JOB_AGENT_HOME_LAT/LNG 可覆盖。
export const DEFAULT_HOME = { lat: 28.6478331, lng: 121.4233538, name: "台州椒江大润发" };

export function getHome() {
  const lat = toFiniteOrNull(process.env.JOB_AGENT_HOME_LAT);
  const lng = toFiniteOrNull(process.env.JOB_AGENT_HOME_LNG);
  return {
    lat: lat != null ? lat : DEFAULT_HOME.lat,
    lng: lng != null ? lng : DEFAULT_HOME.lng,
    name: DEFAULT_HOME.name,
  };
}

// Nominatim 实查中心点（WGS84）。key 为区县级地名（不带市名前缀）。
export const DISTRICT_CENTERS = {
  // 台州市
  "椒江区": { lat: 28.6758042, lng: 121.4385711 },
  "黄岩区": { lat: 28.6531900, lng: 121.2576325 },
  "路桥区": { lat: 28.5818718, lng: 121.3338807 },
  "临海市": { lat: 28.8616886, lng: 121.1402223 },
  "温岭市": { lat: 28.3761941, lng: 121.3808408 },
  "玉环市": { lat: 28.1395469, lng: 121.2276288 },
  "天台县": { lat: 29.1467362, lng: 121.0024612 },
  "仙居县": { lat: 28.8499577, lng: 120.7251018 },
  // 杭州市（兜底：外市岗位也能量出距离，tier 仍 OUT_OF_CITY）
  "上城区": { lat: 30.2286780, lng: 120.1930825 },
  "拱墅区": { lat: 30.3213481, lng: 120.1367060 },
  "西湖区": { lat: 30.2616958, lng: 120.1256628 },
  "滨江区": { lat: 30.2109815, lng: 120.2072296 },
  "余杭区": { lat: 30.2762431, lng: 119.9746471 },
  "萧山区": { lat: 30.1861821, lng: 120.2597528 },
};

// 台州辖区集合（用于 city 缺失时用 district 反推市内/外市）
const TAIZHOU_DISTRICTS = new Set([
  "椒江区", "黄岩区", "路桥区", "临海市", "温岭市", "玉环市", "天台县", "仙居县",
]);

const EARTH_R_KM = 6371.0088;

function toRad(deg) { return (deg * Math.PI) / 180; }

// 标准 haversine 大圆距离（km）。a/b = {lat, lng}。
export function haversineKm(a, b) {
  if (!a || !b) return null;
  const lat1 = Number(a.lat), lng1 = Number(a.lng);
  const lat2 = Number(b.lat), lng2 = Number(b.lng);
  if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) return null;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

function normalizeText(v) {
  return String(v == null ? "" : v).replace(/[\s·・\-—_]/g, "");
}

// 从 district 文本里找区县命中（BOSS 的 district 可能是「椒江区」或
// 「开发大楼·椒江区」「路桥·开发大楼」这类，用子串匹配最稳；
// 兜底：去掉「区/市/县」后缀再匹配一次）。
export function matchDistrict(districtText) {
  const t = normalizeText(districtText);
  if (!t) return null;
  const keys = Object.keys(DISTRICT_CENTERS);
  for (const key of keys) {
    if (t.includes(normalizeText(key))) return key;
  }
  for (const key of keys) {
    const norm = normalizeText(key);
    const short = norm.replace(/[区县市]$/, "");
    // 「XX区/县/市」去尾缀再匹配（如「路桥·xx」「玉环」），要求剩余 >=2 字防泛匹配
    if (short.length >= 2 && short !== norm && t.includes(short)) return key;
  }
  return null;
}

function isTaizhouCity(city) {
  const t = normalizeText(city);
  if (!t) return null;            // 未知
  return t.includes("台州");
}

// tier 常量：CORE ≤5km，NEAR ≤15km，FAR >15km，UNKNOWN 无信息，
// OUT_OF_CITY 跨市（用户规则：台州市内都可，跨市不行）。
export const TIERS = ["CORE", "NEAR", "FAR", "UNKNOWN", "OUT_OF_CITY"];

export function tierForDistance(km) {
  if (!Number.isFinite(km)) return "UNKNOWN";
  if (km <= 5) return "CORE";
  if (km <= 15) return "NEAR";
  return "FAR";
}

function toFiniteOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// 坐标可信度。BOSS 详情页里存在 "lat":0 / "lng":0 这类占位值（页面脚本注入的默认
// 配置），一旦被当真实坐标落库就会顶掉区县中心近似：0,0 距台州约 1.3 万公里 ⇒ 全部
// 岗位变 FAR（而 FAR 无宿舍直接 IGNORE）。只认中国境内的坐标。
export function isPlausibleCoord(lat, lng) {
  return (
    Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= 3 && lat <= 54 && lng >= 73 && lng <= 136
  );
}

/**
 * 计算岗位距离信息（纯函数，不碰 DB）。
 * 优先级：可信真实坐标 > 区县中心近似 > UNKNOWN（坐标不可信时按无坐标处理）。
 * city 明确非台州 -> tier=OUT_OF_CITY（distanceKm 仍尽量给出）。
 * @returns {{distanceKm:number|null, distanceTier:string, approx:boolean, source:("coords"|"district"|null)}}
 */
export function classifyDistance(job) {
  job = job || {};
  const home = getHome();
  const cityTAI = isTaizhouCity(job.city);
  const districtKey = matchDistrict(job.district);

  const lng = toFiniteOrNull(job.lng);
  const lat = toFiniteOrNull(job.lat);

  let distanceKm = null;
  let approx = false;
  let source = null;

  if (isPlausibleCoord(lat, lng)) {
    distanceKm = haversineKm(home, { lat, lng });
    source = "coords";
  } else if (districtKey) {
    distanceKm = haversineKm(home, DISTRICT_CENTERS[districtKey]);
    approx = true;
    source = "district";
  }

  // 外市判定：city 明确非台州；或 city 缺失但 district 命中杭州等外市区县。
  const outOfCity =
    cityTAI === false ||
    (cityTAI === null && districtKey != null && !TAIZHOU_DISTRICTS.has(districtKey));

  let tier;
  if (outOfCity) tier = "OUT_OF_CITY";
  else if (distanceKm != null) tier = tierForDistance(distanceKm);
  else tier = "UNKNOWN";

  return { distanceKm, distanceTier: tier, approx, source };
}

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
