// content.js —— 严格只读：只读取 BOSS 页面可见文本，绝不写 DOM、不注入元素、不点击。
// 关键教训（2026-09-25 真机验收）：聊天页用 [class*="chat"] 会命中左侧联系人列表容器
// （.chat-list / .chat-container），把整列 HR 摘要 + 别家职位薪资读进来，导致
// needManual 误触发、含金量卡到处抽成同一个 19K。必须按页面类型精准取"当前区域"。
(() => {
  // 幂等守卫：panel 侧栏自愈时可能就地再注入一次，避免重复挂 onMessage 监听
  if (globalThis.__jobAssistantContentLoaded) return;
  globalThis.__jobAssistantContentLoaded = true;

  const MAX = 4000;

  function clean(s) {
    // 保留换行：服务端 tailOfPageText / extractSalaryFromText 都按行做窗口切分，
    // 若把 \n 压成空格，职位卡各行会糊成一整行，锚点窗口与碎片过滤全部失效。
    return (s || "")
      .replace(/[ \t\r\f\v\u00a0\u3000]+/g, " ")
      .replace(/ ?\n ?/g, "\n")
      .replace(/\n{2,}/g, "\n")
      .trim();
  }

  function visible(el) {
    return !!(el && el.getClientRects && el.getClientRects().length);
  }

  // 依次尝试选择器，返回第一个"可见且有足量文本"的节点
  function pick(selectors, minLen = 8) {
    for (const sel of selectors) {
      try {
        const nodes = document.querySelectorAll(sel);
        for (const n of nodes) {
          if (!visible(n)) continue;
          const t = clean(n.innerText);
          if (t.length >= minLen) return n;
        }
      } catch (e) { /* 选择器语法失败就跳过 */ }
    }
    return null;
  }

  function readPageText() {
    const url = location.href;

    // —— 聊天页：只读"当前会话"面板（顶部职位卡 + 消息流），绝不碰左侧联系人列表 ——
    if (/geek\/chat|\/chat\b|jobChat/.test(url)) {
      const conv = pick([
        ".chat-conversation", // 当前会话容器（含职位卡头 + 消息）
        ".chat-record",
        ".chat-message",
        "[class*='conversation']:not([class*='list']):not([class*='container'])",
      ]);
      // 找不到当前会话面板 → 返回空，宁缺毋滥（回退 body 会混入左侧列表）
      return conv ? clean(conv.innerText).slice(0, MAX) : "";
    }

    // —— 职位详情页：读职位主体（标题/薪资/描述），跳过导航与"公司其他职位"侧栏 ——
    if (/job_detail|\/job\/|jobid/i.test(url)) {
      const head = pick([
        ".info-primary",
        ".job-banner",
        "[class*='job-primary']",
        "[class*='job-header']",
        ".name-salary",
      ]);
      const body = pick([
        ".job-sec-text",
        ".job-detail-section",
        "[class*='job-desc']",
        "#job-detail .job-sec-text",
      ]);
      const parts = [head && clean(head.innerText), body && clean(body.innerText)].filter(Boolean);
      if (parts.length) return parts.join(" ").slice(0, MAX);
      // 详情页兜底用整页可接受（该页只呈现一个职位主体）
      return clean(document.body && document.body.innerText).slice(0, MAX);
    }

    // —— 其它 zhipin 页面：整页兜底 ——
    return clean(document.body && document.body.innerText).slice(0, MAX);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "READ_PAGE") {
      sendResponse({ ok: true, pageText: readPageText(), href: location.href });
    }
    // 同步回复，无需 return true
  });
})();
