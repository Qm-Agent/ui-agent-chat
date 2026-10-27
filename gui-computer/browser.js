const api = window.guiComputer;
const tabsNode = document.querySelector("#tabs");
const addressNode = document.querySelector("#address");
const slotNode = document.querySelector("#browser-slot");
const controlNode = document.querySelector("#control-state");
const backNode = document.querySelector("#back");
const forwardNode = document.querySelector("#forward");
const findForm = document.querySelector("#find-form");
const findInput = document.querySelector("#find-input");
const downloadCount = document.querySelector("#download-count");
const zoomReset = document.querySelector("#zoom-reset");
const newTabButton = document.querySelector("#new-tab");
const newWindowButton = document.querySelector("#new-window");
const allTabsButton = document.querySelector("#all-tabs");
const tabCount = document.querySelector("#tab-count");
const bookmarkToggle = document.querySelector("#bookmark-toggle");
const libraryPanel = document.querySelector("#library-panel");
const libraryList = document.querySelector("#library-list");
const bookmarksTab = document.querySelector("#bookmarks-tab");
const historyTab = document.querySelector("#history-tab");
const tabsTab = document.querySelector("#tabs-tab");
const clearHistory = document.querySelector("#clear-history");
let state = null;
let libraryMode = "bookmarks";
let previousActiveTabId = null;

function syncBounds() {
  const rect = slotNode.getBoundingClientRect();
  void api.setBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
}

function render(next) {
  state = next;
  tabsNode.replaceChildren();
  for (const tab of next.tabs || []) {
    const item = document.createElement("div");
    item.dataset.tabId = tab.id;
    item.className = `tab${tab.id === next.activeTabId ? " active" : ""}${tab.targetId === next.controlledTargetId ? " controlled" : ""}`;
    item.title = `${tab.title || tab.url}${tab.targetId === next.controlledTargetId ? "（当前任务受控标签页）" : ""}`;
    item.addEventListener("click", () => void api.activateTab(tab.id).catch(showBrowserError));
    if (tab.loading) {
      const loading = document.createElement("span");
      loading.className = "tab-loading";
      item.append(loading);
    }
    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = tab.crashed ? "页面已崩溃" : (tab.title || "新标签页");
    item.append(title);
    const close = document.createElement("button");
    close.className = "tab-close";
    close.type = "button";
    close.title = "关闭标签页";
    close.textContent = "×";
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      void api.closeTab(tab.id).catch(showBrowserError);
    });
    item.append(close);
    tabsNode.append(item);
  }
  tabsNode.classList.toggle("many", (next.tabs?.length || 0) > 7);
  tabCount.textContent = String(next.tabs?.length || 0);
  const active = next.tabs?.find((tab) => tab.id === next.activeTabId);
  if (document.activeElement !== addressNode) addressNode.value = active?.url || "";
  backNode.disabled = !active?.canGoBack;
  forwardNode.disabled = !active?.canGoForward;
  const activeDownloads = (next.downloads || []).filter((item) => item.status === "progressing").length;
  downloadCount.textContent = activeDownloads ? String(activeDownloads) : "";
  zoomReset.textContent = `${Math.round((next.zoomFactor || 1) * 100)}%`;
  bookmarkToggle.textContent = next.activeBookmarked ? "★" : "☆";
  bookmarkToggle.title = next.activeBookmarked ? "移除书签" : "添加书签";
  const labels = { idle: "可用", "agent-control": "Agent 控制", "human-control": "人工控制" };
  controlNode.textContent = labels[next.controlMode] || "可用";
  controlNode.className = `control-state ${next.controlMode === "agent-control" ? "agent" : next.controlMode === "human-control" ? "human" : ""}`;
  controlNode.disabled = next.controlMode === "idle";
  controlNode.title = next.controlMode === "agent-control" ? "接管浏览器" : next.controlMode === "human-control" ? "继续 Agent" : "当前没有执行任务";
  renderLibrary();
  if (previousActiveTabId !== next.activeTabId) {
    previousActiveTabId = next.activeTabId;
    requestAnimationFrame(() => {
      tabsNode.querySelector(`[data-tab-id="${CSS.escape(next.activeTabId || "")}"]`)
        ?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    });
  }
  requestAnimationFrame(syncBounds);
}

function showBrowserError(error) {
  controlNode.textContent = "操作受限";
  controlNode.title = String(error?.message || error);
  window.setTimeout(() => state && render(state), 2200);
}

