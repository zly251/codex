// src/testBossScraper.ts
// Boss直聘爬虫完整验收测试 — 基于 BrowserManager
// 使用前：
//   1. Edge 已启动：msedge.exe --remote-debugging-port=9222
//   2. Edge 中已登录 Boss直聘
//   3. npx tsx src/testBossScraper.ts
import { BrowserManager } from "./browser/browserManager.js";
import { bossScraper } from "./scrapers/bossScraper.js";
async function main() {
    const manager = new BrowserManager();
    // ─── 1. 连接 ───
    console.log("[1/3] 连接 Edge...");
    await manager.connect();
    const page = await manager.getPage();
    console.log("      ✅ 已连接\n");
    // ─── 2. search ───
    console.log("[2/3] search() — 关键词: Java, 城市: 台州");
    const result = await bossScraper.search({ keywords: "Java", city: "台州", maxJobs: 5, pageDelay: 2000 }, page);
    if (result.jobs.length === 0) {
        console.log("      ⚠️  未找到职位，跳过 getDetail");
        console.log(`      有下一页: ${result.hasNext}`);
        await manager.close();
        return;
    }
    console.log(`      ✅ 返回 ${result.jobs.length} 个职位`);
    console.log(`      有下一页: ${result.hasNext}`);
    console.log("");
    result.jobs.forEach((j, i) => {
        console.log(`       [${i + 1}] ${j.title.slice(0, 50)}`);
        console.log(`             ${j.url}`);
    });
    // ─── 3. getDetail ───
    console.log("\n[3/3] getDetail() — 第一个职位");
    const firstUrl = result.jobs[0].url;
    const detail = await bossScraper.getDetail(firstUrl, page);
    if (!detail) {
        console.log("      ⚠️  getDetail 返回 null");
        await manager.close();
        return;
    }
    console.log("      ✅ 详情抓取成功\n");
    // 打印完整 JSON
    console.log("=".repeat(60));
    console.log("JobPosting JSON");
    console.log("=".repeat(60));
    console.log(JSON.stringify(detail, null, 2));
    // ─── 4. 清理 ───
    await page.close().catch(() => { });
    await manager.close();
}
main().catch((err) => {
    console.error(`\n❌ 测试失败: ${err.message}`);
    process.exit(1);
});
