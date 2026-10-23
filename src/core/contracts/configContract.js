/**
 * L1 契约层 - 配置契约
 * 冻结：并行开发期间任何改动必须双方同步
 *
 * 职责：配置键唯一清单，三处真源合并为"服务端一份 + 扩展从服务端拉"
 * 红线：所有配置键必须在此注册，未注册的配置键一律忽略
 */

// ══════════════════════════════════════════════════════════════════
// 1. 配置键清单（唯一真源）
// ══════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} ConfigSchema
 * @property {string} key - 配置键
 * @property {string} type - 类型：string | number | boolean | object | array
 * @property {*} default - 默认值
 * @property {string} [description] - 说明
 * @property {boolean} [secret] - 是否为敏感信息（不返回给前端）
 * @property {string} [envVar] - 环境变量名（如 "JOB_VALUE_PENSION"）
 */

/** @type {ConfigSchema[]} */
export const CONFIG_SCHEMA = [
  // ═══════════════════════════════════════════════════════════════
  // 服务端配置（3456 端口）
  // ═══════════════════════════════════════════════════════════════
  {
    key: "port",
    type: "number",
    default: 3456,
    description: "服务端监听端口",
    envVar: "PORT",
  },
  {
    key: "dataDir",
    type: "string",
    default: "E:\\autonomous-job-agent-data",
    description: "数据根目录",
    envVar: "JOB_AGENT_DATA_DIR",
  },
  {
    key: "webDir",
    type: "string",
    default: "web",
    description: "前端静态文件目录",
    envVar: "JOB_AGENT_WEB_DIR",
  },
  {
    key: "legacyEnabled",
    type: "boolean",
    default: false,
    description: "是否启用旧链（自动打招呼/自动聊天），需显式设置 JOB_AGENT_LEGACY=1",
    envVar: "JOB_AGENT_LEGACY",
  },
  {
    key: "dryRun",
    type: "boolean",
    default: true,
    description: "是否为演练模式（不真实投递，仅打印）",
    envVar: "APPLY_DRY_RUN",
  },

  // ═══════════════════════════════════════════════════════════════
  // M1 ingest - 岗位发现与详情增补
  // ═══════════════════════════════════════════════════════════════
  {
    key: "homeAddress",
    type: "string",
    default: "市中心（示例）",
    description: "家地址（用于距离计算）",
    envVar: "JOB_HOME_ADDRESS",
  },
  {
    key: "distanceCoreKm",
    type: "number",
    default: 5,
    description: "核心距离档位（公里）",
    envVar: "JOB_DISTANCE_CORE_KM",
  },
  {
    key: "distanceNearKm",
    type: "number",
    default: 15,
    description: "近距距离档位（公里）",
    envVar: "JOB_DISTANCE_NEAR_KM",
  },
  {
    key: "replenishKeywords",
    type: "array",
    default: ["外贸业务员", "销售", "客服", "业务助理", "跟单文员"],
    description: "无人值守补库存关键词列表",
    envVar: "JOB_AGENT_REPLENISH_KEYWORDS",
  },
  {
    key: "replenishSearchCooldownHours",
    type: "number",
    default: 3,
    description: "补库存搜索冷却时间（小时）",
    envVar: "JOB_AGENT_REPLENISH_SEARCH_COOLDOWN_HOURS",
  },
  {
    key: "replenishEnrichCooldownMinutes",
    type: "number",
    default: 45,
    description: "补库存增补冷却时间（分钟）",
    envVar: "JOB_AGENT_REPLENISH_ENRICH_COOLDOWN_MINUTES",
  },

  // ═══════════════════════════════════════════════════════════════
  // M2 value - 含金量计算
  // ═══════════════════════════════════════════════════════════════
  {
    key: "socialRatesPension",
    type: "number",
    default: 0.08,
    description: "社保-养老个人缴费比例",
    envVar: "JOB_VALUE_PENSION",
  },
  {
    key: "socialRatesMedical",
    type: "number",
    default: 0.02,
    description: "社保-医疗个人缴费比例",
    envVar: "JOB_VALUE_MEDICAL",
  },
  {
    key: "socialRatesUnemployment",
    type: "number",
    default: 0.005,
    description: "社保-失业个人缴费比例",
    envVar: "JOB_VALUE_UNEMP",
  },
  {
    key: "fundRate",
    type: "number",
    default: 0.08,
    description: "公积金个人缴费比例（5%-12%）",
    envVar: "JOB_VALUE_FUND",
  },
  {
    key: "taxThreshold",
    type: "number",
    default: 5000,
    description: "个税起征点（每月减除费用）",
    envVar: "JOB_VALUE_TAX_THRESHOLD",
  },
  {
    key: "socialBaseMin",
    type: "number",
    default: 4000,
    description: "社保基数下限",
    envVar: "JOB_VALUE_SOCIAL_BASE_MIN",
  },
  {
    key: "socialBaseMax",
    type: "number",
    default: 24000,
    description: "社保基数上限",
    envVar: "JOB_VALUE_SOCIAL_BASE_MAX",
  },

  // ═══════════════════════════════════════════════════════════════
  // M3 copilot - 聊天话术建议
  // ═══════════════════════════════════════════════════════════════
  {
    key: "llmPrimaryProvider",
    type: "string",
    default: "qwen3.8-flash",
    description: "首选 LLM 提供商",
    envVar: "JOB_LLM_PRIMARY",
  },
  {
    key: "llmFallbackProviders",
    type: "array",
    default: ["zhipu", "deepseek", "template"],
    description: "LLM 降级链（429 时自动切换）",
    envVar: "JOB_LLM_FALLBACKS",
  },
  {
    key: "llmGatewayPort",
    type: "number",
    default: 3010,
    description: "本地 LLM 网关端口",
    envVar: "JOB_LLM_GATEWAY_PORT",
  },
  {
    key: "llmMaxTokens",
    type: "number",
    default: 160,
    description: "LLM 输出最大 token 数",
    envVar: "JOB_LLM_MAX_TOKENS",
  },
  {
    key: "llmTimeoutMs",
    type: "number",
    default: 30000,
    description: "LLM 请求超时时间（毫秒）",
    envVar: "JOB_LLM_TIMEOUT_MS",
  },
  {
    key: "skillWhitelist",
    type: "array",
    default: [
      "外贸业务员", "销售", "客服", "业务助理", "跟单文员",
      "阿里巴巴国际站", "中国制造网", "亚马逊", "ebay", "速卖通",
      "英语", "外贸", "电商",
    ],
    description: "底细卡技能白名单（14 词）",
    envVar: "JOB_SKILL_WHITELIST",
  },
  {
    key: "suggestionMaxLength",
    type: "number",
    default: 160,
    description: "话术建议最大长度（字）",
    envVar: "JOB_SUGGESTION_MAX_LENGTH",
  },

  // ═══════════════════════════════════════════════════════════════
  // M4 evidence - 证据判定
  // ═══════════════════════════════════════════════════════════════
  {
    key: "evidenceDeliveryTimeoutHours",
    type: "number",
    default: 24,
    description: "送达证据超时时间（小时）",
    envVar: "JOB_EVIDENCE_DELIVERY_TIMEOUT_HOURS",
  },
  {
    key: "evidenceResumeRequired",
    type: "boolean",
    default: true,
    description: "是否要求简历附件证据",
    envVar: "JOB_EVIDENCE_RESUME_REQUIRED",
  },
  {
    key: "evidenceApplyReceiptRequired",
    type: "boolean",
    default: true,
    description: "是否要求投递回执证据",
    envVar: "JOB_EVIDENCE_APPLY_RECEIPT_REQUIRED",
  },

  // ═══════════════════════════════════════════════════════════════
  // M5 console - 侧边小窗与控制台
  // ═══════════════════════════════════════════════════════════════
  {
    key: "extensionPollIntervalMs",
    type: "number",
    default: 3000,
    description: "扩展轮询间隔（毫秒）",
    envVar: "JOB_EXTENSION_POLL_INTERVAL_MS",
  },
  {
    key: "extensionRequestTimeoutMs",
    type: "number",
    default: 10000,
    description: "扩展请求超时时间（毫秒）",
    envVar: "JOB_EXTENSION_REQUEST_TIMEOUT_MS",
  },
  {
    key: "consoleMaxMessages",
    type: "number",
    default: 100,
    description: "控制台最大消息条数",
    envVar: "JOB_CONSOLE_MAX_MESSAGES",
  },

  // ═══════════════════════════════════════════════════════════════
  // 敏感配置（不返回给前端）
  // ═══════════════════════════════════════════════════════════════
  {
    key: "llmApiKeyZhipu",
    type: "string",
    default: "",
    description: "智谱 API Key",
    envVar: "ZHIPU_API_KEY",
    secret: true,
  },
  {
    key: "llmApiKeyDeepseek",
    type: "string",
    default: "",
    description: "DeepSeek API Key",
    envVar: "DEEPSEEK_API_KEY",
    secret: true,
  },
  {
    key: "llmApiKeyOpenRouter",
    type: "string",
    default: "",
    description: "OpenRouter API Key",
    envVar: "OPENROUTER_API_KEY",
    secret: true,
  },
];

