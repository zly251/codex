# 文档导航

本目录存放求职助手的全部设计文档与界面截图。**建议按下面的顺序阅读**。

## 1. 想快速了解这个项目

→ 回到 [项目根 README](../README.md)，那里有功能清单、界面预览和启动步骤。

## 2. 想搞懂它怎么设计的（按顺序读）

| 文档 | 内容 |
| --- | --- |
| [01_PRD.md](01_PRD.md) | 产品需求：要解决什么问题、给谁用、边界在哪 |
| [02_DATABASE.md](02_DATABASE.md) | 数据模型：Job / Company / Application / Resume / ReviewQueue 表结构 |
| [03_DEV_PLAN.md](03_DEV_PLAN.md) | 开发计划与里程碑（M1~M6） |
| [04_MULTI_AGENT.md](04_MULTI_AGENT.md) | 多 Agent 协作约定 |
| [05_MODULARIZATION_PLAN.md](05_MODULARIZATION_PLAN.md) | 模块化拆分蓝图（chatApply 门面拆分，步骤 1 已落地） |
| [06_TARGET_ARCHITECTURE.md](06_TARGET_ARCHITECTURE.md) | 目标架构：L1 core / L2 modules 分层与红线 |
| [07_SECOND_OPINION_20260930.md](07_SECOND_OPINION_20260930.md) | 架构方案的第二意见与裁决 |
| [08_COMPATIBILITY_MATRIX.md](08_COMPATIBILITY_MATRIX.md) | 兼容矩阵与事实冻结（P0.0） |

## 3. 想看界面长什么样

新版截图集合在 [screenshots/](screenshots/)：

| 文件 | 页面 |
| --- | --- |
| [01-dashboard.png](screenshots/01-dashboard.png) | Agent 状态（总览仪表盘） |
| [02-jobs.png](screenshots/02-jobs.png) | 岗位推荐流（匹配度 + 沟通入口） |
| [03-pipeline.png](screenshots/03-pipeline.png) | 投递 Pipeline（待处理/已查看/已回复/面试/Offer 看板） |
| [04-resume.png](screenshots/04-resume.png) | 简历 AI（完整性评分 + 优化建议 + 结构化编辑） |
| [05-tasks.png](screenshots/05-tasks.png) | 任务监控（自动化任务 + 搜索/投递参数） |


## 4. 代码从哪看起

| 路径 | 职责 |
| --- | --- |
| `src/core/` | L1 通用能力：契约（contracts）、守卫（guards）、纯判据（distance/salary/predicates/utils），**不得反向依赖平台层** |
| `src/modules/` | L2 业务模块：ingest / value / copilot / evidence / console，**模块之间零依赖**，输出带 `schemaVersion` |
| `src/platforms/` | 平台适配层（当前 BOSS 直聘），实现统一 adapter 接口 |
| `src/db/` | SQLite 数据访问与迁移 |
| `src/chatApply.js` | 聊天/打招呼门面（历史上最大的单文件，拆分见 05 号文档） |
| `server.mjs` | 本地 HTTP 服务 + REST API + 静态资源 |
| `web/` | 单页 Web 控制台（无框架，原生 JS + CSS） |
| `extension/` | 浏览器侧边栏扩展（只读采集页面文本） |
| `scripts/` | 构建、打包、测试与开发辅助脚本 |
| `tests/` | 模块级测试（与 `scripts/test-*.mjs` 共同构成测试套件） |
| `packaging/` | 图标与 Windows exe 打包资源 |
| `prompts/` | 提示词资产（含候选人「底细卡」） |
| `prisma/` | 数据模型辅助定义 |
| `assets/` | 品牌资产（logo、favicon、社交预览图） |

## 5. 想跑起来 / 想打包

→ 见根 README 的「启动」与「打包为 Windows exe」两节。
