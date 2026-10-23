// M1 Ingest — Detail Enricher
// Independent reimplementation of detail-page enrichment logic.
// Does NOT import from src/enrich.js (old chain); reuses only pure
// utilities from src/distance.js (isPlausibleCoord, matchDistrict) and
// src/core/contracts/payloadContract.js (SCHEMA_VERSION).
//
// Pipeline: enrichFromPage(page) → normalizeEnrichPayload → enrichmentPatch
// or: mergeEnrichment(draft, enriched) to produce an ENRICHED JobDraft.

import { isPlausibleCoord, matchDistrict } from "../../core/distance.js";
import { SCHEMA_VERSION } from "../../core/contracts/payloadContract.js";

// ══════════════════════════════════════════════════════════════════
// Constants
// ══════════════════════════════════════════════════════════════════

// Dormitory signal: appears in welfare tags, JD text, or requirements.
const DORM_RE = /宿舍|住宿|包住|食宿|包吃住/;

// BOSS anti-scrape watermark: randomly injects brand words into JD text
// (e.g. "岗boss位职责", "负kanzhun责"). Must strip before storage.
const WATERMARK_RE = /kanzhun|直聘|boss/gi;

// ══════════════════════════════════════════════════════════════════
// Text utilities
// ══════════════════════════════════════════════════════════════════

/**
 * Remove BOSS watermark words from text.
 * @param {string} text
 * @returns {string}
 */
export function stripWatermark(text) {
  return typeof text === "string" ? text.replace(WATERMARK_RE, "") : "";
}

function asText(v) {
  return typeof v === "string" ? v.trim() : "";
}

// ══════════════════════════════════════════════════════════════════
// Enrichment normalization
// ══════════════════════════════════════════════════════════════════

/**
 * Normalize a raw page.evaluate payload into a uniform enrichment result.
 * Any field missing → empty/0, never throws.
 * @param {Object} [payload] - raw {description, requirements, address, tags, lat, lng, fullText}
 * @returns {{description:string, requirements:string, hasDormitory:0|1, dormitorySource:string|null, address?:string, lat?:number, lng?:number}}
 */