// ══════════════════════════════════════════════════════════════════
// 2. 配置操作
// ══════════════════════════════════════════════════════════════════

/**
 * 获取配置键定义
 * @param {string} key - 配置键
 * @returns {ConfigSchema|null}
 */
export function getConfigSchema(key) {
  return CONFIG_SCHEMA.find((c) => c.key === key) || null;
}

/**
 * 获取所有配置键（按模块分组）
 * @returns {Object<string, ConfigSchema[]>}
 */
export function getConfigSchemaByModule() {
  const byModule = {};
  for (const config of CONFIG_SCHEMA) {
    const module = config.key.split(/(?=[A-Z])/)[0]; // 简单按首字母分组
    if (!byModule[module]) byModule[module] = [];
    byModule[module].push(config);
  }
  return byModule;
}

/**
 * 从环境变量加载配置
 * @returns {Object<string, *>} 配置对象
 */
export function loadConfigFromEnv() {
  const config = {};
  for (const schema of CONFIG_SCHEMA) {
    if (schema.envVar && process.env[schema.envVar] !== undefined) {
      const value = process.env[schema.envVar];
      if (schema.type === "number") {
        config[schema.key] = Number(value);
      } else if (schema.type === "boolean") {
        config[schema.key] = value === "1" || value === "true";
      } else if (schema.type === "array") {
        config[schema.key] = value.split(",").map((s) => s.trim());
      } else if (schema.type === "object") {
        try {
          config[schema.key] = JSON.parse(value);
        } catch (e) {
          config[schema.key] = schema.default;
        }
      } else {
        config[schema.key] = value;
      }
    } else {
      config[schema.key] = schema.default;
    }
  }
  return config;
}

