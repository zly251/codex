import fs from "fs";

const filePath = "E:\\autonomous-job-agent\\src\\scrapers\\bossScraper.ts";
let content = fs.readFileSync(filePath, "utf-8");

// ── Edit A: add response interceptor in attachPageLifecycleLogging ──
const oldA = `    p.on("domcontentloaded", () => {
      console.log(\`  [bossScraper] [evt] domcontentloaded fired\`);
    });
  } catch {}`;

const newA = `    p.on("domcontentloaded", () => {
      console.log(\`  [bossScraper] [evt] domcontentloaded fired\`);
    });
    // 监听所有 job_detail 相关 response（重定向诊断）
    p.on("response", (resp: any) => {
      const rUrl = resp.url?.() || "";
      if (rUrl.includes("zhipin.com") && rUrl.includes("job_detail")) {
        const rStatus = resp.status?.() ?? -1;
        const rLocation = resp.headers?.()?.["location"] || resp.headers?.()?.["Location"] || "";
        console.log(\`  [bossScraper] [resp] \${rStatus} → \${rUrl.slice(0,80)}\`);
        if (rLocation) console.log(\`  [bossScraper] [resp]   location: \${rLocation}\`);
      }
    });
  } catch {}`;

if (!content.includes(oldA)) {
  console.error("❌ Edit A marker not found");
  process.exit(1);
}
content = content.replace(oldA, newA);
console.log("✅ Edit A applied (response interceptor)");

// ── Edit B: capture goto response ──
const oldB = `    console.log(\`  [bossScraper] [NAV] target=\${targetUrl.slice(0,60)}\`);
    await dp.goto(targetUrl, { waitUntil: "networkidle0", timeout: 30000 });
    console.log(\`  [bossScraper] [NAV] goto done, 等待内容稳定...\`);
    console.log(\`  [bossScraper] [NAV] url after goto: \${dp.url()}\`);`;

const newB = `    console.log(\`  [bossScraper] [NAV] target=\${targetUrl.slice(0,60)}\`);
    const gotoResp = await dp.goto(targetUrl, { waitUntil: "networkidle0", timeout: 30000 });
    const respStatus = gotoResp?.status?.() ?? -1;
    const respUrl = gotoResp?.url?.() ?? "?";
    console.log(\`  [bossScraper] [NAV] goto done, response: \${respStatus} \${respUrl.slice(0,80)}\`);
    console.log(\`  [bossScraper] [NAV] url after goto: \${dp.url()}\`);`;

if (!content.includes(oldB)) {
  console.error("❌ Edit B marker not found");
  process.exit(1);
}
content = content.replace(oldB, newB);
console.log("✅ Edit B applied (goto response capture)");

fs.writeFileSync(filePath, content, "utf-8");
console.log("✅ All done");
