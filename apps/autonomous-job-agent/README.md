# Codex AI Engineering Workspace

个人 AI 工程实验仓库。

用于管理基于 Codex、DeepSeek、Agent、ComfyUI 等技术栈的 AI 自动化开发项目，包括模型配置、Agent 工作流、提示词工程、自动化脚本以及实验记录。

## 当前项目：求职助手

BOSS直聘自动搜索、筛选、投递（打招呼）助手，本地运行，登录态自动复用。

## 功能

- 自动连接本机 Edge（CDP 9222），固定复用登录配置
- 按筛选条件搜索、抓取并解析 BOSS 直聘职位
- 按技能、经验、学历计算岗位匹配度
- 自动生成 AUTO_APPLY / REVIEW / IGNORE 投递决策，投递记录自动关联匹配简历
- 个人档案自动生成默认简历，历史投递记录自动补挂简历关联
- 批量投递打招呼，单职位手动沟通
- 聊天会话监控，支持查看和发送消息
- Cookie 自动备份与恢复
- 看护进程在 Edge 异常后自动重试拉起
- 单任务并发锁，重复投递会被拦截
- 重复启动 exe 会自动顶掉旧实例，不产生双看护进程
- 投递失败时保留最后一个 BOSS 页面，不再关闭 Edge
- 反馈漏斗统计（待处理/已查看/已回复/面试/Offer）与策略建议
- 本地 Web 控制台，默认 http://localhost:3456

## 技术栈

- Node.js + ESM
- puppeteer-core（CDP 控制 Edge）
- tesseract.js（图片 OCR）
- Prisma + SQLite（本地数据库）
- 原生 http 服务 + 单页 Web UI
- Node SEA 单文件 exe 打包

## 环境要求

- Windows 11
- Microsoft Edge
- Node.js 18+
- 无需 GPU

## 启动

双击 `求职助手.bat`，或手动运行：

```powershell
cd E:\autonomous-job-agent
npm install
npx tsx server.mjs
```

浏览器打开 http://localhost:3456

首次使用在自动打开的 BOSS 直聘窗口扫码登录，Cookie 会自动备份。

## 数据位置

- 运行数据：`portable/`
- 登录配置：`.edge-profile/`，备用 `.edge-profile-2/`
- 用户档案：`data/profile.json`
- Cookie 备份：`portable/data/boss-cookies.json`
- 本地数据库：`%TEMP%\autonomous-job-agent\dev.db`

## 打包为单文件 exe

```powershell
npx esbuild packaging/entry.cjs --bundle --platform=node --format=cjs --outfile=dist/sea-entry.cjs
npx esbuild server.mjs --bundle --platform=node --format=cjs --outfile=dist/sea-server.cjs
node --experimental-sea-config sea-config.json
Copy-Item E:\node.exe dist\求职助手.exe
postject dist\求职助手.exe NODE_SEA_BLOB dist\sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
```

postject 后会损坏签名，需要把 PE subsystem 从 3 改为 2（GUI）。

## Git

- 远端：https://github.com/zly251/codex
- 本地工作区：`D:\codex`
- 仓库内路径：`apps\autonomous-job-agent`
- E 盘 `.git` 被 ACL 拒绝写入，源码变更需同步到 D:\codex 后提交

```powershell
robocopy E:\autonomous-job-agent D:\codex\apps\autonomous-job-agent /E /XD node_modules dist portable data .edge-profile .edge-profile-2 get_jobs temp tmp .git /XF *.log .env /NFL /NDL /NJH /NJS
git -C D:\codex add apps/autonomous-job-agent
git -C D:\codex commit -m "说明"
git -C D:\codex push
```

## License

MIT License，见 [LICENSE](LICENSE)。
