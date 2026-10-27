import assert from "node:assert/strict";
import test from "node:test";
import { isHtmlPreviewPath, untrustedPreviewHeaders } from "../../server/src/previewSecurity.js";

test("HTML artifacts are recognized case-insensitively", () => {
  assert.equal(isHtmlPreviewPath("report.html"), true);
  assert.equal(isHtmlPreviewPath("REPORT.HTM"), true);
  assert.equal(isHtmlPreviewPath("report.html.txt"), false);
});

test("untrusted HTML previews are sandboxed without script or same-origin grants", () => {
  const headers = untrustedPreviewHeaders(true);
  assert.match(headers["Content-Security-Policy"], /^sandbox;/);
  assert.doesNotMatch(headers["Content-Security-Policy"], /allow-scripts|allow-same-origin/);
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.equal(headers["Referrer-Policy"], "no-referrer");
});

test("binary previews receive anti-sniff headers without an HTML CSP", () => {
  const headers = untrustedPreviewHeaders(false);
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.equal(headers["Content-Security-Policy"], undefined);
});
