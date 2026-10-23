/**
 * L1 契约层 - 索引
 * 导出所有契约定义和验证函数
 */

export {
  ADAPTER_CONTRACT_VERSION,
  ADAPTER_CONTRACT_DATE,
  assertAdapter,
} from "./adapterContract.js";

export {
  HTTP_CONTRACT_VERSION,
  HTTP_CONTRACT_DATE,
  ROUTES,
  matchRoute,
  extractParams,
  assertRoutes,
} from "./httpContract.js";

export {
  SCHEMA_VERSION,
  SCHEMA_DATE,
  checkSchemaVersion,
  JOB_DRAFT_SCHEMA,
  VALUE_CARD_SCHEMA,
  LOOK_RESPONSE_SCHEMA,
  EVIDENCE_RECEIPT_SCHEMA,
  validatePayload,
  validateJobDraft,
  validateValueCard,
  validateLookResponse,
  validateEvidenceReceipt,
} from "./payloadContract.js";

export {
  CONFIG_CONTRACT_VERSION,
  CONFIG_CONTRACT_DATE,
  CONFIG_SCHEMA,
  getConfigSchema,
  getConfigSchemaByModule,
  loadConfigFromEnv,
  validateConfig,
  filterSensitiveConfig,
} from "./configContract.js";
