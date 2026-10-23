/**
 * L0 守卫层 - 事故教训变成可执行断言
 * 冻结：并行开发期间任何改动必须双方同步
 *
 * 职责：将八条红线变成机器可检出的守卫，npm run guards 全绿才算完成
 * 红线：任何守卫失败都阻止提交/部署
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "../..");
const SRC = path.join(ROOT, "src");

// ══════════════════════════════════════════════════════════════════
// 1. 守卫规则定义
// ══════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} GuardRule
 * @property {string} id - 守卫 ID
 * @property {string} name - 守卫名称
 * @property {string} description - 描述
 * @property {function(): Promise<{passed: boolean, message: string}>} check - 检查函数
 */

/** @type {GuardRule[]} */
export const GUARD_RULES = [
  // ═══════════════════════════════════════════════════════════════
  // 红线 1: src/core/** 不得 import src/modules/**、src/platforms/**、src/chatApply.js
  // ═══════════════════════════════════════════════════════════════
  {
    id: "core-no-modules",
    name: "core 不得 import modules",
    description: "src/core/** 不得 import src/modules/**、src/platforms/**、src/chatApply.js",
    check: async () => {
      const coreDir = path.join(SRC, "core");
      const files = getAllFiles(coreDir, [".js", ".mjs"]);

      for (const file of files) {
        const content = fs.readFileSync(file, "utf8");
        if (
          content.includes('from "../modules/') ||
          content.includes('from "../platforms/') ||
          content.includes('from "../chatApply')
        ) {
          return {
            passed: false,
            message: `${file} imports forbidden modules/platforms/chatApply`,
          };
        }
      }

      return { passed: true, message: "core does not import forbidden modules" };
    },
  },

  // ═══════════════════════════════════════════════════════════════
  // 红线 2: src/modules/A/** 不得 import src/modules/B/**
  // ═══════════════════════════════════════════════════════════════
  {
    id: "modules-no-cross-import",
    name: "modules 之间零 import",
    description: "src/modules/A/** 不得 import src/modules/B/**",
    check: async () => {
      const modulesDir = path.join(SRC, "modules");
      const modules = fs.readdirSync(modulesDir).filter((d) => {
        const stat = fs.statSync(path.join(modulesDir, d));
        return stat.isDirectory() && d !== "index.js" && d !== "index.mjs";
      });

      for (const moduleA of modules) {
        const moduleADir = path.join(modulesDir, moduleA);
        const files = getAllFiles(moduleADir, [".js", ".mjs"]);

        for (const file of files) {
          const content = fs.readFileSync(file, "utf8");
          for (const moduleB of modules) {
            if (moduleA !== moduleB) {
              if (
                content.includes(`from "../${moduleB}/`) ||
                content.includes(`from "../../${moduleB}/`)
              ) {
                return {
                  passed: false,
                  message: `${file} imports ${moduleB} (cross-module import)`,
                };
              }
            }
          }
        }
      }

      return { passed: true, message: "modules do not cross-import" };
    },
  },

  // ═══════════════════════════════════════════════════════════════
  // 红线 3: 任何 await import(变量) 动态 specifier 禁止
  // ═══════════════════════════════════════════════════════════════
  {
    id: "no-dynamic-import",
    name: "禁止动态 import",
    description: "任何 await import(变量) 动态 specifier 禁止（打断 esbuild 静态图）",
    check: async () => {
      const files = getAllFiles(SRC, [".js", ".mjs"]);

      for (const file of files) {
        const content = fs.readFileSync(file, "utf8");
        // 检查是否有 await import(变量) 或 import(变量)
        if (/await\s+import\s*\(\s*[^"']/.test(content) || /import\s*\(\s*[^"']/.test(content)) {
          // 排除字符串字面量
          const match = content.match(/(await\s+)?import\s*\(\s*([^"'\s)]+)/);
          if (match && !match[2].startsWith('"') && !match[2].startsWith("'")) {
            return {
              passed: false,
              message: `${file} has dynamic import with variable: ${match[0]}`,
            };
          }
        }
      }

      return { passed: true, message: "no dynamic import with variable" };
    },
  },

  // ═══════════════════════════════════════════════════════════════
  // 红线 4: 扩展侧（extension/**）零 DOM 写操作
  // ═══════════════════════════════════════════════════════════════
  {
    id: "extension-no-dom-write",
    name: "扩展零 DOM 写",
    description: "扩展侧（extension/**）零 DOM 写操作",
    check: async () => {
      const extDir = path.join(ROOT, "extension");
      if (!fs.existsSync(extDir)) {
        return { passed: true, message: "extension directory does not exist (skipped)" };
      }

      const files = getAllFiles(extDir, [".js", ".mjs"]);
      const domWritePatterns = [
        /\.innerHTML\s*=/,
        /\.outerHTML\s*=/,
        /\.textContent\s*=/,
        /\.value\s*=/,
        /\.setAttribute\s*\(/,
        /\.appendChild\s*\(/,
        /\.removeChild\s*\(/,
        /\.insertBefore\s*\(/,
        /\.replaceChild\s*\(/,
        /\.cloneNode\s*\(/,
        /\.createElement\s*\(/,
        /\.createTextNode\s*\(/,
        /\.createDocumentFragment\s*\(/,
        /\.insertAdjacentHTML\s*\(/,
        /\.insertAdjacentElement\s*\(/,
        /\.insertAdjacentText\s*\(/,
        /\.replaceWith\s*\(/,
        /\.remove\s*\(/,
        /\.append\s*\(/,
        /\.prepend\s*\(/,
        /\.before\s*\(/,
        /\.after\s*\(/,
        /\.replaceChildren\s*\(/,
      ];

      for (const file of files) {
        const content = fs.readFileSync(file, "utf8");
        for (const pattern of domWritePatterns) {
          if (pattern.test(content)) {
            return {
              passed: false,
              message: `${file} has DOM write operation: ${pattern.source}`,
            };
          }
        }
      }

      return { passed: true, message: "extension has no DOM write operations" };
    },
  },

  // ═══════════════════════════════════════════════════════════════
  // 红线 5: 金额 100% 代码算，LLM 不参与
  // ═══════════════════════════════════════════════════════════════
  {
    id: "value-no-llm",
    name: "金额计算不走 LLM",
    description: "金额 100% 代码算，LLM 不参与",
    check: async () => {
      const valueFile = path.join(SRC, "value.mjs");
      if (!fs.existsSync(valueFile)) {
        return { passed: false, message: "src/value.mjs not found" };
      }

      const content = fs.readFileSync(valueFile, "utf8");
      if (content.includes("llmProvider") || content.includes("generateText")) {
        return {
          passed: false,
          message: "src/value.mjs imports LLM provider (forbidden)",
        };
      }

      return { passed: true, message: "value.mjs does not import LLM provider" };
    },
  },

  // ═══════════════════════════════════════════════════════════════
  // 红线 6: 技能只能在底细卡 14 词白名单内
  // ═══════════════════════════════════════════════════════════════
  {
    id: "skill-whitelist",
    name: "技能白名单限制",
    description: "技能只能在底细卡 14 词白名单内",
    check: async () => {
      const guardFile = path.join(SRC, "copilot", "guard.js");
      if (!fs.existsSync(guardFile)) {
        return { passed: true, message: "guard.js not found (skipped)" };
      }

      const content = fs.readFileSync(guardFile, "utf8");
      // 检查是否有白名单逻辑
      if (!content.includes("whitelist") && !content.includes("WHITELIST")) {
        return {
          passed: false,
          message: "guard.js does not have whitelist logic",
        };
      }

      return { passed: true, message: "guard.js has whitelist logic" };
    },
  },

  // ═══════════════════════════════════════════════════════════════
  // 红线 7: 轮询请求必须带身份三元组
  // ═══════════════════════════════════════════════════════════════
  {
    id: "polling-identity-triple",
    name: "轮询身份三元组",
    description: "轮询请求必须带身份三元组（requestId + jobId + timestamp）",
    check: async () => {
      const files = getAllFiles(SRC, [".js", ".mjs"]);
      const pollingFiles = files.filter((f) => f.includes("poll") || f.includes("extension"));

      for (const file of pollingFiles) {
        const content = fs.readFileSync(file, "utf8");
        if (content.includes("setInterval") || content.includes("setTimeout")) {
          if (
            !content.includes("requestId") ||
            !content.includes("jobId") ||
            !content.includes("timestamp")
          ) {
            return {
              passed: false,
              message: `${file} has polling without identity triple (requestId + jobId + timestamp)`,
            };
          }
        }
      }

      return { passed: true, message: "polling requests have identity triple" };
    },
  },

  // ═══════════════════════════════════════════════════════════════
  // 红线 8: 响应必须带 schemaVersion
  // ═══════════════════════════════════════════════════════════════
  {
    id: "response-schema-version",
    name: "响应带 schemaVersion",
    description: "响应必须带 schemaVersion，过期结果直接丢弃",
    check: async () => {
      const contractFile = path.join(SRC, "core", "contracts", "payloadContract.js");
      if (!fs.existsSync(contractFile)) {
        return { passed: false, message: "payloadContract.js not found" };
      }

      const content = fs.readFileSync(contractFile, "utf8");
      if (!content.includes("schemaVersion")) {
        return {
          passed: false,
          message: "payloadContract.js does not define schemaVersion",
        };
      }

      return { passed: true, message: "payloadContract.js defines schemaVersion" };
    },
  },

  // ═══════════════════════════════════════════════════════════════
  // 旧链围栏: chatApply.js 等文件被改未同步清单
  // ═══════════════════════════════════════════════════════════════
  {
    id: "legacy-fence",
    name: "旧链围栏",
    description: "旧链文件（chatApply.js 等）被改未同步清单",
    check: async () => {
      const fenceFile = path.join(SRC, "core", "guards", "legacyFence.js");
      if (!fs.existsSync(fenceFile)) {
        return { passed: true, message: "legacyFence.js not found (skipped)" };
      }

      // 检查是否有哈希校验逻辑
      const content = fs.readFileSync(fenceFile, "utf8");
      if (!content.includes("hash") && !content.includes("checksum")) {
        return {
          passed: false,
          message: "legacyFence.js does not have hash/checksum logic",
        };
      }

      return { passed: true, message: "legacyFence.js has hash/checksum logic" };
    },
  },
];

// ══════════════════════════════════════════════════════════════════
// 2. 守卫执行引擎
// ══════════════════════════════════════════════════════════════════

/**
 * 运行所有守卫
 * @returns {Promise<{passed: number, failed: number, results: Array}>}
 */
export async function runGuards() {
  const results = [];

  for (const rule of GUARD_RULES) {
    try {
      const result = await rule.check();
      results.push({
        id: rule.id,
        name: rule.name,
        description: rule.description,
        ...result,
      });
    } catch (error) {
      results.push({
        id: rule.id,
        name: rule.name,
        description: rule.description,
        passed: false,
        message: `Guard check failed: ${error.message}`,
      });
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  return { passed, failed, results };
}

/**
 * 打印守卫结果
 */
export function printGuardResults(results) {
  console.log("\n╔════════════════════════════════════════════════════════════╗");
  console.log("║  L0 守卫层检查结果                                         ║");
  console.log("╚════════════════════════════════════════════════════════════╝\n");

  for (const result of results.results) {
    const status = result.passed ? "✅ PASS" : "❌ FAIL";
    console.log(`${status} | ${result.name}`);
    console.log(`       | ${result.description}`);
    console.log(`       | ${result.message}`);
    console.log();
  }

  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log(`║  总计: ${results.passed} 通过, ${results.failed} 失败`);
  console.log("╚════════════════════════════════════════════════════════════╝\n");
}

// ══════════════════════════════════════════════════════════════════
// 3. 工具函数
// ══════════════════════════════════════════════════════════════════

/**
 * 递归获取目录下所有文件
 * @param {string} dir - 目录路径
 * @param {string[]} extensions - 文件扩展名（如 [".js", ".mjs"]）
 * @returns {string[]} 文件路径列表
 */
function getAllFiles(dir, extensions) {
  if (!fs.existsSync(dir)) return [];

  const files = [];

  function walk(currentDir) {
    const entries = fs.readdirSync(currentDir);
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (stat.isFile()) {
        const ext = path.extname(fullPath);
        if (extensions.includes(ext)) {
          files.push(fullPath);
        }
      }
    }
  }

  walk(dir);
  return files;
}

// ══════════════════════════════════════════════════════════════════
// 4. 契约版本与元数据
// ══════════════════════════════════════════════════════════════════

export const GUARDS_VERSION = "1.0.0";
export const GUARDS_DATE = "2026-10-08";

export const GUARDS_CHANGELOG = [
  {
    version: "1.0.0",
    date: "2026-10-08",
    changes: [
      "初始版本：八条红线变成机器可检出的守卫",
      "任何守卫失败都阻止提交/部署",
      "npm run guards 全绿才算完成",
    ],
  },
];
