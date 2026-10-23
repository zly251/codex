// M2 value 模块入口
// 职责：含金量卡计算（五险一金、个税、通勤、到手/可支配），输出 ValueCard
// 纯函数，无 DB、无网络、无 LLM 依赖，不依赖旧链
// 架构层：L2 业务层，依赖方向 L2 → L1（契约），不依赖其他 L2 模块

export { SCHEMA_VERSION } from "./types.js";

export {
  SOCIAL_RATES,
  FUND_RATE,
  TAX_THRESHOLD,
  COMMUTE_MODES,
  computeInsurance,
  computeTax,
  computeCommute,
  buildBreakdown,
  computeValueCard,
} from "./calculator.js";

export {
  toValueCard,
  computeValueCardFromJob,
} from "./adapter.js";
