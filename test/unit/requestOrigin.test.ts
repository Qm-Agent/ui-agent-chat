import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedRequestOrigin } from "../../server/src/requestOrigin.js";

test("CLI requests without Origin remain available", () => {
  assert.equal(isAllowedRequestOrigin(undefined, "127.0.0.1:8787", []), true);
});

test("same-origin browser requests and explicit trusted origins are accepted", () => {
  assert.equal(isAllowedRequestOrigin("http://127.0.0.1:5174", "127.0.0.1:5174", []), true);
  assert.equal(isAllowedRequestOrigin("https://ui.example", "ui.example:443", []), true);
  assert.equal(isAllowedRequestOrigin("https://ui.example", "127.0.0.1:8787", ["https://ui.example"]), true);
});

test("other websites cannot send requests to a local API", () => {
  assert.equal(isAllowedRequestOrigin("https://other.example", "127.0.0.1:8787", []), false);
  assert.equal(isAllowedRequestOrigin("null", "127.0.0.1:8787", []), false);
  assert.equal(isAllowedRequestOrigin("file://", "127.0.0.1:8787", []), false);
  assert.equal(isAllowedRequestOrigin("https://other.example/path", "other.example", []), false);
});
