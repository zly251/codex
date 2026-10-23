// Test runner: supports module filtering via `npm test -- <module>`
// No arg → runs all tests in sequence (stops on first failure, like &&)
import { execSync } from "node:child_process";

const tests = [
  ["multiagent-flow", "node scripts/test-multiagent-flow.mjs"],
  ["reply-salary", "node scripts/test-reply-salary.mjs"],
  ["m1-distance", "node scripts/test-m1-distance.mjs"],
  ["m2-scheduler", "node scripts/test-m2-scheduler.mjs"],
  ["m3-llm", "node scripts/test-m3-llm.mjs"],
  ["autopilot", "node scripts/test-autopilot.mjs"],
  ["chat-summary", "node scripts/test-chat-summary.mjs"],
  ["human-rhythm", "node scripts/test-human-rhythm.mjs"],
  ["reply-delivery", "node scripts/test-reply-delivery.mjs"],
  ["v0-value", "node scripts/test-v0-value.mjs"],
  ["v0-extension-look", "node scripts/test-v0-extension-look.mjs"],
  // v2 架构 L2 模块测试（Phase 1）
  ["ingest", "node tests/modules/ingest/test-ingest.mjs"],
  ["value", "node tests/modules/value/test-value.mjs"],
  ["copilot", "node tests/modules/copilot/test-copilot.mjs"],
  ["evidence", "node tests/modules/evidence/evidence.test.mjs"],
  ["console", "node tests/modules/console/test-console.mjs"],
];

const filter = process.argv[2];

if (filter) {
  const match = tests.find(([name]) => name === filter);
  if (!match) {
    console.error(`Unknown test module: ${filter}`);
    console.error(`Available: ${tests.map((t) => t[0]).join(", ")}`);
    process.exit(1);
  }
  try {
    execSync(match[1], { stdio: "inherit", cwd: process.cwd() });
  } catch (e) {
    process.exit(e.status || 1);
  }
} else {
  for (const [name, cmd] of tests) {
    console.log(`\n━━━ ${name} ━━━`);
    try {
      execSync(cmd, { stdio: "inherit", cwd: process.cwd() });
    } catch (e) {
      process.exit(e.status || 1);
    }
  }
}
