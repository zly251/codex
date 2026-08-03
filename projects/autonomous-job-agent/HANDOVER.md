# 求职助手 交接文档

## 项目

- 用途：BOSS直聘自动搜索、筛选、投递（打招呼）助手
- 源码：`E:\autonomous-job-agent`
- 运行：桌面 `C:\Users\asus\Desktop\求职助手.exe`，单文件 SEA 打包

## 数据位置

- 运行数据：`E:\autonomous-job-agent\portable\`
- 登录配置：`E:\autonomous-job-agent\.edge-profile`
- Cookie 备份：`portable\data\boss-cookies.json`
- 用户档案：`portable\data\profile.json`
- 数据库：`%TEMP%\autonomous-job-agent\dev.db`
- 看护日志：`portable\data\watchdog.log`

## 构建

```powershell
esbuild packaging/entry.cjs -> dist/sea-entry.cjs
esbuild server.mjs -> dist/sea-server.cjs
node --experimental-sea-config sea-config.json
Copy-Item E:\node.exe dist\求职助手.exe
postject dist\求职助手.exe NODE_SEA_BLOB dist\sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
```

postject 后会损坏签名，需手工把 PE subsystem 从 3 改为 2（GUI）。

## 已修复问题

- 登录态：固定复用 `.edge-profile`；登录后 Cookie 自动备份，启动时自动恢复。
- 未登录时点“开始投递”：直接提示扫码，不再关闭 BOSS 页面。
- Edge 连接失败：先重试 5 次；看护只在端口连续不可用 3 次后才重启 Edge，避免自杀式重启循环。
- 所有 PowerShell/cmd 子进程均隐藏窗口，不再闪黑框。
- 单职位“手动沟通”只处理 1 个职位；批量投递按当前筛选条件处理多个。
- 评分引擎：按技能、经验、学历多维计算匹配度，投递前自动更新评分并按分数排序。
- MVP 闭环：自动生成 AUTO_APPLY/REVIEW/IGNORE 决策，投递记录自动关联最匹配的简历。
- 简历闭环：启动时用个人档案自动生成默认简历，历史投递记录自动补挂 resumeId。
- 决策统计：AUTO_APPLY/REVIEW/IGNORE 基于全量候选职位统计，不再漏掉 IGNORE。
- 反馈与策略：新增 `/api/strategy` 与概览漏斗，按回复率给出建议匹配度阈值。
- 并发锁：同一时间只允许一个投递任务，重复点击返回“已有任务运行中”。
- 页面保留：失败时不再关闭最后一个 BOSS 标签页，改为回到职位列表，避免 Edge 整体退出。
- 空页重试：页面内容不足时自动 reload 一次再判断，减少“内容为空”误报。
- 标签策略：不再用 CDP 新建标签直接打开职位页，避免被 BOSS 强制关闭成 about:blank。
- 登录页优先：自动优先复用已登录的 BOSS 标签页。
- 单实例：重复启动 exe 会通过 API 指纹识别旧实例并自动顶掉，只保留一个新进程。
- 未登录引导：Cookie 恢复失败时自动打开 BOSS 扫码登录页，不再停留在首页。

## 当前状态

- 已登录，Cookie 已备份。
- 最近一次“手动沟通”成功：初级软件工程师。
- 批量投递会先按新评分排序，再取前 N 个职位执行。
- MVP 验收流程已闭环：抓取 → 评分 → 决策 → 自动投递 → 记录反馈 → 统计。
- 当前 exe 已覆盖桌面并运行中，服务地址 http://127.0.0.1:3456。
- 2026-08-03 验证：单职位决策输出正常，已沟通职位自动跳过，不会重复发消息。
- 2026-08-03 验证：空页面失败后 Edge 保持运行，BOSS 页面保留在职位列表；并发请求返回 busy。
- 2026-08-03 验证：重复启动 exe 后旧进程被自动替换，只保留一个实例，登录态保持。

## 下次接手要点

- 若 BOSS 要求重新扫码：在程序自动打开的 BOSS 窗口扫码一次即可，Cookie 会自动备份。
- 页面若长时间未打开：看护会在端口持续不可用约 1 分钟后自动拉起 Edge。

## Git

- 远端：https://github.com/zly251/codex.git
- 本地工作区：D:\codex
- 仓库内路径：projects\autonomous-job-agent
- E 盘 .git 被 ACL 拒绝写入，源码变更需同步到 D:\codex 后提交
- 许可证：MIT，LICENSE 文件已包含
- 状态：2026-08-03 已并入 Codex 工作区仓库

```powershell
cd D:\codex
robocopy E:\autonomous-job-agent projects\autonomous-job-agent /E /XD node_modules dist portable data .edge-profile .edge-profile-2 get_jobs temp tmp /XF *.log .env
git add projects/autonomous-job-agent
git commit -m "说明"
git push
```
