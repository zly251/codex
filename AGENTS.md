# 多 Agent 协作规则

本项目已启用多 Agent 协作。复杂任务默认由 Codex 作为编排者拆解、分配、验收，不再只靠单条会话串行处理。

## 执行流程

1. Codex 拆解任务：
   - 先做一次只读探索，确认现有结构。
   - 把目标拆成文件边界不重叠的子任务。
   - 每个子任务必须写明负责人、文件范围、交付物、验证方式。
2. Codex 原生子代理：
   - 探索、调研、审查优先使用只读子代理。
   - 代码修改使用 worker 子代理。
   - 禁止多个子代理同时修改同一文件。
3. ReasonX 执行：
   - 需要 ReasonX 执行时调用 `scripts/run-reasonix.ps1`。
   - 每次只传一个具体任务。
   - 脚本默认使用 `--permission-mode auto`，任务描述必须明确限制修改范围。
   - 结束后读取 JSON 结果并自行验收。
4. 验收：
   - 汇总所有子任务结果。
   - 统一运行验证命令。
   - 不提交临时文件、日志、模型、密钥。

## reverse-skill 维护提示

当 BOSS直聘抓取、投递、登录或聊天链路因接口变化、DOM 改版、签名/风控字段变化而失效时，优先使用 `reverse-skill` skill。

入口：`D:\opensource\reverse-skill\skills\SKILL.md`

该项目的排查默认走 `js-reverse` 与 `browser-automation` 模块，不直接对 BOSS 使用渗透测试或攻击链模块。
