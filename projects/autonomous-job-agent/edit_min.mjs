import fs from "fs";

const filePath = "E:\\autonomous-job-agent\\src\\scrapers\\bossScraper.ts";
let content = fs.readFileSync(filePath, "utf-8");

const oldFunc = `function attachPageLifecycleLogging(p: any): void {
  const tag = \`page-\${Date.now()}\`;
  if (p.__lifecycleLogged) return;
  p.__lifecycleLogged = true;
  try {
    p.on("framenavigated", (f: any) => {
      const u = f?.url?.()?.slice(0, 80) || "?";
      const isMain = f.isMainFrame?.() ?? "?";
      console.log(\`  [bossScraper] [evt] framenavigated \${isMain ? "MAIN" : "SUB"} → \${u}\`);
    });
    p.on("load", () => {
      console.log(\`  [bossScraper] [evt] load fired\`);
    });
    p.on("domcontentloaded", () => {
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
    // 🔬 验证 JS 是否主动跳转
    p.on("dialog", (d: any) => {
      console.log(\`  [bossScraper] [dialog] \${d.message?.()?.slice(0,200) || "?"}\`);
      try { d.dismiss(); } catch {}
    });
    p.on("pageerror", (err: any) => {
      console.log(\`  [bossScraper] [pageerror] \${err?.message?.slice(0,200) || err?.toString?.()?.slice(0,200) || "?"}\`);
    });
    p.on("console", (msg: any) => {
      const txt = msg.text?.()?.slice(0,300) || "";
      // 只记录有意义的信息（过滤心跳/探针类 log）
      if (txt.includes("error") || txt.includes("Error") || txt.includes("ERR") || txt.includes("blank") || txt.includes("redirect") || txt.includes("location") || txt.includes("security") || txt.includes("验证")) {
        console.log(\`  [bossScraper] [console] \${txt}\`);
      }
    });
  } catch {}
}`;

const newFunc = `function attachPageLifecycleLogging(p: any): void {
  if (p.__lifecycleLogged) return;
  p.__lifecycleLogged = true;
  try {
    p.on("framenavigated", (f: any) => {
      console.log(\`  [bossScraper] [\${Date.now()}] framenavigated \${f.isMainFrame?.() ? "MAIN" : "SUB"} → \${f?.url?.()?.slice(0,100) || "?"}\`);
    });
    p.on("pageerror", (err: any) => {
      console.log(\`  [bossScraper] [\${Date.now()}] pageerror → \${err?.message?.slice(0,300) || err?.toString?.()?.slice(0,300) || "?"}\`);
    });
    p.on("console", (msg: any) => {
      console.log(\`  [bossScraper] [\${Date.now()}] console → \${msg.text?.()?.slice(0,300) || "?"}\`);
    });
  } catch {}
}`;

if (!content.includes(oldFunc)) {
  console.error("❌ Marker not found");
  process.exit(1);
}

content = content.replace(oldFunc, newFunc);
fs.writeFileSync(filePath, content, "utf-8");
console.log("✅ attachPageLifecycleLogging replaced with minimal timestamped version");
