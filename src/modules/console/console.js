// M5 console 模块 — 控制台数据聚合和格式化输出
// 纯函数，无 DB、无网络、无 LLM 依赖

import { SCHEMA_VERSION, validateConsoleResult } from "./types.js";

/**
 * 聚合控制台数据
 * @param {object} input — {jobs[], valueCards[], evidenceReceipts[], chatSuggestions[]}
 * @returns {ConsoleResult}
 */
export function buildConsole(input) {
  const jobs = input?.jobs || [];
  const valueCards = input?.valueCards || [];
  const evidenceReceipts = input?.evidenceReceipts || [];
  const chatSuggestions = input?.chatSuggestions || [];

  // 汇总统计
  const totalJobs = jobs.length;
  const salaries = valueCards.map(v => v?.salary?.max || 0).filter(s => s > 0);
  const avgSalary = salaries.length > 0 ? Math.round(salaries.reduce((a, b) => a + b, 0) / salaries.length) : 0;
  const highRiskCount = evidenceReceipts.filter(e => !e?.ok).length;
  const pendingReviewCount = evidenceReceipts.filter(e => e?.ok && e?.markers?.length > 0).length;

  // 按公司分组
  const companyMap = new Map();
  for (const job of jobs) {
    const company = job?.companyName || "未知公司";
    if (!companyMap.has(company)) companyMap.set(company, []);
    companyMap.get(company).push(job);
  }

  const detail = [];
  for (const [companyName, companyJobs] of companyMap) {
    for (const job of companyJobs) {
      const valueCard = valueCards.find(v => v?.jobId === job?.jobId || v?.jobTitle === job?.jobTitle);
      const evidence = evidenceReceipts.find(e => e?.meta?.jobTitle === job?.jobTitle);
      const suggestions = chatSuggestions.filter(s => s?.jobTitle === job?.jobTitle);

      detail.push({
        jobTitle: job?.jobTitle || "",
        companyName,
        salary: valueCard?.salary || { min: 0, max: 0 },
        valueScore: valueCard?.score || 0,
        evidenceOk: evidence?.ok ?? false,
        suggestionCount: suggestions.length,
      });
    }
  }

  const result = {
    schemaVersion: SCHEMA_VERSION,
    ok: true,
    summary: { totalJobs, avgSalary, highRiskCount, pendingReviewCount },
    detail,
  };

  const errors = validateConsoleResult(result);
  if (errors.length > 0) result._validationErrors = errors;

  return result;
}

/**
 * 导出为 Markdown 表格
 */
export function toMarkdown(result) {
  const lines = ["# 求职助手控制台汇总", ""];
  lines.push(`## 汇总`);
  lines.push(`- 岗位总数：${result.summary.totalJobs}`);
  lines.push(`- 平均薪资：${result.summary.avgSalary}`);
  lines.push(`- 高风险岗位：${result.summary.highRiskCount}`);
  lines.push(`- 待确认岗位：${result.summary.pendingReviewCount}`);
  lines.push("");
  lines.push("## 岗位明细");
  lines.push("| 岗位 | 公司 | 薪资 | 价值评分 | 证据 | 建议数 |");
  lines.push("|------|------|------|----------|------|--------|");
  for (const item of result.detail) {
    lines.push(`| ${item.jobTitle} | ${item.companyName} | ${item.salary.min}-${item.salary.max} | ${item.valueScore} | ${item.evidenceOk ? "✅" : "❌"} | ${item.suggestionCount} |`);
  }
  return lines.join("\n");
}
