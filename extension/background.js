// service worker：点图标开关侧栏小窗（真机验收后从独立 popup 窗改为 sidePanel——
// popup 窗点回网页会消失/被压到后面，侧栏与页面同生共死，且不再需要 tabs/windows 权限）
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setOptions({ path: "panel.html", enabled: true });
});

chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (e) {
    // 兜底：个别版本 sidePanel.open 需用户手势上下文，失败退回独立窗
    const wins = await chrome.windows.getAll();
    for (const w of wins) {
      const tabs = await chrome.tabs.query({ windowId: w.id });
      const panel = tabs.find((t) => (t.url || "").startsWith(chrome.runtime.getURL("panel.html")));
      if (panel) {
        await chrome.windows.update(w.id, { focused: true });
        return;
      }
    }
    await chrome.windows.create({ url: "panel.html", type: "popup", width: 360, height: 600, focused: true });
  }
});
