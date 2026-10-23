#!/usr/bin/env node
// M4 evidence 模块测试入口
// 运行：node scripts/test-evidence.mjs  或  npm test -- evidence
// 直接转发到 tests/modules/evidence/evidence.test.mjs
import { pathToFileURL } from "url";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const testFile = join(__dirname, "..", "tests", "modules", "evidence", "evidence.test.mjs");

await import(pathToFileURL(testFile).href);
