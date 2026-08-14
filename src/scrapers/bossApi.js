const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const randSleep = (baseMs, jitterMs) => sleep(baseMs + Math.random() * jitterMs);
import { parseMonthlySalaryK } from "../salary.js";
const API_URLS = ["/search/joblist.json", "/job/detail.json"];
const CITY_CODES = {"北京":"101010100","上海":"101020100","广州":"101280100","深圳":"101280600","杭州":"101210100","成都":"101270100","台州":"101210600","宁波":"101210400","温州":"101210700"};

export class BossApiScraper {
  constructor(bm) { this.manager = bm; this._page = null; this._busy = false; }

  async _getPage() {
    if (this._page && !this._page.isClosed()) { try { await this._page.evaluate("1+1"); return this._page; } catch {} }
    const b = this.manager.browser; if (!b?.connected) throw new Error("未连接");
    this._page = await this.manager.getPage();
    await this._page.setViewport({ width:1400, height:900 });
    return this._page;
  }

  async searchJobs({ keyword="C++", city="", pages:pg=3 }={}) {
    if (this._busy) return []; this._busy = true;
    const page = await this._getPage();
    let raw = [];

    page.on("response", async (resp) => {
      try {
        if (!API_URLS.some(u => resp.url().indexOf(u) >= 0)) return;
        const json = await resp.json();
        const list = json?.zpData?.jobList || [];
        if (list.length) raw = raw.concat(list);
      } catch(e) {}
    });

    try {
      for (let p = 1; p <= pg; p++) {
        const cc = CITY_CODES[city] || "";
        await page.goto("https://www.zhipin.com/web/geek/job?city=" + cc + "&query=" + encodeURIComponent(keyword) + "&page=" + p, { waitUntil:"networkidle2", timeout:30000 }).catch(()=>{});
        await randSleep(3000, 3000);
      }
    } catch(e) {} finally {
      page.removeAllListeners("response"); this._busy = false;
    }

    // DOM extraction fallback when API intercept returns nothing
    if (raw.length === 0) {
      console.log("[bossApi] API intercept empty, trying DOM extraction...");
      try {
        for (let p = 1; p <= pg; p++) {
          const cc = CITY_CODES[city] || "";
          await page.goto("https://www.zhipin.com/web/geek/job?city=" + cc + "&query=" + encodeURIComponent(keyword) + "&page=" + p, { waitUntil:"networkidle2", timeout:30000 }).catch(()=>{});
          await randSleep(3000, 3000);
          const domJobs = await page.evaluate(function() {
            var items = [];
            var cards = document.querySelectorAll(".job-card-box");
            for (var ci = 0; ci < cards.length; ci++) {
              var c = cards[ci];
              var link = c.querySelector("a[href*='/job_detail/']");
              var idMatch = link ? (link.getAttribute("href") || "").match(/\/job_detail\/([^\/.?]+)/) : null;
              if (!idMatch) continue;
              var titleEl = link ? (link.querySelector(".job-name") || link.querySelector("[class*=job-name]")) : null;
              var salaryEl = c.querySelector("[class*=salary]") || c.querySelector(".salary");
              var companyEl = c.querySelector("[class*=company]") || c.querySelector("a[href*='/gongsi/']");
              var cityEl = c.querySelector("[class*=city]") || c.querySelector(".job-area");
              var districtEl = c.querySelector("[class*=district]") || c.querySelector(".job-area");
              var expEl = c.querySelector("[class*=experience]") || c.querySelector(".job-experience");
              var eduEl = c.querySelector("[class*=education]") || c.querySelector(".job-education");
              var skillEl = c.querySelector("[class*=tags]") || c.querySelector(".job-tags");
              var descEl = c.querySelector("[class*=desc]") || c.querySelector(".job-desc");
              items.push({
                encryptJobId: idMatch[1],
                jobName: titleEl ? (titleEl.textContent || "").trim() : (link ? (link.textContent || "").trim() : ""),
                salaryDesc: salaryEl ? (salaryEl.textContent || "").trim() : "",
                cityName: cityEl ? (cityEl.textContent || "").trim() : "",
                areaDistrict: districtEl ? (districtEl.textContent || "").trim() : "",
                jobExperience: expEl ? (expEl.textContent || "").trim() : "",
                jobDegree: eduEl ? (eduEl.textContent || "").trim() : "",
                skills: skillEl ? (skillEl.textContent || "").trim().split(/[,\s]+/).filter(function(s){return s.trim();}) : [],
                jobDetail: descEl ? (descEl.textContent || "").trim() : "",
                brandName: companyEl ? (companyEl.textContent || "").trim() : "",
                brandDistrict: "",
                technologyList: [],
                salary: "",
                jobId: "",
              });
            }
            return items;
          }).catch(function() { return []; });
          if (domJobs.length > 0) { raw = raw.concat(domJobs); }
        }
      } catch(e) {
        console.log("[bossApi] DOM extraction error: " + (e.message || "").slice(0, 80));
      }
    }

    console.log("[bossApi] 原始:" + raw.length);
    return this._parseJobs(raw);
  }

  _parseJobs(items) {
    const seen = new Set();
    const out = [];
    for (const item of items) {
      try {
        const id = item.encryptJobId || item.jobId || "";
        const title = item.jobName || item.name || "";
        if (!title || !id) continue;
        if (seen.has(id)) continue;
        seen.add(id);

        const url = "https://www.zhipin.com/job_detail/" + id + ".html";
        const skillList = item.skills || item.technologyList || [];

        const salaryRaw = item.salaryDesc || item.salary || "";
        const parsedSalary = parseMonthlySalaryK(salaryRaw);
        const salaryMin = parsedSalary && typeof parsedSalary === "object" ? parsedSalary.min : (typeof parsedSalary === "number" ? parsedSalary : null);
        const salaryMax = parsedSalary && typeof parsedSalary === "object" ? parsedSalary.max : (typeof parsedSalary === "number" ? parsedSalary : null);

        out.push({
          title: title,
          salaryMin,
          salaryMax,
          salaryRaw,
          city: item.cityName || "",
          district: item.areaDistrict || item.brandDistrict || "",
          experience: item.jobExperience || "",
          education: item.jobDegree || "",
          technologies: (Array.isArray(skillList) ? skillList : []).join(","),
          url: url,
          description: item.jobDetail || "",
          requirements: item.requirements || item.jobRequirements || "",
          companyName: (item.brandName || "").replace(/<[^>]*>/g,"").trim(),
          companyId: String(item.encryptBrandId || item.brandId || ""),
          source: "zhipin",
          status: "active",
        });
      } catch(e) {}
    }
    console.log("[bossApi] 解析:" + out.length + "/" + items.length);
    return out;
  }

  async saveJobs(jobs, jobDb, companyDb) {
    let saved = 0;
    for (const j of jobs) {
      try {
        if (j.companyId && j.companyName && companyDb) {
          let co = companyDb.findByName(j.companyName);
          if (!co) co = companyDb.create({ name: j.companyName, source:"zhipin" });
          j.companyId = co.id;
        }
        if (jobDb) {
          const e = jobDb.findByUrl(j.url);
          e ? jobDb.update(e.id, j) : jobDb.create(j);
        }
        saved++;
      } catch(e) {}
    }
    return saved;
  }
}
