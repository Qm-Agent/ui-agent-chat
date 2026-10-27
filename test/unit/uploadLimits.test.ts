import assert from "node:assert/strict";
import test from "node:test";
import { resolveSessionUploadLimits } from "../../server/src/uploadLimits.js";

test("session uploads use bounded defaults", () => {
  assert.deepEqual(resolveSessionUploadLimits({}), {
    files: 10,
    fileSize: 25 * 1024 * 1024,
    fields: 24,
    fieldSize: 2 * 1024 * 1024
  });
});

test("session upload limits accept deployment overrides", () => {
  assert.deepEqual(resolveSessionUploadLimits({
    UI_AGENT_UPLOAD_MAX_FILES: "6",
    UI_AGENT_UPLOAD_MAX_FILE_MB: "40",
    UI_AGENT_UPLOAD_MAX_FIELD_MB: "3"
  }), {
    files: 6,
    fileSize: 40 * 1024 * 1024,
    fields: 24,
    fieldSize: 3 * 1024 * 1024
  });
});

test("session upload limits clamp invalid or unbounded configuration", () => {
  const limits = resolveSessionUploadLimits({
    UI_AGENT_UPLOAD_MAX_FILES: "9999",
    UI_AGENT_UPLOAD_MAX_FILE_MB: "0",
    UI_AGENT_UPLOAD_MAX_FIELD_MB: "not-a-number"
  });
  assert.equal(limits.files, 50);
  assert.equal(limits.fileSize, 1024 * 1024);
  assert.equal(limits.fieldSize, 2 * 1024 * 1024);
});
