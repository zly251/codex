// M1 Ingest — Data Cleaner
// Extracted from src/scrapers/bossApi.js (_parseJobs, _pickCoord, _detectDormitoryFromCard).
// Pure data transformation: raw BOSS API items → JobDraft payloads with schemaVersion.
// No browser dependency, fully testable with mock data.

import { parseMonthlySalaryK } from "../../core/salary.js";
import { SCHEMA_VERSION } from "../../core/contracts/payloadContract.js";

// ══════════════════════════════════════════════════════════════════
// Constants
// ══════════════════════════════════════════════════════════════════

const DORM_RE = /宿舍|住宿|包住|食宿|包吃住/;

// ══════════════════════════════════════════════════════════════════
// Low-level parsing helpers (extracted from bossApi.js)
// ══════════════════════════════════════════════════════════════════

/**
 * Safely parse a JSON string field into an object.
 * @param {any} v - value that might be a stringified JSON
 * @returns {Object|null}
 */
function asObj(v) {
  if (v && typeof v === "object") return v;
  if (typeof v === "string" && v.length > 1 && (v[0] === "{" || v[0] === "[")) {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Parse a value into a finite number, optionally clamped by absMax.
 * Accepts numbers and numeric strings like "28.6".
 * @param {any} v
 * @param {number} [absMax] - if provided, values with |v| > absMax return null
 * @returns {number|null}
 */
function num(v, absMax) {
  let n = null;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && v.trim() !== "") n = Number(v);
  if (n == null || !Number.isFinite(n)) return null;
  if (absMax != null && Math.abs(n) > absMax) return null;
  return n;
}

/**
 * Defensively extract a coordinate (lat or lng) from a raw API item.
 * Checks top-level fields, then nested objects (geo/location/position).
 * @param {Object} item - raw BOSS API item
 * @param {string[]} topKeys - top-level field names to check (e.g. ["lat","latitude"])
 * @param {string[]} objKeys - nested object field names (e.g. ["geo","location","position"])
 * @param {string[]} innerKeys - keys inside nested objects
 * @param {number} absMax - max absolute value (90 for lat, 180 for lng)
 * @returns {number|null}
 */
function pickCoord(item, topKeys, objKeys, innerKeys, absMax) {
  for (const k of topKeys) {
    const n = num(item[k], absMax);
    if (n != null) return n;
  }
  for (const ok of objKeys) {
    const o = asObj(item[ok]);
    if (!o || typeof o !== "object") continue;
    for (const ik of innerKeys) {
      const n = num(o[ik], absMax);
      if (n != null) return n;
    }
  }
  return null;
}

/**
 * Extract latitude from a raw BOSS API item.
 * Checks top-level lat/latitude, then nested geo/location/position.lat.
 * Filters placeholder (0,0) via isPlausibleCoord at consumer side.
 * @param {Object} item
 * @returns {number|null}
 */
export function extractLat(item) {
  return pickCoord(item, ["lat", "latitude"], ["geo", "location", "position"], ["lat", "latitude"], 90);
}

/**
 * Extract longitude from a raw BOSS API item.
 * @param {Object} item
 * @returns {number|null}
 */
export function extractLng(item) {
  return pickCoord(item, ["lng", "lon", "longitude"], ["geo", "location", "position"], ["lng", "lon", "longitude"], 180);
}

/**
 * Detect dormitory signal from card welfare tags/labels.
 * Scans array fields (tags, labels, arrayName, markLabels, welfareList, skills, jobLabels)
 * and string fields. Returns true if any text matches DORM_RE.
 * @param {Object} item - raw BOSS API item
 * @returns {boolean}
 */
export function detectDormitoryFromCard(item) {
  const buckets = [];
  for (const key of ["tags", "labels", "arrayName", "markLabels", "welfareList", "skills", "jobLabels"]) {
    const raw = item[key];
    const v = asObj(raw);
    if (Array.isArray(v)) buckets.push(...v);
    else if (v && typeof v === "object") buckets.push(v);
    else if (typeof raw === "string") buckets.push(raw);
  }
  for (const b of buckets) {
    const text =
      typeof b === "string"
        ? b
        : b && (b.name || b.title || b.tagName)
          ? String(b.name || b.title || b.tagName)
          : "";
    if (text && DORM_RE.test(text)) return true;
  }
  return false;
}

// ══════════════════════════════════════════════════════════════════
// Deduplication (extracted from bossApi.js _parseJobs)
// ══════════════════════════════════════════════════════════════════

/**
 * Deduplicate raw API items by jobId (encryptJobId || jobId).
 * Uses a Set to track seen IDs, same as original _parseJobs.
 * @param {Object[]} items - raw API items
 * @returns {Object[]} deduplicated items (first occurrence wins)
 */
export function dedupJobs(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const id = item.encryptJobId || item.jobId || "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════
// JobDraft conversion
// ══════════════════════════════════════════════════════════════════

/**
 * Convert a raw BOSS API item into a JobDraft payload.
 * Applies salary parsing, coord extraction, dormitory detection.
 * Output conforms to JOB_DRAFT_SCHEMA with schemaVersion.
 * @param {Object} item - raw BOSS API item
 * @returns {Object} JobDraft-shaped object (schemaVersion, jobId, title, ...)
 */
export function rawItemToJobDraft(item) {
  const id = item.encryptJobId || item.jobId || "";
  const title = item.jobName || item.name || "";
  if (!title || !id) return null;

  const url = "https://www.zhipin.com/job_detail/" + id + ".html";
  const skillList = item.skills || item.technologyList || [];
  const salaryRaw = item.salaryDesc || item.salary || "";
  const parsedSalary = parseMonthlySalaryK(salaryRaw);

  let salaryMinK = null;
  let salaryMaxK = null;
  if (parsedSalary && typeof parsedSalary === "object") {
    salaryMinK = parsedSalary.min;
    salaryMaxK = parsedSalary.max;
  } else if (typeof parsedSalary === "number") {
    salaryMinK = parsedSalary;
    salaryMaxK = parsedSalary;
  }

  const lat = extractLat(item);
  const lng = extractLng(item);
  const dormHit = detectDormitoryFromCard(item);

  /** @type {Object} JobDraft */
  const draft = {
    schemaVersion: SCHEMA_VERSION,
    jobId: id,
    title: title,
    salary: salaryRaw || undefined,
    salaryMinK: salaryMinK ?? undefined,
    salaryMaxK: salaryMaxK ?? undefined,
    city: item.cityName || undefined,
    district: item.areaDistrict || item.brandDistrict || undefined,
    experience: item.jobExperience || undefined,
    education: item.jobDegree || undefined,
    description: item.jobDetail || undefined,
    tags: Array.isArray(skillList) ? skillList : undefined,
    companyName: (item.brandName || "").replace(/<[^>]*>/g, "").trim() || undefined,
    source: "boss_search",
    listedAt: Date.now(),
    status: "DRAFT",
  };

  // Attach coords as extra fields (not in JobDraft schema but useful for enrichment)
  if (lat != null) draft._lat = lat;
  if (lng != null) draft._lng = lng;

  if (dormHit) {
    draft.hasDormitory = true;
  }

  return draft;
}

/**
 * Full cleaning pipeline: dedup + convert to JobDraft.
 * @param {Object[]} items - raw API items
 * @returns {Object[]} JobDraft array (nulls filtered out)
 */
export function cleanSearchResults(items) {
  const deduped = dedupJobs(items);
  const drafts = [];
  for (const item of deduped) {
    const draft = rawItemToJobDraft(item);
    if (draft) drafts.push(draft);
  }
  return drafts;
}

/**
 * Safely stringify a value for rawData storage.
 * @param {any} v
 * @returns {string|null}
 */
export function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}
