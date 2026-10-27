import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import staging from "../../../desktop/scripts/stage-package-resources.cjs";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uiwarden-package-resources-"));
  for (const name of staging.RESOURCE_DIRS) {
    const source = name.endsWith("-skill") ? path.join(root, "skills", name) : path.join(root, name);
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "marker.txt"), name);
  }
  return root;
}

test("desktop package reads staged resource directories", () => {
  const config = JSON.parse(fs.readFileSync(path.join(projectRoot, "desktop", "electron-builder.json"), "utf8"));
  const rootPackage = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  const preparePackage = fs.readFileSync(path.join(projectRoot, "desktop", "scripts", "prepare-package.cjs"), "utf8");
  const prepareUiTestRuntime = fs.readFileSync(path.join(projectRoot, "scripts", "prepare-ui-test-runtime.mjs"), "utf8");
  const desktopMain = fs.readFileSync(path.join(projectRoot, "desktop", "main.cjs"), "utf8");
  const signLocalApp = fs.readFileSync(path.join(projectRoot, "desktop", "scripts", "sign-local-app.sh"), "utf8");
  const createDmg = fs.readFileSync(path.join(projectRoot, "desktop", "scripts", "create-local-dmg.sh"), "utf8");
  const verifyDmg = fs.readFileSync(path.join(projectRoot, "desktop", "scripts", "verify-install-dmg.sh"), "utf8");
  for (const name of staging.RESOURCE_DIRS) {
    assert.ok(config.extraResources.some((entry) => entry.from === `runtime/package-resources/${name}` && entry.to === name));
    assert.ok(!config.extraResources.some((entry) => entry.from === `../${name}`));
  }
  assert.ok(config.extraResources.some((entry) => entry.to === "THIRD_PARTY_NOTICES.md"));
  assert.ok(config.extraResources.some((entry) => entry.to === "LICENSE"));
  assert.ok(config.extraResources.some((entry) => entry.to === "LICENSES/browser-use-MIT.txt"));
  assert.ok(config.extraResources.some((entry) => entry.from === "../vendor/browser-use" && entry.to === "vendor/browser-use"));
  assert.ok(config.extraResources.some((entry) => entry.from === "runtime/ui-test-runtime" && entry.to === "ui-test-runtime"));
  assert.ok(config.extraResources.some((entry) => entry.from === "runtime/server-node-modules" && entry.to === "node_modules"));
  assert.ok(!config.extraResources.some((entry) => entry.from === "../node_modules"));
  assert.deepEqual(config.mac.target, ["dir"]);
  assert.equal(config.electronDist, "node_modules/electron/dist");
  assert.match(fs.readFileSync(path.join(projectRoot, "LICENSE"), "utf8"), /Apache License/);
  assert.match(fs.readFileSync(path.join(projectRoot, "LICENSES", "browser-use-MIT.txt"), "utf8"), /MIT License/);
  assert.doesNotMatch(preparePackage, /UIWARDEN_INTERNAL_CFUSE_BUILD|copyFileSync\([^\n]*cfuse|defaultRuntime:\s*["']cfuse["']/i);
  assert.match(preparePackage, /defaultRuntime:\s*["']dtcoder["']/);
  assert.match(preparePackage, /bundledCommercialRuntimes:\s*false/);
  assert.match(preparePackage, /npm["'], \["ls", "--omit=dev", "--all", "--parseable"\]/);
  assert.match(preparePackage, /server-node-modules/);
  assert.match(preparePackage, /browser-use 3\.1\.6 SDK wheel 哈希校验通过/);
  assert.match(preparePackage, /内置 Python、browser-use 与 Playwright Chromium\/Firefox Runtime 自检通过/);
  assert.match(preparePackage, /\.ui-test-runtime-preserved-/);
  assert.match(preparePackage, /fs\.renameSync\(preservedUiTestRuntime, uiTestRuntimeRoot\)/);
  assert.match(prepareUiTestRuntime, /verbatimSymlinks:\s*true/);
  assert.match(desktopMain, /UIWARDEN_BROWSER_USE_WHEEL/);
  assert.match(desktopMain, /UIWARDEN_UI_TEST_RUNTIME/);
  assert.match(desktopMain, /PLAYWRIGHT_BROWSERS_PATH/);
  assert.match(desktopMain, /UI_TEST_ASSISTANT_SKILL_PATH/);
  assert.match(desktopMain, /DT_GUI_COMPUTER_SKILL_PATH/);
  assert.match(desktopMain, /DT_GUI_BROWSER_SKILL_PATH/);
  assert.match(signLocalApp, /codesign --force --deep --sign -/);
  assert.match(signLocalApp, /codesign --verify --deep --strict/);
  assert.match(createDmg, /-size "\$\{DMG_SIZE_KB\}k"/);
  assert.match(createDmg, /-fs HFS\+/);
  assert.match(createDmg, /osascript/);
  assert.match(createDmg, /make new alias file/);
  assert.match(createDmg, /NSWorkspace\.sharedWorkspace\.setIconForFileOptions/);
  assert.match(createDmg, /set current view of targetWindow to icon view/);
  assert.match(createDmg, /set position of item "UIWarden\.app"/);
  assert.match(createDmg, /set position of item "Applications"/);
  assert.match(createDmg, /-format UDZO/);
  assert.match(verifyDmg, /\.DS_Store/);
  assert.match(verifyDmg, /codesign --verify --deep --strict/);
  assert.match(verifyDmg, /browser_use-3\.1\.6-py3-none-any\.whl/);
  assert.match(verifyDmg, /4cf70be8ed5a833b803d8417af5a3185b97accd437122206a82c0cd969452e4b/);
  assert.match(verifyDmg, /ui_test_runtime.*runtime-manifest\.json/);
  assert.match(verifyDmg, /p\.chromium\.launch\(headless=True\)/);
  assert.match(verifyDmg, /p\.firefox\.launch\(headless=True\)/);
  assert.equal(rootPackage.dependencies?.["@anthropic-ai/claude-agent-sdk"], undefined);
  assert.ok(rootPackage.devDependencies?.["@anthropic-ai/claude-agent-sdk"]);
});

test("desktop package staging removes credentials and execution output", () => {
  const root = fixtureRoot();
  try {
    const skill = path.join(root, "skills", "ui-test-assistant-skill");
    fs.mkdirSync(path.join(skill, "config"));
    fs.writeFileSync(path.join(skill, "config", ".env"), "API_KEY=secret\n");
    fs.writeFileSync(path.join(skill, "config", ".env.local"), "API_KEY=secret\n");
    fs.writeFileSync(path.join(skill, "config", ".env.example"), "API_KEY=\n");
    fs.mkdirSync(path.join(skill, "config", "perference_context"));
    fs.writeFileSync(path.join(skill, "config", "perference_context", ".gitkeep"), "");
    fs.writeFileSync(path.join(skill, "config", "perference_context", "private-whitepaper.md"), "private\n");
    fs.mkdirSync(path.join(skill, "config", "prompt_context"));
    fs.writeFileSync(path.join(skill, "config", "prompt_context", ".gitkeep"), "");
    fs.writeFileSync(path.join(skill, "config", "prompt_context", "global_readme.md"), "public\n");
    fs.writeFileSync(path.join(skill, "config", "prompt_context", "private-product.md"), "private\n");
    fs.writeFileSync(path.join(skill, ".DS_Store"), "finder metadata\n");
    fs.writeFileSync(path.join(skill, "debug.log"), "private\n");
    fs.writeFileSync(path.join(skill, "cached.pyc"), "private\n");
    for (const directory of ["logs", ".skill-output", "test-reports"]) {
      fs.mkdirSync(path.join(skill, directory));
      fs.writeFileSync(path.join(skill, directory, "private.txt"), "private\n");
    }
    const output = staging.stagePackageResources(root);
    const staged = path.join(output, "ui-test-assistant-skill");
    assert.equal(fs.readFileSync(path.join(staged, "marker.txt"), "utf8"), "ui-test-assistant-skill");
    assert.ok(fs.existsSync(path.join(staged, "config", ".env.example")));
    assert.ok(fs.existsSync(path.join(staged, "config", "perference_context", ".gitkeep")));
    assert.ok(!fs.existsSync(path.join(staged, "config", "perference_context", "private-whitepaper.md")));
    assert.ok(fs.existsSync(path.join(staged, "config", "prompt_context", "global_readme.md")));
    assert.ok(!fs.existsSync(path.join(staged, "config", "prompt_context", "private-product.md")));
    for (const name of [".env", ".env.local"]) assert.ok(!fs.existsSync(path.join(staged, "config", name)));
    for (const name of [".DS_Store", "debug.log", "cached.pyc"]) assert.ok(!fs.existsSync(path.join(staged, name)));
    for (const name of ["logs", ".skill-output", "test-reports"]) assert.ok(!fs.existsSync(path.join(staged, name)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("desktop package staging rejects populated env examples and symlinks", () => {
  const root = fixtureRoot();
  try {
    const skill = path.join(root, "skills", "ui-test-assistant-skill");
    fs.writeFileSync(path.join(skill, ".env.example"), "ANTHROPIC_API_KEY=secret-fixture\n");
    assert.throws(() => staging.stagePackageResources(root), /populated ANTHROPIC_API_KEY/);
    fs.writeFileSync(path.join(skill, ".env.example"), "ANTHROPIC_API_KEY=\n");
    fs.symlinkSync(path.join(root, "skills", "dt-gui-browser-skill"), path.join(skill, "linked-data"));
    assert.throws(() => staging.stagePackageResources(root), /symlink is not allowed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
