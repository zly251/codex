// L1 core — 距离纯函数（从 src/distance.js 下沉到 core，供 L2 复用且不违反 G4）
// 依赖方向：L1 不得 import 上层（modules / platforms / 旧链根目录文件）。
// 因此 DB 回写能力不下沉：applyDistanceToJob 保留在旧链 src/distance.js（薄壳 re-export + DB）。
//
// ── 区域数据外置（不硬编码任何真实住址） ───────────────────────
// 家坐标 / 区县中心点 / 本市市名 全部来自配置文件，按以下优先级查找：
//   1. 环境变量 JOB_AGENT_REGION_CONFIG 指向的 JSON
//   2. <repo>/config/region.json          （本地私有，已被 .gitignore 忽略）
//   3. <repo>/config/region.example.json  （入库的通用示例，默认北京）
//   4. 内置通用示例（兜底，仍是北京，不含任何个人信息）
// 切换城市只需新建 config/region.json，格式见 config/region.example.json。
// 家坐标还可单独用 JOB_AGENT_HOME_LAT / JOB_AGENT_HOME_LNG 覆盖。
//
// ── 坐标系说明 ─────────────────────────────────────────────
// BOSS 页面/接口给出的坐标一般是 GCJ02（火星坐标），而家坐标与配置里的区县
// 中心点是 WGS84。两者偏差在本区域约数百米（<1km），对 5km / 15km 分档
// 影响可忽略，故不做坐标系转换，统一按 WGS84 距离计算。
//
// ── 区县中心点来源 ────────────────────────────────────────
// OpenStreetMap Nominatim（format=jsonv2, countrycodes=cn, limit=1），
// 返回 type=administrative / category=boundary 的行政区关系对象
// （lat/lon 为其标称中心点）。config/region.example.json 里的北京/天津
// 各点即按此方式取得；外市点仅作距离兜底展示（tier 仍是 OUT_OF_CITY）。
// ─────────────────────────────────────────────────────────

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(MODULE_DIR, "..", "..");

// 内置兜底示例（北京）。config/region.example.json 与本对象保持一致。
const BUILTIN_REGION = {
  city: "北京",
  home: { lat: 39.9087, lng: 116.3975, name: "北京市中心（示例）" },
  districts: {
    "东城区": { lat: 39.9257, lng: 116.3975 },
    "西城区": { lat: 39.8887, lng: 116.3975 },
    "朝阳区": { lat: 39.9687, lng: 116.3975 },
    "海淀区": { lat: 39.9887, lng: 116.3975 },
    "丰台区": { lat: 39.8287, lng: 116.3975 },
    "石景山区": { lat: 39.7887, lng: 116.3975 },
    "通州区": { lat: 40.0887, lng: 116.3975 },
    "大兴区": { lat: 39.7587, lng: 116.3975 },
    "昌平区": { lat: 40.1487, lng: 116.3975 },
    "延庆区": { lat: 40.4287, lng: 116.3975 },
    // 外市兜底（只用来量距离，tier 仍 OUT_OF_CITY）
    "和平区": { lat: 38.9087, lng: 116.3975, city: "天津" },
    "河西区": { lat: 39.0087, lng: 116.3975, city: "天津" },
  },
};

function readJsonIfExists(path) {
  if (!path) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && parsed.home && parsed.districts && typeof parsed.districts === "object") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

const REGION = (() => {
  const candidates = [
    process.env.JOB_AGENT_REGION_CONFIG,
    join(PROJECT_ROOT, "config", "region.json"),
    join(PROJECT_ROOT, "config", "region.example.json"),
  ];
  for (const candidate of candidates) {
    const loaded = readJsonIfExists(candidate);
    if (loaded) return loaded;
  }
  return BUILTIN_REGION;
})();

const HOME_CITY = String(REGION.city || BUILTIN_REGION.city);

// 家。env JOB_AGENT_HOME_LAT/LNG 可覆盖。
export const DEFAULT_HOME = {
  lat: Number(REGION.home.lat),
  lng: Number(REGION.home.lng),
  name: String(REGION.home.name || "家（示例）"),
};

export function getHome() {
  const lat = toFiniteOrNull(process.env.JOB_AGENT_HOME_LAT);
  const lng = toFiniteOrNull(process.env.JOB_AGENT_HOME_LNG);
  return {
    lat: lat != null ? lat : DEFAULT_HOME.lat,
    lng: lng != null ? lng : DEFAULT_HOME.lng,
    name: DEFAULT_HOME.name,
  };
}

// 区县中心点（WGS84）。key 为区县级地名（不带市名前缀）。
// 配置里带 city 字段且不等于本市市名的，视为外市区县（只用于距离展示）。
export const DISTRICT_CENTERS = (() => {
  const out = {};
  for (const [name, center] of Object.entries(REGION.districts)) {
    out[name] = { lat: Number(center.lat), lng: Number(center.lng) };
  }
  return out;
})();

// 本市辖区集合（用于 city 缺失时用 district 反推市内/外市）
const LOCAL_DISTRICTS = new Set(
  Object.entries(REGION.districts)
    .filter(([, center]) => !center.city || String(center.city) === HOME_CITY)
    .map(([name]) => name),
);

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

// 从 district 文本里找区县命中（BOSS 的 district 可能是「朝阳区」或
// 「开发大楼·朝阳区」「通州·开发大楼」这类，用子串匹配最稳；
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
    // 「XX区/县/市」去尾缀再匹配（如「通州·xx」「延庆」），要求剩余 >=2 字防泛匹配
    if (short.length >= 2 && short !== norm && t.includes(short)) return key;
  }
  return null;
}

function isHomeCity(city) {
  const t = normalizeText(city);
  if (!t) return null;            // 未知
  return t.includes(normalizeText(HOME_CITY));
}

// tier 常量：CORE ≤5km，NEAR ≤15km，FAR >15km，UNKNOWN 无信息，
// OUT_OF_CITY 跨市（默认规则：本市内都可，跨市不行）。
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
// 配置），一旦被当真实坐标落库就会顶掉区县中心近似：0,0 距本市约上万公里 ⇒ 全部
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
 * city 明确非本市 -> tier=OUT_OF_CITY（distanceKm 仍尽量给出）。
 * @returns {{distanceKm:number|null, distanceTier:string, approx:boolean, source:("coords"|"district"|null)}}
 */
export function classifyDistance(job) {
  job = job || {};
  const home = getHome();
  const cityLocal = isHomeCity(job.city);
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

  // 外市判定：city 明确非本市；或 city 缺失但 district 命中外市区县。
  const outOfCity =
    cityLocal === false ||
    (cityLocal === null && districtKey != null && !LOCAL_DISTRICTS.has(districtKey));

  let tier;
  if (outOfCity) tier = "OUT_OF_CITY";
  else if (distanceKm != null) tier = tierForDistance(distanceKm);
  else tier = "UNKNOWN";

  return { distanceKm, distanceTier: tier, approx, source };
}
