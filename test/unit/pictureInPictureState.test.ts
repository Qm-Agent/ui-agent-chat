import assert from "node:assert/strict";
import test from "node:test";
import { reconcilePictureInPictureClose } from "../../client/src/pictureInPictureState.js";

test("关闭开关后会清理旧的画中画打开状态", () => {
  assert.deepEqual(
    reconcilePictureInPictureClose({
      enabled: false,
      open: false,
      wasOpen: true,
      closeReason: "user",
    }),
    { nextWasOpen: false, disablePresentation: false }
  );
});

test("重新开启时不会把旧关闭状态误判为用户刚关闭窗口", () => {
  assert.deepEqual(
    reconcilePictureInPictureClose({
      enabled: true,
      open: false,
      wasOpen: false,
      closeReason: "user",
    }),
    { nextWasOpen: false, disablePresentation: false }
  );
});

test("仅在已打开的小窗被用户关闭时回退行内模式", () => {
  assert.deepEqual(
    reconcilePictureInPictureClose({
      enabled: true,
      open: false,
      wasOpen: true,
      closeReason: "user",
    }),
    { nextWasOpen: false, disablePresentation: true }
  );
  assert.deepEqual(
    reconcilePictureInPictureClose({
      enabled: true,
      open: false,
      wasOpen: true,
      closeReason: "renderer-reload",
    }),
    { nextWasOpen: false, disablePresentation: false }
  );
});
