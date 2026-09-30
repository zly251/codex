// panel.js —— 小窗逻辑：轮询 + 渲染 + 复制 + 设置
let SERVER_BASE = "http://127.0.0.1:3456"; // 默认值，可被 storage.serverBase 覆盖
let pollIntervalSec = 5;
let commuteMode = "ebyke";
let oneWayKm = 5;
let timer = null;

const $ = (id) => document.getElementById(id);
const setStatus = (text, bad) => {
  const el = $("status");
  el.textContent = text;
  el.classList.toggle("bad", !!bad);
};

// ---------- 设置 ----------
async function loadSettings() {
  const s = await chrome.storage.local.get([
    "serverBase", "pollIntervalSec", "commuteMode", "oneWayKm",
  ]);
  if (s.serverBase) SERVER_BASE = s.serverBase;
  if (s.pollIntervalSec) pollIntervalSec = Number(s.pollIntervalSec) || 5;
  if (s.commuteMode) commuteMode = s.commuteMode;
  if (s.oneWayKm != null) oneWayKm = Number(s.oneWayKm);
  $("set-server").value = SERVER_BASE;
  $("set-interval").value = pollIntervalSec;
  $("set-commute-mode").value = commuteMode;
  $("set-commute-km").value = oneWayKm;
}

$("set-save").addEventListener("click", async () => {
  SERVER_BASE = ($("set-server").value.trim() || "http://127.0.0.1:3456").replace(/\/+$/, "");
  pollIntervalSec = Math.max(2, Number($("set-interval").value) || 5);
  commuteMode = $("set-commute-mode").value;
  oneWayKm = Math.max(0, Number($("set-commute-km").value) || 0);
  await chrome.storage.local.set({
    serverBase: SERVER_BASE,
    pollIntervalSec,
    commuteMode,
    oneWayKm,
  });
  restartTimer();
  setStatus("设置已保存");
  refresh();
});

// ---------- 轮询 ----------
function restartTimer() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    if (document.visibilityState === "visible") refresh();
  }, pollIntervalSec * 1000);
}

// ---------- 读页面 ----------
async function askTab(tab) {
  const resp = await chrome.tabs.sendMessage(tab.id, { type: "READ_PAGE" });
  return resp && resp.ok ? resp : null;
}

async function readZhipinTab() {
  // 侧栏语境：本窗的"活动标签"可能算侧栏自己，所以不筛 active、拿本窗全部标签找 zhipin
  let tabs = await chrome.tabs.query({ currentWindow: true });
  let tab = tabs.find((t) => (t.url || "").includes("zhipin.com"));
  if (!tab) {
    // 兜底：本窗没有（用户开了第二个窗），再全域找第一个 zhipin 标签
    tabs = await chrome.tabs.query({});
    tab = tabs.find((t) => (t.url || "").includes("zhipin.com"));
  }
  if (!tab) return null;
  try {
    return await askTab(tab);
  } catch (e) {
    // content script 未就绪（刚重新加载过扩展 / 页面尚未注入）→ 自愈：就地注入再试一次
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"],
      });
      return await askTab(tab);
    } catch (e2) {
      return null; // 注入也失败（如受限页面），交回上层显示"未找到"
    }
  }
}

// ---------- 渲染 ----------
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function renderSuggestions(list) {
  const box = $("suggestions");
  box.innerHTML = "";
  (list || []).forEach((s) => {
    const card = document.createElement("div");
    card.className = "sug";
    const label = document.createElement("div");
    label.className = "sug-label";
    label.textContent = s.label || "建议";
    const text = document.createElement("div");
    text.className = "sug-text";
    text.textContent = s.text || "";
    const btn = document.createElement("button");
    btn.className = "copy";
    btn.textContent = "复制";
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(s.text || "");
        btn.textContent = "已复制";
        setTimeout(() => { btn.textContent = "复制"; }, 1200);
      } catch (e) {
        btn.textContent = "复制失败";
      }
    });
    card.append(label, text, btn);
    box.appendChild(card);
  });
}

