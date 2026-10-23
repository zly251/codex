// M1 Ingest — Module Entry Point
// Exports the BOSS直聘 PlatformAdapter and sub-module utilities.
// L2 module: zero cross-import to other src/modules/* directories.

export { createBossAdapter } from "./bossAdapter.js";

export {
  // Cleaner
  dedupJobs,
  rawItemToJobDraft,
  cleanSearchResults,
  extractLat,
  extractLng,
  detectDormitoryFromCard,
  safeJson,
} from "./cleaner.js";

export {
  // Enricher
  enrichFromPage,
  normalizeEnrichPayload,
  enrichmentPatch,
  mergeEnrichment,
  stripWatermark,
} from "./enricher.js";

export const INGEST_MODULE_VERSION = "1.0.0";
export const INGEST_MODULE_NAME = "ingest";
