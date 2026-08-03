// src/testConnect.ts
// 浏览器连接测试 — 最小可运行验证
// 使用前先启动 Edge：
//   "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222
// 然后运行：
//   npx tsx src/testConnect.ts
import { BrowserManager } from "./browser/browserManager.js";
async function main() {
    const manager = new BrowserManager();
    // 1. 连接 Edge
    console.log("[test] 正在连接 Edge (127.0.0.1:9222)...");
    await manager.connect();
    console.log("[test] ✅ 连接成功");
    // 2. 获取页面并导航
    const page = await manager.getPage();
    await page.goto("https://www.zhipin.com", {
        waitUntil: "domcontentloaded",
        timeout: 15000,
    });
    const title = await page.title();
    console.log(`[test] 页面标题: ${title}`);
    // 3. 验证连接状态
    console.log(`[test] 连接状态: ${manager.connected ? "✅ 已连接" : "❌ 断开"}`);
    // 4. 输出成功标记
    console.log("\n✅ ATTACH OK");
    console.log(`   Browser: Edge (CDP: 127.0.0.1:9222)`);
    console.log(`   Title:   ${title}`);
    // 5. 清理
    await manager.close();
}
main().catch((err) => {
    console.error(`❌ 测试失败: ${err.message}`);
    process.exit(1);
});
