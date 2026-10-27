import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { buildApplicationMenuTemplate } = require("../../desktop/application-menu.cjs") as {
  buildApplicationMenuTemplate(options: Record<string, unknown>): Array<{
    label: string;
    submenu: Array<{ label?: string; role?: string; accelerator?: string }>;
  }>;
};
const { embeddedTabMarkerUrl } = require("../../desktop/embedded-browser-url.cjs") as {
  embeddedTabMarkerUrl(id: string): string;
};

test("macOS 客户端菜单提供标准应用操作和重新加载入口", () => {
  const template = buildApplicationMenuTemplate({ appName: "UIWarden", isMac: true });
  assert.equal(template[0].label, "UIWarden");
  const viewMenu = template.find((item) => item.label === "显示");
  assert.ok(viewMenu);
  assert.equal(viewMenu.submenu.some((item) => item.label === "重新加载" && item.accelerator === "CmdOrCtrl+R"), true);
  assert.equal(viewMenu.submenu.some((item) => item.label === "强制重新加载"), true);
  assert.equal(viewMenu.submenu.some((item) => item.label === "开发者工具"), true);
  assert.equal(viewMenu.submenu.some((item) => item.role === "togglefullscreen"), true);
  const editMenu = template.find((item) => item.label === "编辑");
  assert.equal(editMenu?.submenu.some((item) => item.role === "copy"), true);
  assert.equal(editMenu?.submenu.some((item) => item.role === "paste"), true);
});

test("内置浏览器使用可加载的唯一 data 页面映射 CDP target", () => {
  const marker = embeddedTabMarkerUrl("tab-1");
  assert.match(marker, /^data:text\/html;charset=utf-8,/);
  assert.match(marker, /#uiwarden-tab-tab-1$/);
  assert.doesNotMatch(marker, /^about:blank#/);
  assert.notEqual(marker, embeddedTabMarkerUrl("tab-2"));
});
