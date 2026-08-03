// src/scrapers/bossScraper.ts
// Boss直聘爬虫 — 实现 JobScraper 接口
// 依赖：puppeteer-core（需配合 Edge --remote-debugging-port=9222 使用）

import type { JobPosting, SearchConfig, SearchResult, JobScraper } from "./interface.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── 城市编码映射（仅常用城市） ───
const CITY_CODES: Record<string, string> = {
  "北京": "101010100",
  "上海": "101020100",
  "广州": "101280100",
  "深圳": "101280600",
  "杭州": "101210100",
  "台州": "101210600",
  "成都": "101270100",
  "武汉": "101200100",
  "南京": "101190100",
  "苏州": "101190400",
  "西安": "101110100",
};

// ─── 技术关键词（从文本中提取） ───
const TECH_KEYWORDS = [
  "c++", "qt", "librecad", "cad", "opengl", "occ",
  "opencascade", "几何", "图形学", "图形", "三维", "3d",
  "python", "java", "javascript", "typescript",
  "linux", "windows", "mfc", "cmake", "git",
  "视觉", "点云", "渲染", "建模", "仿真",
  "数据库", "mysql", "redis",
  "docker", "k8s", "kubernetes",
  "spring", "vue", "react", "node",
  "算法", "深度学习", "机器学习",
];

