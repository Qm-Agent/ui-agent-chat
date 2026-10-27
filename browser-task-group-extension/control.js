function normalizeTitle(value) {
  const title = String(value || "UIWarden Task")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24);
  return title || "UIWarden Task";
}

async function createTaskGroup(input) {
  const markerUrl = String(input?.markerUrl || "");
  if (!markerUrl.startsWith("about:blank#uiwarden-task-")) {
    throw new Error("Invalid UIWarden task marker");
  }
  const tab = await chrome.tabs.create({ url: markerUrl, active: true });
  if (typeof tab.id !== "number") throw new Error("Chromium did not return a tab id");
  const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
  await chrome.tabGroups.update(groupId, {
    title: normalizeTitle(input?.title),
    color: input?.color === "blue" ? "blue" : "red",
    collapsed: false
  });
  return {
    version: 1,
    chromeTabId: tab.id,
    groupId,
    markerUrl
  };
}

Object.defineProperty(globalThis, "uiwardenTaskGroups", {
  configurable: false,
  enumerable: false,
  writable: false,
  value: Object.freeze({
    version: 1,
    capabilities: () => ({ version: 1, tabs: true, tabGroups: true }),
    createTaskGroup
  })
});