function renderLibrary() {
  libraryList.replaceChildren();
  bookmarksTab.classList.toggle("active", libraryMode === "bookmarks");
  historyTab.classList.toggle("active", libraryMode === "history");
  tabsTab.classList.toggle("active", libraryMode === "tabs");
  clearHistory.hidden = libraryMode !== "history";
  const entries = state?.[libraryMode] || [];
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "library-empty";
    empty.textContent = libraryMode === "bookmarks" ? "暂无书签" : libraryMode === "history" ? "暂无历史记录" : "暂无标签页";
    libraryList.append(empty);
    return;
  }
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "library-entry";
    row.addEventListener("click", () => {
      if (libraryMode === "tabs") void api.activateTab(entry.id).catch(showBrowserError);
      else void api.navigate(entry.url).catch(showBrowserError);
      closeLibrary();
    });
    const main = document.createElement("div");
    main.className = "library-entry-main";
    const title = document.createElement("span");
    title.className = "library-entry-title";
    title.textContent = entry.title || entry.url;
    const url = document.createElement("span");
    url.className = "library-entry-url";
    url.textContent = entry.url;
    main.append(title, url);
    row.append(main);
    if (libraryMode === "bookmarks" || libraryMode === "tabs") {
      const remove = document.createElement("button");
      remove.className = "library-entry-remove";
      remove.type = "button";
      remove.title = libraryMode === "tabs" ? "关闭标签页" : "移除书签";
      remove.textContent = "×";
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        if (libraryMode === "tabs") void api.closeTab(entry.id).catch(showBrowserError);
        else void api.removeBookmark(entry.id).catch(showBrowserError);
      });
      row.append(remove);
    }
    libraryList.append(row);
  }
}

function openLibrary(mode = libraryMode) {
  libraryMode = mode;
  libraryPanel.hidden = false;
  document.body.classList.add("library-open");
  renderLibrary();
  void api.getState().then(render).catch(showBrowserError);
  requestAnimationFrame(syncBounds);
}

function closeLibrary() {
  libraryPanel.hidden = true;
  document.body.classList.remove("library-open");
  requestAnimationFrame(syncBounds);
}

newTabButton.addEventListener("click", () => void api.createTab("about:blank").catch(showBrowserError));
newWindowButton.addEventListener("click", () => void api.newWindow().catch(showBrowserError));
allTabsButton.addEventListener("click", () => openLibrary("tabs"));
tabsNode.addEventListener("wheel", (event) => {
  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
  event.preventDefault();
  tabsNode.scrollLeft += event.deltaY;
}, { passive: false });
document.querySelector("#back").addEventListener("click", () => void api.command("back"));
document.querySelector("#forward").addEventListener("click", () => void api.command("forward"));
document.querySelector("#reload").addEventListener("click", () => void api.command("reload"));
document.querySelector("#downloads").addEventListener("click", () => void api.openDownloads());
bookmarkToggle.addEventListener("click", () => void api.toggleBookmark());
document.querySelector("#library-toggle").addEventListener("click", () => libraryPanel.hidden ? openLibrary() : closeLibrary());
bookmarksTab.addEventListener("click", () => openLibrary("bookmarks"));
historyTab.addEventListener("click", () => openLibrary("history"));
tabsTab.addEventListener("click", () => openLibrary("tabs"));
clearHistory.addEventListener("click", () => void api.clearHistory());
document.querySelector("#library-close").addEventListener("click", closeLibrary);
document.querySelector("#clear-cookies").addEventListener("click", () => void api.clearCookies());
document.querySelector("#zoom-out").addEventListener("click", () => void api.setZoomFactor((state?.zoomFactor || 1) - 0.1));
zoomReset.addEventListener("click", () => void api.setZoomFactor(1));
document.querySelector("#zoom-in").addEventListener("click", () => void api.setZoomFactor((state?.zoomFactor || 1) + 0.1));
document.querySelector("#devtools").addEventListener("click", () => void api.openDevTools());
document.querySelector("#find-toggle").addEventListener("click", () => {
  findForm.hidden = !findForm.hidden;
  if (!findForm.hidden) findInput.focus();
  else void api.stopFind();
});
document.querySelector("#find-previous").addEventListener("click", () => void api.find(findInput.value, false));
document.querySelector("#find-close").addEventListener("click", () => {
  findForm.hidden = true;
  void api.stopFind();
});
findForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void api.find(findInput.value, true);
});
controlNode.addEventListener("click", () => {
  if (!state || state.controlMode === "idle") return;
  void api.setControlMode(state.controlMode === "agent-control" ? "human-control" : "agent-control");
});
document.querySelector("#address-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void api.navigate(addressNode.value);
  addressNode.blur();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "F12") {
    event.preventDefault();
    void api.openDevTools();
    return;
  }
  if (!(event.metaKey || event.ctrlKey)) return;
  if (event.key.toLowerCase() === "t") {
    event.preventDefault();
    void api.createTab("about:blank").catch(showBrowserError);
  } else if (event.key.toLowerCase() === "n") {
    event.preventDefault();
    void api.newWindow().catch(showBrowserError);
  }
});

const resizeObserver = new ResizeObserver(syncBounds);
resizeObserver.observe(slotNode);
api.onResize(syncBounds);
api.onState(render);
api.getState().then(render);
