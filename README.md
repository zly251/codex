# Autonomous Job Search Agent

一个用于自动化抓取、整理与分析招聘信息的智能求职助手系统。

## 📌 项目简介

Autonomous Job Search Agent 是一个面向个人使用的自动化求职系统，能够：

- 自动抓取招聘网站职位信息
- 解析职位详情（岗位、薪资、地点、要求等）
- 清洗与结构化数据
- 支持后续扩展（筛选、推荐、投递自动化等）

目标是减少手动刷招聘网站的成本，实现“信息自动流入 + 结构化整理”。

---

## 🧠 系统架构

当前系统主要分为以下模块：

- 采集层 `src/scrapers/bossApi.js`：搜索 BOSS 直聘职位，API 拦截解析 + DOM 兜底提取。
- 数据层 `src/db/`：SQLite（node:sqlite）存储职位、公司、简历与投递记录。
- 自动化执行层 `src/chatApply.js` + `src/browser/browserManager.js`：通过 CDP 连接 Edge，模拟真人浏览、打招呼并校验结果。
- 服务层 `server.mjs` + `src/routes.mjs`：HTTP API、实时日志、登录 Cookie 备份与恢复。
- 前端 `web/index.html`：搜索、筛选、批量投递、单职位沟通与聊天监控操作面板。
- 打包层 `packaging/`：Node SEA 单文件 exe，启动时自动还原资源、复用登录配置并恢复 Cookie。
