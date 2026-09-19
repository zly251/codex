# 03_DEV_PLAN.md

## Autonomous Job Search Agent

---

# 1. 开发目标

本项目旨在构建一个自主求职代理系统。

系统能够自动完成：

* 岗位搜索
* 岗位筛选
* 岗位评分
* 简历匹配
* 自动投递
* 反馈跟踪
* 策略优化

最终目标：

提高求职效率与面试转化率。

---

# 2. 开发原则

## 2.1 MVP优先

优先实现最小可用版本。

禁止过早优化。

---

## 2.2 单用户设计

V1仅服务单用户。

不考虑多租户。

不考虑权限系统。

---

## 2.3 自动化优先

能自动完成的任务尽量自动完成。

减少人工介入。

---

# 3. Phase 0：系统设计

状态：已完成

目标：

完成系统整体设计。

内容：

* PRD设计
* 数据库设计
* 开发计划设计

交付物：

* 01_PRD.md
* 02_DATABASE.md
* 03_DEV_PLAN.md

---

# 4. Phase 1：数据层建设

目标：

建立数据存储能力。

核心工作：

* SQLite数据库
* Prisma模型
* 数据库迁移
* 基础CRUD

涉及模块：

* Resume
* Company
* Job
* Application

完成标准：

能够通过数据库管理全部核心数据。

---

# 5. Phase 2：Resume Center

目标：

建立简历管理中心。

功能：

* 导入简历
* 管理多个版本简历
* 设置默认简历
* 简历标签管理

完成标准：

系统能够根据岗位自动选择简历。

---

# 6. Phase 3：Job Crawler

目标：

建立岗位采集能力。

功能：

* 岗位抓取
* 数据清洗
* 去重
* 入库

完成标准：

系统能够持续获得岗位数据。

---

# 7. Phase 4：Scoring Engine

目标：

建立岗位评分体系。

评分维度：

* 技能匹配
* 行业匹配
* 薪资匹配
* 距离匹配
* 经验匹配

输出：

* JobScore

完成标准：

每个岗位生成可解释评分结果。

---

# 8. Phase 5：Decision Engine

目标：

自动生成投递决策。

决策类型：

AUTO_APPLY

REVIEW

IGNORE

完成标准：

所有岗位自动分类。

---

# 9. Phase 6：Apply Engine

目标：

自动执行投递。

功能：

* 自动打开岗位页面
* 自动填写信息
* 自动上传简历
* 自动提交

完成标准：

完成一次真实投递流程。

---

# 10. Phase 7：Feedback Engine

目标：

追踪投递结果。

状态：

* APPLIED
* VIEWED
* REPLIED
* INTERVIEW
* OFFER
* REJECTED

完成标准：

形成完整求职漏斗。

---

# 11. Phase 8：Strategy Engine

目标：

根据历史数据优化策略。

分析内容：

* 平台效果
* 简历效果
* 行业效果
* 距离效果

完成标准：

自动调整评分权重。

---

# 12. V1验收标准

系统能够：

1. 自动抓取岗位

2. 自动计算匹配度

3. 自动选择简历

4. 自动生成决策

5. 自动投递岗位

6. 自动记录反馈

7. 输出求职统计结果

达到以上标准即视为V1完成。

---

# 13. Phase 实况对照表（2026-09-19 实测修订，DSH 架构师）

> 依据：只读调研 + 代码核查实测（当时 `npm test` 基线 512 断言，本轮收尾 M1~M6 后已达 791），非回忆。

| Phase | 计划 | 实况（2026-09-19） | 差距处置 |
|---|---|---|---|
| 1 数据层 | SQLite+Prisma | ✅ SQLite(`node:sqlite`)+手写迁移；Prisma 仅文档镜像未接运行时 | 不接 Prisma（手写迁移够用）；02_DATABASE.md 已标注 |
| 2 Resume Center | 多版本+自动选 | ✅ 默认简历+tags+findBestMatch 自动选；version 无 UI | 够用，挂账 |
| 3 Job Crawler | 抓取清洗去重 | ✅ API 拦截+DOM 兜底+url upsert；**原缺陷：白名单丢 rawData/JD 正文** | 本轮 M1 修（rawData 整包入库 + 详情增补 `src/enrich.js` + `POST /api/boss/enrich`） |
| 4 Scoring | 技能/行业/薪资/距离/经验 | ⚠️ 原 skill0.6+exp0.2+edu0.2；薪资只做排序键；**距离完全缺失（用户最大痛点根因）**；行业缺失 | 本轮 M1 补距离/宿舍子分（五维权重参数化 skill.5/exp.15/edu.15/distance.15/dorm.05）；行业由 technologies 近似覆盖，不单列 |
| 5 Decision | 自动分类区别处理 | ⚠️ decideJob 三分类存在但 routes **只计数不拦截**，IGNORE 照样被投 | 本轮 M2：真分桶拦截，REVIEW→待确认队列 API（人工放行才进投递集），IGNORE 剔除 |
| 6 Apply | 真实投递闭环 | ✅ 2026-08 验收过（jobId=44 verified=true） | 本轮 M2 加 150/日配额 + 2~4h 随机摊开 + 22:00 截断 + `APPLY_DRY_RUN` 默认 true |
| 7 Feedback | 六态漏斗 | ⚠️ 自动写仅 replied/interview/offer/rejected；viewed 无同步路径；withdrawn 死状态 | viewed 按 BOSS「送达/已读」特征待风控页面实测，本轮不强做；withdrawn 保留手动 PATCH |
| 8 Strategy | 历史数据自动调权 | ⚠️ 仅 3 档启发式阈值+常量权重（无人回写）；自动调权无数据支撑 | 用户拍板降级为「统计面板+建议模式」：按距离档/关键词/宿舍分组出回复率，建议不自动改权重；权重口子已由 M1 参数化预留 |
| - 自动沟通 | V1 不实现（已推翻） | ✅ LLM 回复+PII 脱敏+能力防编造+manualPending；2026-09-19 起主通道=本机 3010 qwen3.8-flash，跨级降级重试 zhipu→deepseek→template | 本轮 M3（含底细卡 `prompts/candidate-card.md` 事实唯一来源 + classifyIntent 面试/裸邀约转人工） |
| - 多平台 | V1 不实现 | ❌ 仅 boss adapter；内核曾与 BOSS 缠绕在 chatApply.js(3260 行) | **明确延后**：本轮 M5 出蓝图 `docs/05_MODULARIZATION_PLAN.md` 并做内核通用化拆分（门面保留），第二平台 adapter 另立项 |

**本轮未列即不做**：行业独立字段、viewed 自动写、微信推送（用户每日开机，控制台待办页顶替）、第二平台 adapter、自动调权。
