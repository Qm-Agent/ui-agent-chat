import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("Docker Runtime 保留 dt-gui-computer 的 ESM 包元数据", () => {
  const dockerfile = fs.readFileSync(path.join(projectRoot, "Dockerfile"), "utf8");
  const runtimePackage = JSON.parse(
    fs.readFileSync(path.join(projectRoot, "native-automation", "package.json"), "utf8")
  ) as { type?: string; engines?: { node?: string } };

  assert.equal(runtimePackage.type, "module");
  assert.equal(runtimePackage.engines?.node, ">=18");
  assert.match(
    dockerfile,
    /COPY --from=builder \/app\/native-automation \/opt\/native-automation/
  );
});

test("Docker builder 支持原生 Node 模块回退源码编译", () => {
  const dockerfile = fs.readFileSync(path.join(projectRoot, "Dockerfile"), "utf8");

  assert.match(
    dockerfile,
    /FROM \$\{NODE_BASE_IMAGE\} AS builder[\s\S]*?apt-get install -y --no-install-recommends \\\n+\s+python3 make g\+\+/
  );
});

test("Docker browser Runtime 与生产 node_modules 位于同一模块解析树", () => {
  const dockerfile = fs.readFileSync(path.join(projectRoot, "Dockerfile"), "utf8");

  assert.match(
    dockerfile,
    /DT_GUI_BROWSER_BIN=\/app\/browser-automation\/bin\/dt-gui-browser/
  );
  assert.match(
    dockerfile,
    /COPY --from=builder \/app\/browser-automation \.\/browser-automation/
  );
  assert.doesNotMatch(dockerfile, /\/opt\/browser-automation/);
});
