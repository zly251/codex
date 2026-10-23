/**
 * L1 契约层 - HTTP 路由契约
 * 冻结：并行开发期间任何改动必须双方同步
 *
 * 职责：40+ 端点收成一张路由表，替换 server.mjs 28 条 if 链 + routes.mjs 9 条
 * 红线：所有端点必须在此注册，否则 404；新增端点必须先加路由表再加 handler
 */

// ══════════════════════════════════════════════════════════════════
// 1. 路由表（method + path + handler + module 归属）
// ══════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} Route
 * @property {string} method - HTTP 方法（GET/POST/PUT/DELETE）
 * @property {string} path - 路径（如 "/api/jobs/search"）
 * @property {string} handler - 处理函数名（如 "handleSearch"）
 * @property {string} module - 归属模块（M1/M2/M3/M4/M5/core）
 * @property {string} [description] - 端点说明
 * @property {boolean} [deprecated] - 是否已废弃（旧链用）
 * @property {string} [legacy] - 旧链替代端点（如有）
 */

/** @type {Route[]} */
export const ROUTES = [
  // ═══════════════════════════════════════════════════════════════
  // M1 ingest - 岗位发现与详情增补
  // ═══════════════════════════════════════════════════════════════
  {
    method: "POST",
    path: "/api/jobs/search",
    handler: "handleSearch",
    module: "M1",
    description: "搜索岗位列表",
  },
  {
    method: "POST",
    path: "/api/jobs/enrich",
    handler: "handleEnrich",
    module: "M1",
    description: "增补岗位详情（距离、宿舍）",
  },
  {
    method: "POST",
    path: "/api/jobs/replenish",
    handler: "handleReplenish",
    module: "M1",
    description: "无人值守补库存（搜索+增补）",
  },
  {
    method: "GET",
    path: "/api/jobs",
    handler: "handleGetJobs",
    module: "M1",
    description: "获取岗位列表（支持筛选）",
  },
  {
    method: "GET",
    path: "/api/jobs/:id",
    handler: "handleGetJob",
    module: "M1",
    description: "获取单个岗位详情",
  },

  // ═══════════════════════════════════════════════════════════════
  // M2 value - 含金量卡
  // ═══════════════════════════════════════════════════════════════
  {
    method: "POST",
    path: "/api/value/compute",
    handler: "handleComputeValue",
    module: "M2",
    description: "计算含金量卡（税前/五险一金/到手/可支配）",
  },
  {
    method: "GET",
    path: "/api/value/config",
    handler: "handleGetValueConfig",
    module: "M2",
    description: "获取含金量计算配置（社保比例、公积金、个税等）",
  },

  // ═══════════════════════════════════════════════════════════════
  // M3 copilot - 聊天话术建议
  // ═══════════════════════════════════════════════════════════════
  {
    method: "POST",
    path: "/api/extension/look",
    handler: "handleExtensionLook",
    module: "M3",
    description: "扩展只读看：意图分类 → 建议生成 → 输出守卫",
  },
  {
    method: "POST",
    path: "/api/chat/suggest",
    handler: "handleChatSuggest",
    module: "M3",
    description: "生成聊天话术建议",
  },
  {
    method: "GET",
    path: "/api/chat/intents",
    handler: "handleGetChatIntents",
    module: "M3",
    description: "获取意图分类列表",
  },

  // ═══════════════════════════════════════════════════════════════
  // M4 evidence - 证据判定
  // ═══════════════════════════════════════════════════════════════
  {
    method: "POST",
    path: "/api/evidence/verify",
    handler: "handleVerifyEvidence",
    module: "M4",
    description: "验证证据（送达/简历附件/投递回执）",
  },
  {
    method: "GET",
    path: "/api/evidence/markers",
    handler: "handleGetEvidenceMarkers",
    module: "M4",
    description: "获取证据标记配置",
  },

  // ═══════════════════════════════════════════════════════════════
  // M5 console - 侧边小窗与控制台
  // ═══════════════════════════════════════════════════════════════
  {
    method: "GET",
    path: "/api/status",
    handler: "handleGetStatus",
    module: "M5",
    description: "获取系统状态（运行中/已登录/已应用数）",
  },
  {
    method: "GET",
    path: "/api/messages",
    handler: "handleGetMessages",
    module: "M5",
    description: "获取消息列表（聊天/系统）",
  },
  {
    method: "GET",
    path: "/api/review/list",
    handler: "handleReviewList",
    module: "M5",
    description: "获取待审核列表",
  },
  {
    method: "POST",
    path: "/api/review/approve",
    handler: "handleReviewApprove",
    module: "M5",
    description: "批准单条待审核",
  },
  {
    method: "POST",
    path: "/api/review/approve-all",
    handler: "handleReviewApproveAll",
    module: "M5",
    description: "批准全部待审核",
  },
  {
    method: "POST",
    path: "/api/review/reject",
    handler: "handleReviewReject",
    module: "M5",
    description: "拒绝单条待审核",
  },
  {
    method: "POST",
    path: "/api/review/auto-approve",
    handler: "handleReviewAutoApprove",
    module: "M5",
    description: "自动批准（按规则）",
  },

  // ═══════════════════════════════════════════════════════════════
  // core - 简历与配置
  // ═══════════════════════════════════════════════════════════════
  {
    method: "GET",
    path: "/api/resume",
    handler: "handleGetResume",
    module: "core",
    description: "获取简历内容",
  },
  {
    method: "POST",
    path: "/api/resume/upload",
    handler: "handleUploadResume",
    module: "core",
    description: "上传简历文件",
  },
  {
    method: "POST",
    path: "/api/resume/parse",
    handler: "handleParseResume",
    module: "core",
    description: "解析简历文本",
  },
  {
    method: "GET",
    path: "/api/resume/editor",
    handler: "handleGetResumeEditor",
    module: "core",
    description: "获取简历编辑器状态",
  },
  {
    method: "POST",
    path: "/api/resume/editor/save",
    handler: "handleSaveResumeEditor",
    module: "core",
    description: "保存简历编辑器状态",
  },
  {
    method: "POST",
    path: "/api/resume/export/docx",
    handler: "handleExportDocx",
    module: "core",
    description: "导出 DOCX 简历",
  },
  {
    method: "POST",
    path: "/api/resume/export/pdf",
    handler: "handleExportPdf",
    module: "core",
    description: "导出 PDF 简历",
  },
  {
    method: "GET",
    path: "/api/config",
    handler: "handleGetConfig",
    module: "core",
    description: "获取系统配置",
  },
  {
    method: "POST",
    path: "/api/config",
    handler: "handleSaveConfig",
    module: "core",
    description: "保存系统配置",
  },

  // ═══════════════════════════════════════════════════════════════
  // legacy - 旧链（不删不跑不改，仅保留路由占位）
  // ═══════════════════════════════════════════════════════════════
  {
    method: "POST",
    path: "/api/connect",
    handler: "handleConnect",
    module: "legacy",
    description: "连接浏览器（旧链）",
    deprecated: true,
  },
  {
    method: "POST",
    path: "/api/launch",
    handler: "handleLaunch",
    module: "legacy",
    description: "启动浏览器（旧链）",
    deprecated: true,
  },
  {
    method: "POST",
    path: "/api/apply",
    handler: "handleApply",
    module: "legacy",
    description: "自动投递（旧链，已证伪）",
    deprecated: true,
  },
  {
    method: "POST",
    path: "/api/chat/start",
    handler: "handleChatStart",
    module: "legacy",
    description: "开始自动聊天（旧链）",
    deprecated: true,
  },
  {
    method: "POST",
    path: "/api/chat/stop",
    handler: "handleChatStop",
    module: "legacy",
    description: "停止自动聊天（旧链）",
    deprecated: true,
  },
  {
    method: "POST",
    path: "/api/chat/reply",
    handler: "handleChatReply",
    module: "legacy",
    description: "自动回复（旧链）",
    deprecated: true,
  },
  {
    method: "POST",
    path: "/api/chat/send-resume",
    handler: "handleChatSendResume",
    module: "legacy",
    description: "自动发送简历（旧链）",
    deprecated: true,
  },
  {
    method: "POST",
    path: "/api/feedback/sync",
    handler: "handleFeedbackSync",
    module: "legacy",
    description: "同步反馈（旧链）",
    deprecated: true,
  },
];

