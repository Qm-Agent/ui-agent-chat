import assert from "node:assert/strict";
import test from "node:test";
import { resolveHostEntryEnabled } from "../../server/src/configStore.js";

test("new host defaults to enabled", () => {
  assert.equal(resolveHostEntryEnabled(undefined, undefined), true);
});

test("new host preserves an explicit disabled value", () => {
  assert.equal(resolveHostEntryEnabled(false, undefined), false);
});

test("host edit preserves the stored value when enabled is omitted", () => {
  assert.equal(resolveHostEntryEnabled(undefined, 0), false);
  assert.equal(resolveHostEntryEnabled(undefined, 1), true);
});

test("host edit applies an explicit enabled change", () => {
  assert.equal(resolveHostEntryEnabled(false, 1), false);
  assert.equal(resolveHostEntryEnabled(true, 0), true);
});
