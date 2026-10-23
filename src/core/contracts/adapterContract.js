/**
 * L1 契约层 - 平台适配器契约
 * 冻结：并行开发期间任何改动必须双方同步
 *
 * 职责：定义平台适配器（BOSS 直聘）的 20 个钩子 typedef + assertAdapter() 验证
 * 红线：金额 100% 代码算，LLM 不参与；适配器只做 DOM 读，不做 DOM 写
 */

// ══════════════════════════════════════════════════════════════════
// 1. 平台适配器钩子 typedef（20 个）
// ══════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} JobListItem
 * @property {string} jobId - 岗位唯一标识
 * @property {string} title - 岗位名称
 * @property {string} [salary] - 薪资文本（如 "6-10K"）
 * @property {string} [city] - 工作城市
 * @property {string} [district] - 区县
 * @property {string} [experience] - 经验要求
 * @property {string} [education] - 学历要求
 * @property {string} [companyName] - 公司名称
 * @property {string} [hrName] - HR 姓名
 * @property {string} [detailUrl] - 详情页 URL
 * @property {number} [listedAt] - 列表时间戳
 */

/**
 * @typedef {Object} JobDetail
 * @property {string} jobId
 * @property {string} title
 * @property {string} [salaryMin] - 薪资下限（K）
 * @property {string} [salaryMax] - 薪资上限（K）
 * @property {number} [salaryMonths] - 几薪（12-16）
 * @property {string} [city]
 * @property {string} [district]
 * @property {string} [address] - 详细地址
 * @property {string} [experience]
 * @property {string} [education]
 * @property {string} [description] - 职位描述全文
 * @property {string[]} [tags] - 职位标签
 * @property {string} [companyName]
 * @property {string} [companySize] - 公司规模
 * @property {string} [industry] - 行业
 * @property {string} [hrName]
 * @property {string} [hrTitle] - HR 职位
 * @property {number} [detailedAt] - 详情抓取时间戳
 * @property {number} [distanceKm] - 距离（公里）
 * @property {string} [distanceTier] - 距离档位（CORE/NEAR/FAR/UNKNOWN/OUT_OF_CITY）
 * @property {boolean} [hasDormitory] - 是否有宿舍
 */

/**
 * @typedef {Object} ChatMessage
 * @property {string} id - 消息唯一标识
 * @property {string} sender - 发送者（"hr" | "me" | "system"）
 * @property {string} text - 消息文本
 * @property {number} timestamp - 消息时间戳
 * @property {string} [type] - 消息类型（text/image/resume/system）
 */

/**
 * @typedef {Object} ChatSession
 * @property {string} jobId - 关联岗位
 * @property {string} hrName - HR 姓名
 * @property {ChatMessage[]} messages - 消息列表
 * @property {number} [lastActiveAt] - 最后活跃时间
 * @property {boolean} [hasReplied] - 是否有回复
 */

