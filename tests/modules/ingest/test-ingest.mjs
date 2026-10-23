// M1 Ingest Module — Unit Tests
// Tests cleaner, enricher, and adapter with mock data (no browser/DB required).
// Pattern: simple assert(cond, msg) matching scripts/test-*.mjs style.
import assert from "node:assert/strict";

// ── Imports from module under test ──
import {
  dedupJobs,
  rawItemToJobDraft,
  cleanSearchResults,
  extractLat,
  extractLng,
  detectDormitoryFromCard,
  safeJson,
} from "../../../src/modules/ingest/cleaner.js";

import {
  stripWatermark,
  normalizeEnrichPayload,
  enrichmentPatch,
  enrichFromPage,
  mergeEnrichment,
} from "../../../src/modules/ingest/enricher.js";

import { createBossAdapter } from "../../../src/modules/ingest/bossAdapter.js";

// ── Contracts ──
import { assertAdapter } from "../../../src/core/contracts/adapterContract.js";
import { validateJobDraft, SCHEMA_VERSION } from "../../../src/core/contracts/payloadContract.js";

let passed = 0;
let failed = 0;
const failures = [];

function assertTrue(cond, msg) {
  if (cond) {
    passed++;
    console.log("  ✓ " + msg);
  } else {
    failed++;
    failures.push(msg);
    console.error("  ✗ " + msg);
  }
}

