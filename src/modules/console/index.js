// M5 console 模块入口
export { SCHEMA_VERSION, SummarySchema, DetailItemSchema, ConsoleResultSchema, validateConsoleResult } from "./types.js";
export { buildConsole, toMarkdown } from "./console.js";
export const CONSOLE_MODULE_VERSION = "1.0.0";
export const CONSOLE_MODULE_NAME = "console";