/**
 * @typedef {Object} PlatformAdapter
 * @property {string} name - 平台名称（如 "boss"）
 * @property {string} version - 适配器版本
 *
 * —— 搜索与列表 ——
 * @property {function(string, Object): Promise<JobListItem[]>} searchJobs - 搜索岗位
 *   @param {string} keyword - 搜索关键词
 *   @param {Object} opts - 选项 {city, page, limit}
 *   @returns {Promise<JobListItem[]>}
 *
 * @property {function(string): Promise<JobDetail>} getJobDetail - 获取岗位详情
 *   @param {string} jobId - 岗位 ID
 *   @returns {Promise<JobDetail>}
 *
 * @property {function(string, Object): Promise<JobListItem[]>} enrichJobList - 增补列表信息（如距离、宿舍）
 *   @param {string} keyword
 *   @param {Object} opts - {withDistance: boolean, withDormitory: boolean}
 *   @returns {Promise<JobListItem[]>}
 *
 * —— 聊天与消息 ——
 * @property {function(string): Promise<ChatSession>} getChatSession - 获取聊天会话
 *   @param {string} jobId
 *   @returns {Promise<ChatSession>}
 *
 * @property {function(string, number): Promise<ChatMessage[]>} getChatHistory - 获取聊天历史
 *   @param {string} jobId
 *   @param {number} limit - 最大条数
 *   @returns {Promise<ChatMessage[]>}
 *
 * @property {function(string): Promise<string>} getLastHrMessage - 获取最后一条 HR 消息
 *   @param {string} jobId
 *   @returns {Promise<string>} - 消息文本
 *
 * —— 页面状态 ——
 * @property {function(): Promise<boolean>} isLoggedIn - 检查是否已登录
 * @property {function(): Promise<Object>} getPageState - 获取当前页面状态
 *   @returns {Promise<{url: string, title: string, hasLogin: boolean}>}
 *
 * —— 数据提取（只读）——
 * @property {function(): Promise<string>} extractPageText - 提取页面文本（聊天页/详情页）
 *   @returns {Promise<string>}
 *
 * @property {function(string): Promise<Object>} extractJobCard - 从列表提取岗位卡片信息
 *   @param {string} elementSelector - 元素选择器
 *   @returns {Promise<Object>}
 *
 * —— 用户操作（真人执行，系统只读）——
 * @property {function(string, Object): void} onUserSearch - 用户执行搜索时触发（回调）
 *   @param {string} keyword
 *   @param {Object} results
 *
 * @property {function(string): void} onUserViewDetail - 用户查看详情时触发（回调）
 *   @param {string} jobId
 *
 * @property {function(string, ChatMessage): void} onUserSendMessage - 用户发送消息时触发（回调）
 *   @param {string} jobId
 *   @param {ChatMessage} message
 *
 * —— 配置与元数据 ——
 * @property {function(): Object} getPlatformConfig - 获取平台配置
 *   @returns {Object} {baseUrl, selectors, rateLimit}
 *
 * @property {function(): string[]} getSupportedCities - 获取支持的城市列表
 *   @returns {string[]}
 *
 * @property {function(): Object} getRateLimit - 获取限流配置
 *   @returns {Object} {searchPerHour, detailPerMinute, chatPerDay}
 *
 * @property {function(string): boolean} isValidJobId - 校验岗位 ID 格式
 *   @param {string} jobId
 *   @returns {boolean}
 *
 * @property {function(): Promise<Object>} getAccountInfo - 获取账号信息（昵称、头像、会员状态）
 *   @returns {Promise<{nickname: string, avatar: string, vip: boolean}>}
 *
 * @property {function(): Promise<Object>} getResumeStatus - 获取简历状态（是否已上传、附件数）
 *   @returns {Promise<{hasResume: boolean, attachmentCount: number}>}
 *
 * @property {function(): Promise<number>} getUnreadCount - 获取未读消息数
 *   @returns {Promise<number>}
 */

// ══════════════════════════════════════════════════════════════════
// 2. 适配器验证函数
// ══════════════════════════════════════════════════════════════════

/**
 * 验证平台适配器是否符合契约
 * @param {PlatformAdapter} adapter - 待验证的适配器实例
 * @returns {{valid: boolean, errors: string[], warnings: string[]}}
 */
export function assertAdapter(adapter) {
  const errors = [];
  const warnings = [];

  // 必填字段
  if (!adapter || typeof adapter !== "object") {
    errors.push("adapter must be an object");
    return { valid: false, errors, warnings };
  }

  if (!adapter.name || typeof adapter.name !== "string") {
    errors.push("adapter.name is required and must be a string");
  }

  if (!adapter.version || typeof adapter.version !== "string") {
    warnings.push("adapter.version is recommended");
  }

  // 必填方法
  const requiredMethods = [
    "searchJobs",
    "getJobDetail",
    "getChatSession",
    "getChatHistory",
    "isLoggedIn",
    "extractPageText",
  ];

  for (const method of requiredMethods) {
    if (typeof adapter[method] !== "function") {
      errors.push(`adapter.${method} is required and must be a function`);
    }
  }

  // 推荐方法
  const recommendedMethods = [
    "enrichJobList",
    "getLastHrMessage",
    "getPageState",
    "getPlatformConfig",
    "getSupportedCities",
    "getRateLimit",
    "isValidJobId",
  ];

  for (const method of recommendedMethods) {
    if (adapter[method] !== undefined && typeof adapter[method] !== "function") {
      warnings.push(`adapter.${method} should be a function if defined`);
    }
  }

  // 回调方法（可选，但必须是函数）
  const callbackMethods = ["onUserSearch", "onUserViewDetail", "onUserSendMessage"];
  for (const method of callbackMethods) {
    if (adapter[method] !== undefined && typeof adapter[method] !== "function") {
      warnings.push(`adapter.${method} is a callback and must be a function if defined`);
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

export const ADAPTER_CONTRACT_VERSION = "1.0.0";
export const ADAPTER_CONTRACT_DATE = "2026-10-08";

/**
 * 契约变更日志（并行期冻结，任何改动必须双方同步）
 */
export const CONTRACT_CHANGELOG = [
  {
    version: "1.0.0",
    date: "2026-10-08",
    changes: [
      "初始版本：定义 20 个钩子 typedef + assertAdapter() 验证",
      "红线：金额 100% 代码算，LLM 不参与",
      "红线：适配器只做 DOM 读，不做 DOM 写",
    ],
  },
];
