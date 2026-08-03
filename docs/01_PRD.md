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
