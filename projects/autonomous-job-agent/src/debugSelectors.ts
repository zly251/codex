// src/debugSelectors.ts
// 字段定位报告 — 针对当前职位详情页，输出每个字段的候选元素

import puppeteer from "puppeteer-core";

async function main() {
  const browser = await puppeteer.connect({
    browserURL: "http://127.0.0.1:9222",
    defaultViewport: null,
  });

  const pages = await browser.pages();
  const page = pages.find(
    (p) => p.url().includes("zhipin") && !p.url().includes("/user/")
  );
  if (!page) { console.log("❌ 未找到 Boss 页面。请打开一个职位详情页。"); return; }

  console.log("URL:", page.url());
  console.log("标题:", await page.title().catch(() => "?"), "\n");

  const report = await page.evaluate(() => {
    const r: any = {};

    // ── 1. title（职位名称） ──
    const titleCandidates = [...document.querySelectorAll(
      ".job-name, [class*=job-name], .job-title, [class*=job-title], " +
      "h1, [class*=name], [class*=position] [class*=title]"
    )].slice(0, 5).map((el) => ({
      sel: (el.className || "").slice(0, 50) || el.tagName,
      text: (el.textContent || "").trim().slice(0, 40),
    }));
    r.title = titleCandidates;

    // ── 2. company（公司名称） ──
    const companyCandidates = [...document.querySelectorAll(
      ".company-info, .company-name, [class*=company-name], " +
      "[class*=company-info], .com-name, [class*=com-name], " +
      ".name, .job-company, [class*=company] a, " +
      "a[href*='/gongsi/'], a[href*='/company/']"
    )].slice(0, 5).map((el) => ({
      sel: (el.className || "").slice(0, 50),
      text: (el.textContent || "").trim().slice(0, 40),
      href: (el as HTMLAnchorElement).href?.slice(0, 60) || "",
    }));
    r.company = companyCandidates;

    // ── 3. salary（薪资） ──
    const salaryCandidates = [...document.querySelectorAll(
      ".job-salary, [class*=salary], .job-price, [class*=price], " +
      "[class*=pay], .text, [class*=money]"
    )].slice(0, 5).map((el) => ({
      sel: (el.className || "").slice(0, 50),
      text: (el.textContent || "").trim().slice(0, 30),
    }));
    r.salary = salaryCandidates;

    // ── 4. city（城市/地点） ──
    const cityCandidates = [...document.querySelectorAll(
      ".job-location, [class*=location], [class*=city], [class*=area], " +
      "[class*=address], [class*=work-city], [class*=workCity], " +
      ".location-address, [class*=location-text]"
    )].slice(0, 5).map((el) => ({
      sel: (el.className || "").slice(0, 50),
      text: (el.textContent || "").trim().slice(0, 50),
    }));
    r.city = cityCandidates;

    // ── 5. education / experience（学历 / 经验标签） ──
    const tagCandidates = [...document.querySelectorAll(
      "[class*=tag], [class*=badge], [class*=label], " +
      "[class*=info] span, [class*=job-banner] span, " +
      ".job-banner span, .job-detail [class*=tag]"
    )].slice(0, 15).map((el) => ({
      parent: (el.parentElement?.className || "").slice(0, 30),
      sel: (el.className || "").slice(0, 40),
      text: (el.textContent || "").trim().slice(0, 20),
    }));
    r.tags = tagCandidates;

    // ── 6. updatedAt（更新时间） ──
    const timeCandidates = [...document.querySelectorAll(
      ".job-time, [class*=time], .update-time, [class*=update], " +
      ".job-update, [class*=publish], [class*=create], " +
      "[class*=active], [class*=online]"
    )].slice(0, 5).map((el) => ({
      sel: (el.className || "").slice(0, 50),
      text: (el.textContent || "").trim().slice(0, 30),
    }));
    r.updatedAt = timeCandidates;

    // ── 7. description（职位描述区域） ──
    const descCandidates = [...document.querySelectorAll(
      ".job-sec, .job-sec-text, [class*=job-sec], [class*=job-detail], " +
      "[class*=detail-content], [class*=job-description], .text, " +
      ".job-banner, [class*=job-banner]"
    )].slice(0, 5).map((el) => {
      const firstChild = (el.children[0] as HTMLElement)?.textContent || "";
      return {
        sel: (el.className || "").slice(0, 50),
        firstChild: firstChild.trim().slice(0, 30),
        textLen: (el.textContent || "").length,
        preview: (el.textContent || "").trim().slice(0, 100),
      };
    });
    r.description = descCandidates;

    // ── 8. requirements（任职要求区域） ──
    const reqCandidates = [...document.querySelectorAll(
      ".job-sec, [class*=job-sec]"
    )].slice(0, 5).map((el) => ({
      sel: (el.className || "").slice(0, 50),
      header: (el.querySelector("h3, h4, .title, [class*=title]")?.textContent || "").trim().slice(0, 20),
      text: (el.textContent || "").trim().slice(0, 80),
    }));
    r.requirements = reqCandidates;

    // ── 9. infoTags（技能标签） ──
    const skillCandidates = [...document.querySelectorAll(
      "[class*=tag], [class*=skill], [class*=label]"
    )].slice(0, 15).map((el) => {
      const parent = el.closest("[class*=job], [class*=detail], [class*=banner]");
      return {
        parentClass: parent?.className?.slice?.(0, 40) || "none",
        sel: (el.className || "").slice(0, 40),
        text: (el.textContent || "").trim().slice(0, 25),
      };
    });
    r.skills = skillCandidates;

    return r;
  });

  console.log("=".repeat(70));
  console.log("  字段定位报告");
  console.log("=".repeat(70));

  console.log("\n--- 1. title（职位名称） ---");
  report.title.forEach((c: any) => console.log(`  [${c.sel}] "${c.text}"`));

  console.log("\n--- 2. company（公司名称） ---");
  report.company.forEach((c: any) => {
    console.log(`  [${c.sel}] "${c.text}"${c.href ? " → " + c.href : ""}`);
  });

  console.log("\n--- 3. salary（薪资） ---");
  report.salary.forEach((c: any) => console.log(`  [${c.sel}] "${c.text}"`));

  console.log("\n--- 4. city（城市/地点） ---");
  report.city.forEach((c: any) => console.log(`  [${c.sel}] "${c.text}"`));

  console.log("\n--- 5. education / experience（标签区） ---");
  report.tags.forEach((t: any) => console.log(`  parent:[${t.parent}] [${t.sel}] "${t.text}"`));

  console.log("\n--- 6. updatedAt（更新时间） ---");
  report.updatedAt.forEach((c: any) => console.log(`  [${c.sel}] "${c.text}"`));

  console.log("\n--- 7. description（描述区域） ---");
  report.description.forEach((d: any) => {
    if (d.textLen > 10) {
      console.log(`  [${d.sel}] 标题:"${d.firstChild}" 长度:${d.textLen}`);
      console.log(`     ${d.preview.slice(0, 80)}`);
    }
  });

  console.log("\n--- 8. requirements（任职要求） ---");
  report.requirements.forEach((r: any) => {
    if (r.text.length > 10) {
      console.log(`  [${r.sel}] 标题:"${r.header}"`);
      console.log(`     ${r.text.slice(0, 80)}`);
    }
  });

  console.log("\n--- 9. infoTags（技能标签） ---");
  report.skills.forEach((s: any) => {
    if (s.text.length > 0) {
      console.log(`  parent:[${s.parentClass}] [${s.sel}] "${s.text}"`);
    }
  });

  await browser.disconnect();
}

main().catch(console.error);