function escapeRx(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function extractTechs(text: string): string[] {
  return TECH_KEYWORDS.filter((kw) => {
    // 纯字母关键词用单词边界匹配（避免 "java" 匹配 "javascript"）
    if (/^[a-zA-Z][a-zA-Z0-9]*$/.test(kw)) {
      return new RegExp(`\\b${escapeRx(kw)}\\b`, "i").test(text);
    }
    return text.toLowerCase().includes(kw.toLowerCase());
  });
}

// ─── 爬虫实现 ───

export const bossScraper: JobScraper = {
  name: "zhipin",

  supports(url: string): boolean {
    return url.includes("zhipin.com");
  },

  async search(config: SearchConfig, page: any): Promise<SearchResult> {

    // 检查 URL 是否为列表页
    const url = page.url();
    console.log(`  [search] 当前 URL: ${url.slice(0, 80)}`);
    const pageTitle = await page.title().catch(() => "?");
    console.log(`  [search] 页面标题: ${pageTitle.slice(0, 50)}`);

    // 验证是否是列表页 URL
    if(!url.includes("/web/geek/job") && !url.includes("/job_detail") && !url.includes("/job") && !url.includes("zhipin.com")){
      console.log(`  [search] ⚠️ 非列表页，跳过 search`);
      return { jobs: [], hasNext: false };
    }

    // 等待列表加载
    try {
      await page.waitForSelector(".job-card-box", { timeout: 8000 });
    } catch {
      const bodyText = await page.evaluate(
        `document.body?.innerText?.slice(0,200) || ""`
      ).catch(() => "读取失败");
      console.log(`  [search] ⚠️ 未找到 .job-card-box, body: ${bodyText.replace(/\n/g," | ").slice(0,100)}`);
      return { jobs: [], hasNext: false };
    }

    // 提取所有职位链接 + 标题
    let jobs: { url: string; title: string }[];
    try {
      jobs = await page.evaluate(() => {
        const cards = document.querySelectorAll(".job-card-box");
        return [...cards]
          .map((c) => {
            const jobLink = c.querySelector("a[href*='/job_detail/']");
            if (!jobLink) return null;
            return {
              url: jobLink.getAttribute("href") || "",
              title: (jobLink.textContent || "").trim().slice(0, 60),
            };
          })
          .filter((j): j is { url: string; title: string } => j !== null);
      });
    } catch {
      console.log(`  [search] ⚠️ evaluate 执行上下文销毁，等待2秒重试...`);
      await sleep(2000);
      jobs = await page.evaluate(() => {
        const cards = document.querySelectorAll(".job-card-box");
        return [...cards]
          .map((c) => {
            const jobLink = c.querySelector("a[href*='/job_detail/']");
            if (!jobLink) return null;
            return { url: jobLink.getAttribute("href") || "", title: (jobLink.textContent || "").trim().slice(0, 60) };
          })
          .filter((j): j is { url: string; title: string } => j !== null);
      }).catch(() => []);
    }

    // 补全相对链接
    const fullJobs = jobs.map((j) => ({
      url: `https://www.zhipin.com${j.url}`,
      title: j.title,
    }));

    // 检查是否有下一页
    const hasNext = await page.evaluate(() => {
      const btn = document.querySelector(".ui-icon-arrow-right, [class*=next]");
      if (!btn) return false;
      const cls = btn.className || "";
      const disabled = cls.includes("disabled") || cls.includes("disable");
      return !disabled;
    });

    return { jobs: fullJobs, hasNext };
  },

  getDetail: getDetailImpl,};


const KNOWN_CITIES = ["北京","上海","广州","深圳","杭州","台州","成都","武汉","南京","苏州","西安","重庆","天津","长沙","郑州","东莞","青岛","厦门","宁波","大连","合肥","佛山","福州","哈尔滨","济南","温州","昆明","贵阳","南宁","海口","长春","太原","石家庄","南昌","乌鲁木齐","兰州","中山","惠州","嘉兴","常州","徐州","绍兴","珠海","保定","沈阳"];

const EVAL_SCRIPT = `
(() => {
  // ——— 定位主容器（优先级从具体到通用） ———
  function findContainer() {
    const selectors = [
      ".job-primary.detail-box",
      ".job-detail-container",
      ".job-detail-box",
      ".job-detail-content",
      ".page-job-detail",
      ".job-box",
      "[class*='job-detail']",
      "[class*='detail-box']"
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && (el.innerText||"").trim().length > 500) return el;
    }
    // fallback: h1 的最近语义父容器
    const h1 = document.querySelector("h1");
    if (h1) {
      let p = h1.parentElement;
      while (p && p !== document.body) {
        if ((p.innerText||"").trim().length > 500) return p;
        p = p.parentElement;
      }
    }
    return document.body; // 最后备胎
  }
  const container = findContainer();
  const containerText = (container.innerText||"").trim();
  // 诊断：记录容器信息
  const containerTag = container.tagName || "?";
  const containerClass = (container.className||"").slice(0,60);
  const lines = containerText.split(/\\n/).map(s=>s.trim()).filter(Boolean);
  const fullText = lines.join("\\n");
  // title: h1（始终精准定位，不依赖容器）
  const h1 = document.querySelector("h1");
  const title = h1 ? (h1.innerText||"").trim() : (lines[0]||"");
  // salary: 只在容器内搜索
  const salMatch=fullText.match(/\\d+[\\.\\d]*\\s*[-~至到]\\s*\\d+[\\.\\d]*\\s*K/i); const salary=salMatch?salMatch[0].trim():"";
  const expMatch=fullText.match(/\\d+\\s*[-~]\\s*\\d+\\s*年|\\d+\\s*年(?:以上|以下|经验)/); const experience=expMatch?expMatch[0].trim():"";
  const eduMatch=fullText.match(/本科|大专|硕士|博士|MBA|EMBA/); const education=eduMatch?eduMatch[0]:"";
  const cities = ${JSON.stringify(KNOWN_CITIES)}; let city=""; for(const c of cities){ if(fullText.includes(c)){ city=c; break; } }
  // company: 全局链接 + 容器内 fallback
  const coLink=document.querySelector("a[href*='/gongsi/']"); let company="";
  if(coLink){ company=(coLink.innerText||"").trim(); if(!company||company==="公司"||company==="查看全部"){ const d=coLink.querySelector("span,b,strong"); company=d?(d.innerText||"").trim():""; } }
  if(!company||company==="公司"||company==="查看全部"){ const idx=containerText.indexOf(title); if(idx>=0){ const after=containerText.slice(idx+title.length).trim().split(/\\n/).map(s=>s.trim()).filter(Boolean); for(const ln of after){ if(!ln||/K\\b|\\d+-\\d|^\\d+|经验|学历|本科|硕士|博士/.test(ln)) continue; if(ln.length>1&&ln.length<30){ company=ln; break; } } } }
  const timeMatch=fullText.match(/(?:更新|发布|活跃|在线)\\s*(?:于|：|:)?\\s*\\d{1,4}[年月日时分]|\\d{1,2}分钟前|\\d{1,2}小时前|\\d{1,2}天前|刚刚/i); const updateTime=timeMatch?timeMatch[0].trim():"";
  let description="", requirements=""; const descIdx=fullText.indexOf("职位描述"), reqIdx=fullText.indexOf("任职要求");
  if(descIdx>=0){ const endIdx=reqIdx>descIdx?reqIdx:fullText.length; description=fullText.slice(descIdx+4,endIdx).trim(); }
  if(reqIdx>=0) requirements=fullText.slice(reqIdx+4).trim();
  if(!description){ const bl=lines.filter(l=>l.length>50).sort((a,b)=>b.length-a.length); if(bl.length>0) description=bl.slice(0,3).join("\\n"); }
  return { title, salary, company, city, description: (description||"").slice(0,500), requirements: (requirements||"").slice(0,500), infoTags: [], updateTime, experience, education };
})()
`;

// ─── getDetail 实现（点击式：复用列表页 page，模拟用户点击进入详情 SPA）───

async function getDetailImpl(url: string, page: any): Promise<JobPosting | null> {
  // 保存当前列表页 URL，用于导航返回
  const listUrl = page.url();
  console.log(`  [bossScraper] getDetail: ${url.slice(0,80)}`);
  console.log(`  [bossScraper] 当前列表页: ${listUrl.slice(0,80)}`);

  try {
    // 1. 直接导航到详情页（不走 SPA 点击，更稳定）
    console.log(`  [bossScraper] 导航到详情页: ${url.slice(0,80)}`);
    await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 });
    console.log(`  [bossScraper] 导航完成: ${page.url().slice(0,80)}`);

    // 2. 等待详情内容渲染
    await sleep(2000);

    // 3. 提取详情数据
    let detail = await page.evaluate(EVAL_SCRIPT).catch(() => null);

    if (!detail || (!detail.title && !detail.company)) {
      console.log(`  [bossScraper] 首次提取为空，等待2秒重试..`);
      await sleep(2000);
      detail = await page.evaluate(EVAL_SCRIPT).catch(() => null);
      if (!detail || (!detail.title && !detail.company)) {
        console.log(`  [bossScraper] 重试后仍为空，返回null`);
        try { await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {}); } catch {}
        return null;
      }
    }

    // 4. 处理技术关键词
    const BENEFITS = ["五险一金","补充医疗","餐补","年假","节日福利","股票期权","交通补助","房补","通讯补贴","定期体检","年终奖","绩效","全勤","员工旅游","零食","下午茶","生日","团建","聚餐","补贴","双休","弹性工作"];
    const allTechs = [
      ...new Set([ ...extractTechs((detail.description||"") + " " + (detail.requirements||"")) ]),
    ].filter((t: string) => t.length > 1 && !["台州","周礼"].includes(t) && !BENEFITS.some((b: string) => t.includes(b)));

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

    // 5. 返回列表页
    console.log(`  [bossScraper] 返回列表页`);
    try { await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {}); } catch {}
    await sleep(1500);

    return result;
  } catch (e: any) {
    console.error(`  [bossScraper] getDetail 异常: ${e.message?.slice(0, 60)}`);
    try { await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {}); } catch {}
    return null;
  }
};
