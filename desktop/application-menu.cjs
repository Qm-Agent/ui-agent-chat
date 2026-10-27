function buildApplicationMenuTemplate(options = {}) {
  const appName = options.appName || "UIWarden";
  const isMac = options.isMac ?? process.platform === "darwin";
  const showMainWindow = options.showMainWindow || (() => undefined);
  const reloadMainWindow = options.reloadMainWindow || (() => undefined);
  const forceReloadMainWindow = options.forceReloadMainWindow || (() => undefined);
  const toggleMainDevTools = options.toggleMainDevTools || (() => undefined);

  return [
    ...(isMac ? [{
      label: appName,
      submenu: [
        { role: "about", label: `关于 ${appName}` },
        { type: "separator" },
        { label: `显示 ${appName}`, accelerator: "CmdOrCtrl+1", click: showMainWindow },
        { type: "separator" },
        { role: "services", label: "服务" },
        { type: "separator" },
        { role: "hide", label: `隐藏 ${appName}` },
        { role: "hideOthers", label: "隐藏其他应用" },
        { role: "unhide", label: "全部显示" },
        { type: "separator" },
        { role: "quit", label: `退出 ${appName}` },
      ],
    }] : []),
    {
      label: "文件",
      submenu: [
        { label: "显示主窗口", accelerator: "CmdOrCtrl+1", click: showMainWindow },
        { type: "separator" },
        isMac
          ? { role: "close", label: "关闭窗口" }
          : { role: "quit", label: "退出" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "pasteAndMatchStyle", label: "粘贴并匹配样式" },
        { role: "delete", label: "删除" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "显示",
      submenu: [
        { label: "重新加载", accelerator: "CmdOrCtrl+R", click: reloadMainWindow },
        { label: "强制重新加载", accelerator: "CmdOrCtrl+Shift+R", click: forceReloadMainWindow },
        { label: "开发者工具", accelerator: isMac ? "Alt+Command+I" : "Ctrl+Shift+I", click: toggleMainDevTools },
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { type: "separator" },
        { role: "togglefullscreen", label: "切换全屏" },
      ],
    },
    {
      label: "窗口",
      submenu: [
        { role: "minimize", label: "最小化" },
        { role: "zoom", label: "缩放" },
        ...(isMac
          ? [
              { type: "separator" },
              { role: "front", label: "前置全部窗口" },
            ]
          : []),
      ],
    },
  ];
}

module.exports = { buildApplicationMenuTemplate };