// ══════════════════════════════════════════════════════════════════
// 2. 路由匹配与分发
// ══════════════════════════════════════════════════════════════════

/**
 * 根据 method 和 path 匹配路由
 * @param {string} method - HTTP 方法
 * @param {string} path - 请求路径
 * @returns {Route|null} 匹配的路由，未匹配返回 null
 */
export function matchRoute(method, path) {
  // 精确匹配
  const exact = ROUTES.find(
    (r) => r.method === method && r.path === path
  );
  if (exact) return exact;

  // 参数匹配（如 /api/jobs/:id）
  const paramMatch = ROUTES.find((r) => {
    if (r.method !== method) return false;
    if (!r.path.includes(":")) return false;

    const pattern = r.path.replace(/:[^/]+/g, "[^/]+");
    const regex = new RegExp(`^${pattern}$`);
    return regex.test(path);
  });

  return paramMatch || null;
}

/**
 * 从路径中提取参数
 * @param {string} routePath - 路由路径（如 "/api/jobs/:id"）
 * @param {string} requestPath - 请求路径（如 "/api/jobs/123"）
 * @returns {Object} 参数对象（如 {id: "123"}）
 */
export function extractParams(routePath, requestPath) {
  const params = {};
  const routeParts = routePath.split("/");
  const requestParts = requestPath.split("/");

  for (let i = 0; i < routeParts.length; i++) {
    if (routeParts[i].startsWith(":")) {
      const paramName = routeParts[i].slice(1);
      params[paramName] = requestParts[i];
    }
  }

  return params;
}

