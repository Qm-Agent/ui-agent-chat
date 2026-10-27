import assert from "node:assert/strict";
import test from "node:test";
import { webUiOperationTargetError } from "../../server/src/runtimeMode.js";

test("Web UI operation capabilities allow managed browser and mock provider", () => {
  assert.equal(webUiOperationTargetError({ kind: "browser", browserKernel: "playwright" }), undefined);
  assert.equal(webUiOperationTargetError({ kind: "browser", browserKernel: "uiwarden-embedded" }), undefined);
  assert.equal(webUiOperationTargetError({ kind: "native-app", providerId: "mock" }), undefined);
});

test("Web UI operation capabilities reject local desktop targets", () => {
  assert.match(
    webUiOperationTargetError({ kind: "browser", browserKernel: "external-cdp" }) || "",
    /Web 部署只支持/
  );
  assert.match(
    webUiOperationTargetError({ kind: "native-app", providerId: "macos-accessibility" }) || "",
    /UIWarden 客户端/
  );
});
