import fs from "fs";

const filePath = "E:\\autonomous-job-agent\\src\\scrapers\\bossScraper.ts";
let content = fs.readFileSync(filePath, "utf-8");

// ═══════════════════════════════════════════
//  1. Remove navigation state machine (lines 9-109)
// ═══════════════════════════════════════════
const stateMachineStart = "\n// ─── Navigation State Machine ───";
const stateMachineEnd = "// ─── 城市编码映射（仅常用城市） ───";

const idxSMStart = content.indexOf(stateMachineStart);
const idxSMEnd = content.indexOf(stateMachineEnd);
if (idxSMStart < 0 || idxSMEnd < 0) { console.error("❌ State machine bounds not found"); process.exit(1); }

const stateMachineBlock = content.substring(idxSMStart, idxSMEnd);
content = content.replace(stateMachineBlock, "\n");
console.log("✅ 1. Navigation state machine removed");

// ═══════════════════════════════════════════
//  2. Remove withSearchLock wrapper in search()
// ═══════════════════════════════════════════
// Replace "return withSearchLock(\"search\", async () => {" with nothing, 
// and the closing "});" with nothing
content = content.replace('return withSearchLock("search", async () => {', "");
content = content.replace('    });\n  },\n\n  getDetail: getDetailImpl,};', '  },\n\n  getDetail: getDetailImpl,};');
console.log("✅ 2. search() lock wrapper removed");

// ═══════════════════════════════════════════
//  3. Remove pool/detail page infrastructure
//     from "// ─── getDetail 实现..." through "function recordAttempt"
// ═══════════════════════════════════════════
const poolStart = "\n// ─── getDetail 实现（复用 pooled detail page，避免高频 newPage）───";
const poolEnd = "\nconst KNOWN_CITIES";

const idxPoolStart = content.indexOf(poolStart);
const idxPoolEnd = content.indexOf(poolEnd);
if (idxPoolStart < 0 || idxPoolEnd < 0) { console.error("❌ Pool infrastructure bounds not found"); process.exit(1); }

const poolBlock = content.substring(idxPoolStart, idxPoolEnd);
content = content.replace(poolBlock, "\n");
console.log("✅ 3. Pool/page infrastructure removed");

// ═══════════════════════════════════════════
//  4. Remove the old getDetailImpl function 
//     (everything after EVAL_SCRIPT up to end of file)
// ═══════════════════════════════════════════
const oldImplStart = "\n\nasync function getDetailImpl(url: string, page: any): Promise<JobPosting | null> {";
const oldImplEnd = "\n\n\n";

const idxImplStart = content.indexOf(oldImplStart);
const idxImplEnd = content.lastIndexOf(oldImplEnd);
if (idxImplStart < 0 || idxImplEnd < 0) { console.error("❌ getDetailImpl bounds not found"); process.exit(1); }

const oldImplBlock = content.substring(idxImplStart, idxImplEnd);
content = content.replace(oldImplBlock, "");
console.log("✅ 4. Old getDetailImpl removed");

// ═══════════════════════════════════════════
//  5. Insert new getDetailImpl
// ═══════════════════════════════════════════
// Find where the EVAL_SCRIPT ends and insert after it
const evalScriptEnd = "`;\n";
const idxEvalEnd = content.lastIndexOf(evalScriptEnd);
if (idxEvalEnd < 0) { console.error("❌ EVAL_SCRIPT end not found"); process.exit(1); }

const newImpl = `
// ─── getDetail 实现（点击式：复用列表页 page，模拟用户点击进入详情 SPA）───

async function getDetailImpl(url: string, page: any): Promise<JobPosting | null> {
  try {
    // 1. 从 URL 中提取 path，找到对应卡片并点击
    let hrefPart: string;
    try { hrefPart = new URL(url).pathname; } catch { hrefPart = url; }
    // 简单转义特殊字符用于选择器
    const safeHref = hrefPart.replace(/[.*+?^$\\{}()|[\\]\\\\]/g, "\\\\$&");

    const clicked = await page.evaluate((part: string) => {
      const link = document.querySelector(\`a[href*='\${part}']\`) as HTMLAnchorElement | null;
      if (!link) return false;
      const card = link.closest(".job-card-box") || link;
      card.scrollIntoView({ block: "center" });
      link.click();
      return true;
    }, safeHref);

    if (!clicked) {
      console.log(\`  [bossScraper] ⚠️ 未找到匹配的职位卡片: \${url.slice(0,60)}\`);
      return null;
    }

    // 2. 等待 SPA 路由切换到详情页
    try {
      await page.waitForFunction(
        \`window.location.href.includes('/job_detail/')\`,
        { timeout: 15000 }
      );
    } catch {
      console.log(\`  [bossScraper] ⚠️ 点击后未导航到详情页\`);
      return null;
    }

    // 3. 等待详情内容渲染
    await sleep(2000);

    // 4. 提取详情数据
    let detail = await page.evaluate(EVAL_SCRIPT).catch(() => null);

    if (!detail || (!detail.title && !detail.company)) {
      console.log(\`  [bossScraper] ⚠️ 首次提取为空，等待2秒重试...\`);
      await sleep(2000);
      detail = await page.evaluate(EVAL_SCRIPT).catch(() => null);
      if (!detail || (!detail.title && !detail.company)) {
        console.log(\`  [bossScraper] ⚠️ 重试后仍为空，返回\`);
        try { await page.goBack().catch(() => {}); } catch {}
        return null;
      }
    }

    // 5. 处理技术关键词
    const BENEFITS = ["五险一金","补充医疗","餐补","年假","节日福利","股票期权","交通补助","房补","通讯补贴","定期体检","年终奖","绩效","全勤","员工旅游","零食","下午茶","生日","团建","聚餐","补贴","双休","弹性工作"];
    const allTechs = [
      ...new Set([ ...extractTechs((detail.description||"") + " " + (detail.requirements||"")) ]),
    ].filter((t: string) => t.length > 1 && !["台州","周礼洋"].includes(t) && !BENEFITS.some((b: string) => t.includes(b)));

    const result: JobPosting = {
      title: detail.title || "未知职位",
      salary: detail.salary || "",
      company: detail.company || "",
      city: detail.city || "",
      url,
      source: "zhipin",
      description: detail.description || "",
      requirements: detail.requirements || "",
      technologies: allTechs,
      education: detail.education || "",
      experience: detail.experience || "",
      updatedAt: detail.updateTime || "",
    };

    // 6. 返回列表页（SPA 后退）
    try { await page.goBack(); } catch {}
    await sleep(1500);

    return result;
  } catch (e: any) {
    console.error(\`  [bossScraper] getDetail 失败: \${e.message?.slice(0, 60)}\`);
    try { await page.goBack().catch(() => {}); } catch {}
    return null;
  }
};
`;

// Insert after EVAL_SCRIPT
const insertPos = idxEvalEnd + evalScriptEnd.length;
content = content.substring(0, insertPos) + newImpl + content.substring(insertPos);

console.log("✅ 5. New click-based getDetailImpl inserted");

fs.writeFileSync(filePath, content, "utf-8");
console.log("✅ Refactoring complete!");