/**
 * 验证配置对象
 * @param {Object} config - 配置对象
 * @returns {{valid: boolean, errors: string[], warnings: string[]}}
 */
export function validateConfig(config) {
  const errors = [];
  const warnings = [];

  for (const [key, value] of Object.entries(config)) {
    const schema = getConfigSchema(key);
    if (!schema) {
      warnings.push(`Unknown config key: ${key} (ignored)`);
      continue;
    }

    // 类型检查
    if (schema.type === "number" && !Number.isFinite(value)) {
      errors.push(`Config ${key} must be a number, got ${typeof value}`);
    } else if (schema.type === "boolean" && typeof value !== "boolean") {
      errors.push(`Config ${key} must be a boolean, got ${typeof value}`);
    } else if (schema.type === "array" && !Array.isArray(value)) {
      errors.push(`Config ${key} must be an array, got ${typeof value}`);
    } else if (schema.type === "object" && (typeof value !== "object" || Array.isArray(value))) {
      errors.push(`Config ${key} must be an object, got ${typeof value}`);
    } else if (schema.type === "string" && typeof value !== "string") {
      errors.push(`Config ${key} must be a string, got ${typeof value}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * 过滤敏感配置（不返回给前端）
 * @param {Object} config - 完整配置
 * @returns {Object} 过滤后的配置
 */
export function filterSensitiveConfig(config) {
  const filtered = {};
  for (const [key, value] of Object.entries(config)) {
    const schema = getConfigSchema(key);
    if (schema && schema.secret) {
      continue; // 跳过敏感配置
    }
    filtered[key] = value;
  }
  return filtered;
}

// ══════════════════════════════════════════════════════════════════
// 3. 契约版本与元数据
// ══════════════════════════════════════════════════════════════════

export const CONFIG_CONTRACT_VERSION = "1.0.0";
export const CONFIG_CONTRACT_DATE = "2026-10-08";

/**
 * 契约变更日志（并行期冻结，任何改动必须双方同步）
 */
export const CONFIG_CONTRACT_CHANGELOG = [
  {
    version: "1.0.0",
    date: "2026-10-08",
    changes: [
      "初始版本：配置键唯一清单",
      "三处真源合并为'服务端一份 + 扩展从服务端拉'",
      "未注册的配置键一律忽略",
      "敏感配置不返回给前端",
    ],
  },
];
