# 多 Agent 协作

## 当前配置

- Codex：编排者，负责拆解任务、分配子任务、汇总验收。
- ReasonX：执行者，负责具体编码、探索、调研、审查。
- 项目文件：
  - `AGENTS.md`：Codex 多 Agent 执行规则。
  - `scripts/run-reasonix.ps1`：Codex 调用 ReasonX 的封装。
  - `prompts/reasonix/executor.md`：项目执行子智能体提示词。
  - `prompts/reasonix/reviewer.md`：项目审查子智能体提示词。

## 方式一：Codex 原生多 Agent

在 Codex 对话中直接说明：

```text
把这个任务拆成 N 个不重叠子任务，并行执行，最后统一验收。
```

Codex 会使用自己的 explorer/worker 子代理。拆分时按目录或模块划分文件写范围，避免两个子代理同时改同一个文件。

## 方式二：Codex 领头，ReasonX 执行

ReasonX CLI 位于：

```text
通过环境变量 REASONIX_BIN 指定，或确保 reasonix 在 PATH 中
```

通过项目封装脚本调用：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/run-reasonix.ps1 `
  -Task "修复 src/scoring.js 中的边界条件，并运行验证" `
  -Model deepseek-flash `
  -PermissionMode auto
```

如果 ReasonX CLI 安装在项目外，建议设置：

```powershell
$env:REASONIX_BIN = "你的 reasonix-cli.exe 路径"
```

参数说明：

- `-Task`：必须传一个具体任务，不要传多个需求。
- `-Model`：`deepseek-flash`、`deepseek-pro`、`mimo-pro`、`mimo-flash`。
- `-PermissionMode`：默认 `auto`，适合 Codex 编排的自动化执行。
- `-MaxSteps`：限制 ReasonX 最大工具调用轮数。
- `-AllowedTools`：可选，逗号分隔限制可用工具。
- 输出和指标写入 `tmp\reasonix\`，该目录已被 `.gitignore` 忽略。

## 方式三：ReasonX 子智能体

ReasonX 自带只读子智能体：

```powershell
reasonix subagent run explore "<代码探索任务>"
reasonix subagent run research "<调研任务>"
reasonix subagent run review "<审查任务>"
reasonix subagent run security-review "<安全审查任务>"
```

项目执行子智能体：

```powershell
reasonix subagent run executor "<具体编码任务>"
```

也可以用封装脚本执行编码任务，输出会写入 `tmp\reasonix\`：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/run-reasonix.ps1 `
  -Task "<具体编码任务>"
```

## 分工建议

- 需求拆解、最终验收：Codex。
- 代码探索、影响面调查：`explore`。
- 技术调研、方案对比：`research`。
- 具体编码、修复、测试：`executor`。
- 改动审查、安全审查：`review`、`security-review`。

## 注意事项

- 一个 ReasonX 调用只做一件具体任务。
- 多个 ReasonX 执行任务必须写不同文件，不能并发改同一文件。
- ReasonX 完成后必须回到 Codex 统一验收。
- 不提交临时脚本、日志、模型、密钥和生成目录。