function assertEqual(actual, expected, msg) {
  assertTrue(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`
  );
}

// ══════════════════════════════════════════════════════════════════
// 1. Cleaner Tests
// ══════════════════════════════════════════════════════════════════

console.log("\n━━━ Cleaner Tests ━━━");

// -- dedupJobs --
(function testDedup() {
  const items = [
    { encryptJobId: "abc123", jobName: "C++ Engineer" },
    { encryptJobId: "abc123", jobName: "C++ Engineer (dup)" },
    { encryptJobId: "def456", jobName: "Java Engineer" },
  ];
  const out = dedupJobs(items);
  assertTrue(out.length === 2, "dedupJobs: 2 unique from 3 items");
  assertTrue(out[0].encryptJobId === "abc123", "dedupJobs: first occurrence wins");
  assertTrue(out[1].encryptJobId === "def456", "dedupJobs: second unique item kept");
})();

(function testDedupByJobId() {
  const items = [
    { jobId: "xyz", jobName: "Python Dev" },
    { encryptJobId: "xyz", jobName: "Python Dev (dup)" },
  ];
  const out = dedupJobs(items);
  assertTrue(out.length === 1, "dedupJobs: dedup by jobId OR encryptJobId");
})();

(function testDedupEmpty() {
  const out = dedupJobs([]);
  assertTrue(out.length === 0, "dedupJobs: empty input → empty output");
})();

// -- extractLat / extractLng --
(function testExtractCoord() {
  const item = { lat: 28.65, lng: 121.42 };
  assertTrue(extractLat(item) === 28.65, "extractLat: top-level lat");
  assertTrue(extractLng(item) === 121.42, "extractLng: top-level lng");
})();

(function testExtractCoordNested() {
  const item = { geo: { lat: "30.25", lng: "120.19" } };
  assertTrue(extractLat(item) === 30.25, "extractLat: nested geo.lat (string)");
  assertTrue(extractLng(item) === 120.19, "extractLng: nested geo.lng (string)");
})();

(function testExtractCoordAbsMax() {
  const item = { lat: 200, lng: 500 };
  assertTrue(extractLat(item) === null, "extractLat: out of range (lat>90) → null");
  assertTrue(extractLng(item) === null, "extractLng: out of range (lng>180) → null");
})();

(function testExtractCoordMissing() {
  const item = { jobName: "test" };
  assertTrue(extractLat(item) === null, "extractLat: missing → null");
  assertTrue(extractLng(item) === null, "extractLng: missing → null");
})();

// -- detectDormitoryFromCard --
(function testDetectDormitory() {
  const item = { tags: ["五险一金", "包住", "弹性工作"] };
  assertTrue(detectDormitoryFromCard(item) === true, "detectDormitory: '包住' in tags → true");
})();

(function testDetectDormitoryWelfare() {
  const item = { welfareList: [{ name: "住宿" }] };
  assertTrue(detectDormitoryFromCard(item) === true, "detectDormitory: '住宿' in welfareList → true");
})();

(function testDetectDormitoryNone() {
  const item = { tags: ["五险一金", "弹性工作"] };
  assertTrue(detectDormitoryFromCard(item) === false, "detectDormitory: no dorm keyword → false");
})();

(function testDetectDormitoryStringField() {
  const item = { labels: "宿舍免费" };
  assertTrue(detectDormitoryFromCard(item) === true, "detectDormitory: '宿舍' in string field → true");
})();

// -- rawItemToJobDraft --
(function testRawItemToJobDraft() {
  const item = {
    encryptJobId: "abc123def456",
    jobName: "高级C++工程师",
    salaryDesc: "15-25K",
    cityName: "台州",
    areaDistrict: "椒江区",
    jobExperience: "3-5年",
    jobDegree: "本科",
    skills: ["C++", "Linux", "多线程"],
    brandName: "<b>某科技公司</b>",
  };
  const draft = rawItemToJobDraft(item);
  assertTrue(draft !== null, "rawItemToJobDraft: returns non-null");
  assertTrue(draft.schemaVersion === SCHEMA_VERSION, "rawItemToJobDraft: schemaVersion set");
  assertTrue(draft.jobId === "abc123def456", "rawItemToJobDraft: jobId correct");
  assertTrue(draft.title === "高级C++工程师", "rawItemToJobDraft: title correct");
  assertTrue(draft.salary === "15-25K", "rawItemToJobDraft: salary raw text");
  assertTrue(draft.salaryMinK === 15, "rawItemToJobDraft: salaryMinK parsed (15)");
  assertTrue(draft.salaryMaxK === 25, "rawItemToJobDraft: salaryMaxK parsed (25)");
  assertTrue(draft.city === "台州", "rawItemToJobDraft: city correct");
  assertTrue(draft.district === "椒江区", "rawItemToJobDraft: district correct");
  assertTrue(draft.companyName === "某科技公司", "rawItemToJobDraft: companyName HTML stripped");
  assertTrue(Array.isArray(draft.tags) && draft.tags.length === 3, "rawItemToJobDraft: tags array");
  assertTrue(draft.source === "boss_search", "rawItemToJobDraft: source = boss_search");
  assertTrue(draft.status === "DRAFT", "rawItemToJobDraft: status = DRAFT");
})();

(function testRawItemToJobDraftMissingId() {
  const item = { jobName: "No ID Job" };
  assertTrue(rawItemToJobDraft(item) === null, "rawItemToJobDraft: missing id → null");
})();

(function testRawItemToJobDraftMissingTitle() {
  const item = { encryptJobId: "abc" };
  assertTrue(rawItemToJobDraft(item) === null, "rawItemToJobDraft: missing title → null");
})();

// -- cleanSearchResults --
(function testCleanSearchResults() {
  const items = [
    { encryptJobId: "a1", jobName: "Job A", salaryDesc: "10K" },
    { encryptJobId: "a1", jobName: "Job A (dup)" },
    { encryptJobId: "b2", jobName: "Job B", salaryDesc: "面议" },
    {},
  ];
  const drafts = cleanSearchResults(items);
  assertTrue(drafts.length === 2, "cleanSearchResults: 2 drafts from 4 items (1 dup, 1 empty)");
  assertTrue(drafts[0].jobId === "a1", "cleanSearchResults: first draft jobId");
  assertTrue(drafts[1].jobId === "b2", "cleanSearchResults: second draft jobId");
  assertTrue(drafts[1].salaryMinK === undefined, "cleanSearchResults: '面议' salary → undefined minK");
})();

// -- safeJson --
(function testSafeJson() {
  assertTrue(safeJson({ a: 1 }) === '{"a":1}', "safeJson: object → JSON string");
  assertTrue(safeJson(undefined) === undefined, "safeJson: undefined → undefined (JSON.stringify behavior)");
})();

// -- validateJobDraft on cleaner output --
(function testCleanerOutputValidates() {
  const item = {
    encryptJobId: "test123",
    jobName: "测试岗位",
    salaryDesc: "8-12K",
    cityName: "台州",
  };
  const draft = rawItemToJobDraft(item);
  const result = validateJobDraft(draft);
  assertTrue(result.valid, "validateJobDraft: cleaner output passes payload validation");
  assertTrue(result.errors.length === 0, "validateJobDraft: no errors on valid draft");
})();

// ══════════════════════════════════════════════════════════════════
// 2. Enricher Tests
// ══════════════════════════════════════════════════════════════════

console.log("\n━━━ Enricher Tests ━━━");

// -- stripWatermark --
(function testStripWatermark() {
  assertTrue(stripWatermark("岗boss位职责") === "岗位职责", "stripWatermark: removes 'boss'");
  assertTrue(stripWatermark("负kanzhun责") === "负责", "stripWatermark: removes 'kanzhun'");
  assertTrue(stripWatermark("BOSS直聘招聘") === "招聘", "stripWatermark: removes 'BOSS直聘'");
  assertTrue(stripWatermark("") === "", "stripWatermark: empty string");
  assertTrue(stripWatermark(123) === "", "stripWatermark: non-string → empty");
})();

// -- normalizeEnrichPayload --
(function testNormalizeEmpty() {
  const res = normalizeEnrichPayload(null);
  assertTrue(res.description === "", "normalizeEnrichPayload: null → empty description");
  assertTrue(res.hasDormitory === 0, "normalizeEnrichPayload: null → hasDormitory=0");
  assertTrue(res.dormitorySource === null, "normalizeEnrichPayload: null → dormitorySource=null");
})();

(function testNormalizeWithDormitoryTag() {
  const res = normalizeEnrichPayload({
    description: "负责boss开发",
    tags: ["五险一金", "包住"],
  });
  assertTrue(res.description === "负责开发", "normalizeEnrichPayload: strips watermark from description");
  assertTrue(res.hasDormitory === 1, "normalizeEnrichPayload: '包住' in tags → hasDormitory=1");
  assertTrue(res.dormitorySource === "detail", "normalizeEnrichPayload: dormitorySource=detail");
})();

(function testNormalizeWithDormitoryInText() {
  const res = normalizeEnrichPayload({
    description: "提供食宿，待遇从优",
    tags: [],
  });
  assertTrue(res.hasDormitory === 1, "normalizeEnrichPayload: '食宿' in description → hasDormitory=1");
})();

(function testNormalizeNoDormitory() {
  const res = normalizeEnrichPayload({
    description: "负责后端开发",
    tags: ["五险一金", "弹性工作"],
  });
  assertTrue(res.hasDormitory === 0, "normalizeEnrichPayload: no dorm keyword → hasDormitory=0");
})();

(function testNormalizeAddress() {
  const res = normalizeEnrichPayload({
    address: "点击查看地图 工作地址 台州椒江区飞跃科创园",
  });
  assertTrue(res.address === "台州椒江区飞跃科创园", "normalizeEnrichPayload: address cleaned (map link + prefix stripped)");
})();

(function testNormalizeCoord() {
  const res = normalizeEnrichPayload({ lat: 28.65, lng: 121.42 });
  assertTrue(res.lat === 28.65 && res.lng === 121.42, "normalizeEnrichPayload: plausible coord kept");
})();

(function testNormalizeCoordZero() {
  const res = normalizeEnrichPayload({ lat: 0, lng: 0 });
  assertTrue(res.lat === undefined, "normalizeEnrichPayload: 0,0 placeholder → no coord");
})();

// -- enrichmentPatch --
(function testEnrichmentPatch() {
  const enriched = {
    description: "JD text here",
    requirements: "本科以上",
    hasDormitory: 1,
    dormitorySource: "detail",
    lat: 28.65,
    lng: 121.42,
    address: "台州椒江区某路123号",
  };
  const patch = enrichmentPatch(enriched);
  assertTrue(patch.description === "JD text here", "enrichmentPatch: description");
  assertTrue(patch.requirements === "本科以上", "enrichmentPatch: requirements");
  assertTrue(patch.hasDormitory === 1, "enrichmentPatch: hasDormitory=1");
  assertTrue(patch.dormitorySource === "detail", "enrichmentPatch: dormitorySource");
  assertTrue(patch.lat === 28.65, "enrichmentPatch: lat");
  assertTrue(patch.lng === 121.42, "enrichmentPatch: lng");
  assertTrue(patch.district === "椒江区", "enrichmentPatch: district extracted from address");
})();

(function testEnrichmentPatchEmpty() {
  const patch = enrichmentPatch(null);
  assertTrue(Object.keys(patch).length === 0, "enrichmentPatch: null → empty patch");
})();

// -- enrichFromPage with mock page (evaluate) --
(function testEnrichFromPageEvaluate() {
  const mockPage = {
    evaluate: async (fn) => {
      // Simulate page.evaluate: run the extraction function with a fake document
      return {
        description: "负责后端kanzhun开发",
        requirements: "本科",
        address: "工作地址 台州黄岩区某大厦",
        tags: ["包住", "五险"],
        fullText: "",
        lat: 28.65,
        lng: 121.42,
      };
    },
  };
  const res = enrichFromPage(mockPage).then((r) => {
    assertTrue(r.description === "负责后端开发", "enrichFromPage(evaluate): watermark stripped");
    assertTrue(r.hasDormitory === 1, "enrichFromPage(evaluate): dormitory detected from tags");
    assertTrue(r.lat === 28.65, "enrichFromPage(evaluate): coord kept");
  });
})();

// -- enrichFromPage with mock page (content fallback) --
(function testEnrichFromPageContent() {
  const mockPage = {
    evaluate: async () => {
      throw new Error("evaluate not available");
    },
    content: async () => '<div class="job-sec-text">JD text here</div>',
  };
  enrichFromPage(mockPage).then((r) => {
    assertTrue(r.description === "JD text here", "enrichFromPage(content): description extracted from HTML");
  });
})();

// -- enrichFromPage null page --
(function testEnrichFromPageNull() {
  enrichFromPage(null).catch((e) => {
    assertTrue(e.message.includes("not provided"), "enrichFromPage(null): throws error");
  });
})();

// -- mergeEnrichment --
(function testMergeEnrichment() {
  const draft = {
    schemaVersion: SCHEMA_VERSION,
    jobId: "test123",
    title: "测试岗位",
    status: "DRAFT",
  };
  const enriched = {
    description: "JD text",
    hasDormitory: 1,
    dormitorySource: "detail",
    address: "台州椒江区某路",
  };
  const distanceInfo = { distanceKm: 3.2, distanceTier: "CORE" };
  const merged = mergeEnrichment(draft, enriched, distanceInfo);
  assertTrue(merged.description === "JD text", "mergeEnrichment: description set");
  assertTrue(merged.hasDormitory === true, "mergeEnrichment: hasDormitory set");
  assertTrue(merged.distanceKm === 3.2, "mergeEnrichment: distanceKm set");
  assertTrue(merged.distanceTier === "CORE", "mergeEnrichment: distanceTier set");
  assertTrue(merged.status === "ENRICHED", "mergeEnrichment: status = ENRICHED");
  assertTrue(typeof merged.enrichedAt === "number", "mergeEnrichment: enrichedAt set");
  assertTrue(merged.district === "椒江区", "mergeEnrichment: district extracted from address");
})();

// ══════════════════════════════════════════════════════════════════
// 3. Adapter Tests
// ══════════════════════════════════════════════════════════════════

console.log("\n━━━ Adapter Tests ━━━");

// -- assertAdapter compliance --
(function testAdapterContract() {
  const adapter = createBossAdapter(null);
  const result = assertAdapter(adapter);
  assertTrue(result.valid, "assertAdapter: adapter passes contract validation");
  assertTrue(result.errors.length === 0, "assertAdapter: no errors (errors: " + JSON.stringify(result.errors) + ")");
  console.log("    (warnings: " + (result.warnings.length ? result.warnings.join("; ") : "none") + ")");
})();

// -- getPlatformConfig --
(function testPlatformConfig() {
  const adapter = createBossAdapter(null);
  const config = adapter.getPlatformConfig();
  assertTrue(config.baseUrl === "https://www.zhipin.com", "getPlatformConfig: baseUrl correct");
  assertTrue(typeof config.selectors === "object", "getPlatformConfig: selectors object");
  assertTrue(typeof config.rateLimit === "object", "getPlatformConfig: rateLimit object");
  assertTrue(config.selectors.jobCard === ".job-card-box", "getPlatformConfig: jobCard selector");
})();

// -- getRateLimit --
(function testRateLimit() {
  const adapter = createBossAdapter(null);
  const rl = adapter.getRateLimit();
  assertTrue(rl.searchPerHour === 30, "getRateLimit: searchPerHour=30");
  assertTrue(rl.detailPerMinute === 10, "getRateLimit: detailPerMinute=10");
  assertTrue(rl.chatPerDay === 50, "getRateLimit: chatPerDay=50");
})();

// -- getSupportedCities --
(function testSupportedCities() {
  const adapter = createBossAdapter(null);
  const cities = adapter.getSupportedCities();
  assertTrue(Array.isArray(cities), "getSupportedCities: returns array");
  assertTrue(cities.includes("台州"), "getSupportedCities: includes 台州");
  assertTrue(cities.includes("杭州"), "getSupportedCities: includes 杭州");
  assertTrue(cities.length === 9, "getSupportedCities: 9 cities");
})();

// -- isValidJobId --
(function testIsValidJobId() {
  const adapter = createBossAdapter(null);
  assertTrue(adapter.isValidJobId("abc123XYZ789") === true, "isValidJobId: valid alphanumeric");
  assertTrue(adapter.isValidJobId("short") === false, "isValidJobId: too short → false");
  assertTrue(adapter.isValidJobId("") === false, "isValidJobId: empty → false");
  assertTrue(adapter.isValidJobId(null) === false, "isValidJobId: null → false");
  assertTrue(adapter.isValidJobId("valid-id_with-special") === true, "isValidJobId: with - and _ chars");
})();

// -- adapter name/version --
(function testAdapterMeta() {
  const adapter = createBossAdapter(null);
  assertTrue(adapter.name === "boss", "adapter.name = 'boss'");
  assertTrue(adapter.version === "1.0.0", "adapter.version = '1.0.0'");
})();

// -- adapter config methods return copies (immutability) --
(function testConfigImmutability() {
  const adapter = createBossAdapter(null);
  const config1 = adapter.getPlatformConfig();
  config1.baseUrl = "modified";
  const config2 = adapter.getPlatformConfig();
  assertTrue(config2.baseUrl === "https://www.zhipin.com", "getPlatformConfig: returns copy (immutable)");
})();

// ══════════════════════════════════════════════════════════════════
// 4. Integration: Cleaner → Enricher → JobDraft pipeline
// ══════════════════════════════════════════════════════════════════

console.log("\n━━━ Integration Tests ━━━");

(function testFullPipeline() {
  // Simulate raw API item → clean → enrich → merge → validate
  const rawItem = {
    encryptJobId: "integ_test_001",
    jobName: "全栈工程师",
    salaryDesc: "12-20K·14薪",
    cityName: "台州",
    areaDistrict: "椒江区",
    jobExperience: "3-5年",
    jobDegree: "本科",
    skills: ["React", "Node.js"],
    brandName: "测试公司",
    tags: ["五险一金", "包住"],
  };

  // Step 1: Clean
  const drafts = cleanSearchResults([rawItem]);
  assertTrue(drafts.length === 1, "pipeline: cleanSearchResults → 1 draft");
  const draft = drafts[0];
  assertTrue(draft.hasDormitory === true, "pipeline: dormitory detected from card tags");
  assertTrue(draft.salaryMinK === 12, "pipeline: salaryMinK=12");
  assertTrue(draft.salaryMaxK === 20, "pipeline: salaryMaxK=20");

  // Step 2: Validate draft
  const validationResult = validateJobDraft(draft);
  assertTrue(validationResult.valid, "pipeline: DRAFT validates against schema");

  // Step 3: Enrich (mock)
  const enriched = normalizeEnrichPayload({
    description: "负责全栈kanzhun开发",
    tags: ["包住"],
    address: "工作地址 台州椒江区某大厦5楼",
    lat: 28.67,
    lng: 121.43,
  });

  // Step 4: Merge
  const merged = mergeEnrichment(draft, enriched, {
    distanceKm: 2.5,
    distanceTier: "CORE",
  });
  assertTrue(merged.status === "ENRICHED", "pipeline: merged status = ENRICHED");
  assertTrue(merged.description === "负责全栈开发", "pipeline: watermark stripped in merged");
  assertTrue(merged.hasDormitory === true, "pipeline: dormitory preserved in merged");
  assertTrue(merged.distanceTier === "CORE", "pipeline: distance tier set");

  // Step 5: Validate merged
  const mergedValidation = validateJobDraft(merged);
  assertTrue(mergedValidation.valid, "pipeline: ENRICHED draft validates against schema");
})();

// ══════════════════════════════════════════════════════════════════
// Summary
// ══════════════════════════════════════════════════════════════════

console.log("\n╔════════════════════════════════════════════╗");
console.log(`║  M1 Ingest Tests: ${passed} passed, ${failed} failed`);
console.log("╚════════════════════════════════════════════╝");

if (failed > 0) {
  console.error("\n❌ Failures:");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
} else {
  console.log("\n✅ All tests passed!");
}
