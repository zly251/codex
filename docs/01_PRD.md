# Autonomous Job Search Agent V1

## 项目定位

自主求职代理系统（Autonomous Job Search Agent）。

目标是替代用户完成岗位筛选、岗位分析和简历投递工作，提高求职效率和面试转化率。

---

## 用户类型

单用户系统。

仅开发者本人使用。

不考虑：

* 多用户
* SaaS
* 支付
* 权限系统

---

## 核心目标

1. 自动搜索岗位

2. 自动筛选岗位

3. 自动计算岗位匹配度

4. 自动选择对应简历

5. 自动投递简历

6. 记录求职反馈

7. 动态优化投递策略

---

## 核心流程

Resume

↓

Search Job

↓

Filter Job

↓

Score Job

↓

Decision

↓

Apply

↓

Feedback

↓

Strategy Optimization

---

## 核心模块

### Resume Center

管理多份简历。

例如：

* Qt简历
* C++简历
* 嵌入式简历

---

### Job Crawler

从Boss直聘抓取岗位数据。

---

### Filter Engine

过滤：

* 薪资不符合
* 学历不符合
* 外包岗位
* 驻场岗位
* 城市不符合

---

### Scoring Engine

评分维度：

* 技能匹配
* 薪资匹配
* 学历匹配
* 经验匹配
* 通勤匹配

输出：

0~100分

---

### Decision Engine

岗位分类：

AUTO_APPLY

REVIEW

IGNORE

---

### Apply Engine

自动选择简历。

自动执行投递。

---

### Feedback Engine

记录：

* 已投递
* 已查看
* 已回复
* 面试
* Offer

---

### Strategy Engine

根据历史数据优化投递策略。

---

## 通勤策略

0~5km

优先岗位

---

5~15km

待确认岗位

---

15km以上

观察岗位

---

## V1不实现

* 自动聊天
* YOLO
* OCR
* 本地大模型
* 语音Agent
* 多平台支持
* 自动面试

---

## 勘误与现状（2026-09-19 更新，DSH 架构师）

> 本节为文档对齐：上文「V1不实现」是 6 月的原始计划，**其中多项已被后续实现推翻**（逐字保留作历史）。各 Phase 证据见 `03_DEV_PLAN.md` 末尾「Phase 实况对照表」。

| 原「不实现」项 | 现状（2026-09-19 实测） |
|---|---|
| 自动聊天 | **已实现**：聊天监控 + LLM 自动回复，面试/Offer/入职类强制转人工待办 |
| OCR | **已实现**：tesseract.js（chi_sim/eng），简历图片解析 |
| 本地大模型 | **部分**：回复走本机网关（127.0.0.1:3010，不出本机），未内嵌权重 |
| 多平台支持 | **仍不做，明确延后**：adapter 抽象已具备，猎聘/智联未实现；内核通用化见 `05_MODULARIZATION_PLAN.md` |
| 语音Agent / 自动面试 / YOLO | 仍不做 |
| 简历截图发送 | **计划外新增已实装**（规避未回复禁发附件） |

**通勤策略修订（2026-09-19 用户拍板，替代上文「通勤策略」三档）**：原点=家坐标（由 config/region.json 的 home 决定，示例为北京市中心 WGS84 39.9087,116.3975）；≤5km 最优 / 5-15km 可收 / >15km 或外区县**有宿舍→高优先，无宿舍→IGNORE**；跨市=IGNORE。实现：`src/distance.js` + `src/scoring.js` 距离/宿舍子分。

**投递节奏（新增需求）**：日配额 150 上限、2~4h 随机摊开、间隔随机+定期长休息、22:00 截止、`APPLY_DRY_RUN` 默认 true（真实投递需人工放行）。实现：`src/applyScheduler.js`。
