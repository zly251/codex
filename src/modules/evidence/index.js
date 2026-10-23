// M4 evidence 模块入口
// 职责：证据判定（岗位真实性、公司资质、薪资合理性），输出 EvidenceReceipt
// 纯函数，无 DB、无网络、无 LLM 依赖，不依赖旧链
// 架构层：L2 业务层，依赖方向 L2 → L1（契约），不依赖其他 L2 模块

export { SCHEMA_VERSION, EvidenceReceiptShape, validateEvidenceReceipt } from "./types.js";
export {
  checkJobAuthenticity,
  checkCompanyQualification,
  checkSalaryReasonableness,
  evaluateEvidence,
} from "./evidence.js";