/**
 * 验证路由表完整性
 * @returns {{valid: boolean, errors: string[], warnings: string[]}}
 */
export function assertRoutes() {
  const errors = [];
  const warnings = [];
  const paths = new Set();
  const handlers = new Set();

  for (const route of ROUTES) {
    // 检查必填字段
    if (!route.method || !route.path || !route.handler || !route.module) {
      errors.push(`Route missing required fields: ${JSON.stringify(route)}`);
      continue;
    }

    // 检查路径重复
    const key = `${route.method} ${route.path}`;
    if (paths.has(key)) {
      errors.push(`Duplicate route: ${key}`);
    }
    paths.add(key);

    // 检查 handler 重复（不同模块可以有同名 handler）
    if (handlers.has(route.handler)) {
      warnings.push(`Handler reused across modules: ${route.handler}`);
    }
    handlers.add(route.handler);

    // 检查废弃路由是否有 legacy 标记
    if (route.deprecated && !route.legacy) {
      warnings.push(`Deprecated route missing legacy field: ${route.path}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ══════════════════════════════════════════════════════════════════
// 3. 契约版本与元数据
// ══════════════════════════════════════════════════════════════════

export const HTTP_CONTRACT_VERSION = "1.0.0";
export const HTTP_CONTRACT_DATE = "2026-10-08";

/**
 * 契约变更日志（并行期冻结，任何改动必须双方同步）
 */
export const CONTRACT_CHANGELOG = [
  {
    version: "1.0.0",
    date: "2026-10-08",
    changes: [
      "初始版本：40+ 端点收成一张路由表",
      "新增端点必须先加路由表再加 handler",
      "旧链路由标记 deprecated，不删不跑不改",
    ],
  },
];