function renderJobBar(title) {
  const bar = $("job-bar");
  if (!title) { bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");
  $("job-name").textContent = title;
}

function renderBreakdown(rows) {
  const box = $("vc-breakdown");
  box.innerHTML = "";
  (rows || []).forEach((r) => {
    const line = document.createElement("div");
    line.className = "bd" + (String(r.label).startsWith("  ") ? " bd-sub" : "");
    const lab = document.createElement("span");
    lab.className = "bd-label";
    lab.textContent = r.label.trim();
    const formula = document.createElement("span");
    formula.className = "bd-formula";
    formula.textContent = r.formula || "";
    const val = document.createElement("span");
    val.className = "bd-value";
    val.textContent = r.value || "";
    line.append(lab, formula, val);
    if (r.note) {
      const note = document.createElement("div");
      note.className = "bd-note";
      note.textContent = r.note;
      line.appendChild(note);
    }
    box.appendChild(line);
  });
}

function renderValue(v) {
  const card = $("value-card");
  if (!v || !v.ok) { card.classList.add("hidden"); return; }
  card.classList.remove("hidden");
  renderBreakdown(v.breakdown);
  const money = (n) => (typeof n === "number" ? n.toFixed(2) : "—");
  // 有薪资区间时，大数字如实显示为区间（职位卡标 6-10K → 到手是区间，非中值假精确）
  const moneyOrRange = (single, range) =>
    Array.isArray(range) && range.length === 2 ? `${money(range[0])} ~ ${money(range[1])}` : money(single);
  const sources = v.sources || {};
  const hasRange = Array.isArray(v.netRange) && v.netRange.length === 2;
  $("vc-net").closest(".vc-num").classList.toggle("range", hasRange);
  $("vc-disposable").closest(".vc-num").classList.toggle("range", Array.isArray(v.disposableRange) && v.disposableRange.length === 2);
  $("vc-net").textContent = moneyOrRange(v.net, v.netRange);
  $("vc-disposable").textContent = moneyOrRange(v.disposable, v.disposableRange);
  $("vc-gross").innerHTML = `${moneyOrRange(v.gross, v.grossRange)}${sources.gross ? ` <small class="src">${esc(sources.gross)}</small>` : ""}`;
  const ins = v.insurance || {};
  $("vc-insurance").innerHTML = `${money(ins.total)}${v.baseSource || sources.insuranceBase ? ` <small class="src">${esc(v.baseSource || sources.insuranceBase)}</small>` : ""}`;
  const items = ins.items || {};
  $("vc-insurance-items").innerHTML =
    [["养老", "pension"], ["医疗", "medical"], ["失业", "unemployment"], ["公积金", "housing"]]
      .filter(([, k]) => items[k] != null)
      .map(([cn, k]) => `<span>${cn} ${money(items[k])}</span>`)
      .join("");
  $("vc-tax").innerHTML = `${money((v.tax || {}).tax)}${sources.taxRate ? ` <small class="src">${esc(sources.taxRate)}</small>` : ""}`;
  const com = v.commute || {};
  $("vc-commute").innerHTML = `${com.modeLabel ? esc(com.modeLabel) + " " : ""}${money(com.monthly)}${com.source ? ` <small class="src">${esc(com.source)}</small>` : ""}`;
}

function showRetry() {
  const box = $("suggestions");
  box.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "err";
  const msg = document.createElement("div");
  msg.textContent = "连接本机 server 失败";
  const btn = document.createElement("button");
  btn.textContent = "重试";
  btn.addEventListener("click", () => refresh());
  wrap.append(msg, btn);
  box.appendChild(wrap);
}

// ---------- 主流程 ----------
let busy = false;
async function refresh() {
  if (busy) return;
  busy = true;
  try {
    const page = await readZhipinTab();
    if (!page) { setStatus("未找到 BOSS 页面"); renderJobBar(null); return; }
    setStatus("读取中…");
    const resp = await fetch(`${SERVER_BASE}/api/extension/look`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pageText: page.pageText || "",
        href: page.href || "",
        commuteMode,
        oneWayKm,
      }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    renderJobBar(data.jobTitle);
    $("manual").classList.toggle("hidden", !data.needManual);
    if (data.needManual) {
      $("manual").textContent = "⚠️ 这类消息建议你亲自回（" + (data.reason || "涉及承诺/合同") + "）";
      $("suggestions").innerHTML = "";
    } else {
      renderSuggestions(data.suggestions);
    }
    renderValue(data.value);
    setStatus(`已更新 ${new Date().toLocaleTimeString()}`);
  } catch (e) {
    setStatus(`失败：${e.message}`, true);
    showRetry();
    renderJobBar(null);
    $("value-card").classList.add("hidden");
  } finally {
    busy = false;
  }
}

// ---------- 启动 ----------
(async () => {
  await loadSettings();
  restartTimer();
  refresh();
})();