export function normalizeEnrichPayload(payload) {
  payload = payload || {};
  const res = {
    description: stripWatermark(asText(payload.description)),
    requirements: stripWatermark(asText(payload.requirements)),
    hasDormitory: 0,
    dormitorySource: null,
  };

  // Clean address text (strip map link noise, common prefixes, collapse whitespace)
  const address = stripWatermark(asText(payload.address))
    .replace(/点击查看地图/g, " ")
    .replace(/工作地址\s*[:：]?\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (address) res.address = address;

  // Check welfare tags for dormitory signal
  const tags = Array.isArray(payload.tags) ? payload.tags : [];
  for (const t of tags) {
    const text =
      typeof t === "string"
        ? t
        : t && (t.name || t.text)
          ? String(t.name || t.text)
          : "";
    if (text && DORM_RE.test(stripWatermark(text))) {
      res.hasDormitory = 1;
      break;
    }
  }

  // Also check JD text / requirements / fullText for dormitory keywords
  if (!res.hasDormitory) {
    const fullText = stripWatermark(asText(payload.fullText));
    if (
      DORM_RE.test(res.description) ||
      DORM_RE.test(res.requirements) ||
      DORM_RE.test(fullText)
    ) {
      res.hasDormitory = 1;
    }
  }
  if (res.hasDormitory) res.dormitorySource = "detail";

  // Defensively extract coords (placeholder 0,0 filtered by isPlausibleCoord)
  const lat = Number(payload.lat);
  const lng = Number(payload.lng);
  if (isPlausibleCoord(lat, lng)) {
    res.lat = lat;
    res.lng = lng;
  }

  return res;
}

/**
 * Build a DB-ready patch from enrichment result.
 * Only includes non-empty fields (won't overwrite existing JD with empty string).
 * @param {Object} enriched - output of normalizeEnrichPayload
 * @returns {Object} patch for db.updateEnrichment()
 */
export function enrichmentPatch(enriched) {
  const out = {};
  if (!enriched) return out;
  if (enriched.description) out.description = enriched.description;
  if (enriched.requirements) out.requirements = enriched.requirements;
  if (enriched.lng != null) out.lng = enriched.lng;
  if (enriched.lat != null) out.lat = enriched.lat;
  // Address → district extraction (detail page address is the only source
  // when list card didn't include district)
  if (enriched.address) {
    const district = matchDistrict(enriched.address);
    if (district) out.district = district;
  }
  out.hasDormitory = enriched.hasDormitory ? 1 : 0;
  out.dormitorySource = enriched.dormitorySource || null;
  return out;
}

// ══════════════════════════════════════════════════════════════════
// Page extraction
// ══════════════════════════════════════════════════════════════════

/**
 * Extract JD text, requirements, tags, address, coords from a detail page.
 * page contract (either works, tests use mock):
 *   - page.evaluate(fn) → object {description, requirements, address, tags, fullText, lat, lng}
 *   - or page.content() → HTML string (regex fallback)
 * @param {Object} page - puppeteer page or mock
 * @returns {Promise<Object>} normalized enrichment result
 */
export async function enrichFromPage(page) {
  if (!page) throw new Error("enrichFromPage: page not provided");

  if (typeof page.evaluate === "function") {
    const payload = await page.evaluate(extractInPage).catch(() => null);
    if (payload && typeof payload === "object") return normalizeEnrichPayload(payload);
    // evaluate failed: fall back to content() if available
    if (typeof page.content !== "function") return normalizeEnrichPayload(null);
  }

  if (typeof page.content === "function") {
    const html = await page.content().catch(() => "");
    return normalizeEnrichPayload(extractFromHtml(html));
  }

  throw new Error("enrichFromPage: page must implement evaluate or content");
}

// Browser-context extraction function (no closure variables).
// Serialized and run via page.evaluate().
function extractInPage() {
  function txt(el) {
    return el ? String(el.textContent || "").trim() : "";
  }
  function q(sels) {
    for (var i = 0; i < sels.length; i++) {
      var el = document.querySelector(sels[i]);
      if (el && txt(el)) return el;
    }
    return null;
  }

  var descEl = q([
    ".job-sec-text",
    ".job-detail-section .text",
    "[class*=job-desc]",
    ".job-keyword-list",
    "#job-detail .job-sec-text",
  ]);
  var reqEl = q([".job-condition .text", ".requirements", "[class*=requirement]"]);
  var addrEl = q([
    ".location-address",
    "[class*=location-address]",
    ".job-location",
    "[class*=job-address]",
  ]);
  var tagEls = document.querySelectorAll(
    ".job-tags span, .tag-list li, [class*=label-item], .job-keyword-list li"
  );
  var tags = [];
  for (var i = 0; i < tagEls.length; i++) tags.push(txt(tagEls[i]));

  var out = {
    description: txt(descEl),
    requirements: txt(reqEl),
    address: txt(addrEl),
    tags: tags,
    fullText: "",
    lat: null,
    lng: null,
  };

  // Defensive coord extraction from page HTML (may have JSON-LD or data attributes)
  try {
    var html = document.documentElement.outerHTML;
    var mLat = html.match(/"lat(?:itude)?"\s*:\s*([0-9]+(?:\.[0-9]+)?)/);
    var mLng = html.match(/"(?:lng|lon|longitude)"\s*:\s*([0-9]+(?:\.[0-9]+)?)/);
    if (mLat && mLng) {
      out.lat = Number(mLat[1]);
      out.lng = Number(mLng[1]);
    }
  } catch (e) {}

  return out;
}

// Fallback: regex extraction from raw HTML string (when evaluate unavailable).
function extractFromHtml(html) {
  html = String(html || "");

  function stripTags(s) {
    return String(s || "")
      .replace(/<[^>]*>/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  var descMatch = html.match(/class="[^"]*job-sec-text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
  var tagMatches = [];
  var re = /class="[^"]*(?:job-tags|tag-list|label-item)[^"]*"[^>]*>([\s\S]*?)<\/(?:ul|div|span)>/g;
  var m;
  while ((m = re.exec(html)) !== null) tagMatches.push(stripTags(m[1]));

  var latMatch = html.match(/"lat(?:itude)?"\s*:\s*([0-9]+(?:\.[0-9]+)?)/);
  var lngMatch = html.match(/"(?:lng|lon|longitude)"\s*:\s*([0-9]+(?:\.[0-9]+)?)/);

  return {
    description: descMatch ? stripTags(descMatch[1]) : "",
    requirements: "",
    tags: tagMatches,
    fullText: stripTags(html).slice(0, 8000),
    lat: latMatch ? Number(latMatch[1]) : null,
    lng: lngMatch ? Number(lngMatch[1]) : null,
  };
}

// ══════════════════════════════════════════════════════════════════
// JobDraft merge
// ══════════════════════════════════════════════════════════════════

/**
 * Merge enrichment result into a JobDraft, producing an ENRICHED draft.
 * Updates description, tags, address, district, coords, dormitory, distance.
 * @param {Object} draft - JobDraft (DRAFT status)
 * @param {Object} enriched - output of normalizeEnrichPayload
 * @param {Object} [distanceInfo] - optional {distanceKm, distanceTier} from classifyDistance
 * @returns {Object} updated JobDraft with status="ENRICHED"
 */
export function mergeEnrichment(draft, enriched, distanceInfo) {
  const out = { ...draft };

  if (enriched.description) out.description = enriched.description;
  if (enriched.requirements) out.description = (out.description || "") + "\n\n[要求] " + enriched.requirements;
  if (enriched.address) out.address = enriched.address;
  if (enriched.lat != null) out._lat = enriched.lat;
  if (enriched.lng != null) out._lng = enriched.lng;

  // District from address
  if (enriched.address) {
    const district = matchDistrict(enriched.address);
    if (district) out.district = district;
  }

  // Dormitory
  if (enriched.hasDormitory) {
    out.hasDormitory = true;
  }

  // Distance
  if (distanceInfo) {
    if (distanceInfo.distanceKm != null) out.distanceKm = distanceInfo.distanceKm;
    if (distanceInfo.distanceTier) out.distanceTier = distanceInfo.distanceTier;
  }

  out.enrichedAt = Date.now();
  out.status = "ENRICHED";
  out.schemaVersion = SCHEMA_VERSION;

  return out;
}
