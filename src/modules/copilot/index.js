// M3 copilot 模块入口
export { SCHEMA_VERSION, SuggestionSchema, CopilotResultSchema, validateCopilotResult } from "./types.js";
export { generateSuggestions } from "./copilot.js";
export const COPILOT_MODULE_VERSION = "1.0.0";
export const COPILOT_MODULE_NAME = "copilot";
