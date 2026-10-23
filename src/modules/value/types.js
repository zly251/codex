// M2 value 模块 — 类型定义与 schema 版本
// 纯函数，无 DB、无网络、无 LLM 依赖
// 架构层：L2 业务层。此文件定义本模块输出的结构契约，引用 L1 契约层的 SCHEMA_VERSION。

// 从 L1 契约层引入 schema 版本（VALUE_CARD_SCHEMA 要求 schemaVersion="1.0.0"）
export { SCHEMA_VERSION } from "../../core/contracts/payloadContract.js";
