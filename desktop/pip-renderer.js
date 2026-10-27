const api = window.uiwardenPictureInPicture;
const title = document.querySelector("[data-role='title']");
const subtitle = document.querySelector("[data-role='subtitle']");
const status = document.querySelector("[data-role='status']");
const image = document.querySelector("[data-role='snapshot']");
const empty = document.querySelector("[data-role='empty']");
const surface = document.querySelector("[data-role='surface']");
const live = document.querySelector("[data-role='live']");
const interactionButton = document.querySelector("[data-action='interaction']");
let currentState = {};
let nativeFrameReceived = false;
let pendingImageSource = "";

function applyState(state) {
  const sourceChanged = currentState.source && currentState.source !== state.source;
  const targetChanged = JSON.stringify(currentState.nativeTarget || null)
    !== JSON.stringify(state.nativeTarget || null);
  currentState = state;
  if (sourceChanged || targetChanged) {
    nativeFrameReceived = false;
    pendingImageSource = "";
    image.removeAttribute("src");
    image.hidden = true;
  }
  title.textContent = state.title || "UI 操作";
  subtitle.textContent = state.streamError
    ? "实时画面暂不可用"
    : state.subtitle || "等待执行画面";
  status.textContent = statusLabel(state.status);
  status.dataset.status = state.status || "idle";
  surface.dataset.source = state.source || "snapshot";
  surface.dataset.interaction = state.interactionEnabled ? "enabled" : "disabled";
  interactionButton.hidden = state.source !== "native-stream" || !state.interactive;
  interactionButton.dataset.active = state.interactionEnabled ? "true" : "false";
  interactionButton.title = state.interactionEnabled ? "退出画中画交互" : "操作画中画";
  interactionButton.setAttribute("aria-pressed", state.interactionEnabled ? "true" : "false");
  live.hidden = state.source !== "native-stream";
  live.dataset.status = state.streamStatus || "idle";
  live.textContent = state.streamStatus === "live"
    ? `${Math.max(1, Number(state.streamConfiguredFps || state.streamFps || 0))} FPS`
    : streamStatusLabel(state.streamStatus);

  if (state.source === "snapshot" && state.snapshotUrl) {
    showImage(state.snapshotUrl);
  } else if (state.source === "native-stream") {
    if (!nativeFrameReceived && state.snapshotUrl) showImage(state.snapshotUrl);
    if (image.hidden) showEmpty(emptyMessage(state));
  } else {
    image.removeAttribute("src");
    image.hidden = true;
    if (state.source === "embedded-browser") {
      empty.hidden = true;
    } else {
      showEmpty(emptyMessage(state));
    }
  }
}

function showImage(source) {
  if (!source) {
    image.removeAttribute("src");
    image.hidden = true;
    showEmpty(emptyMessage(currentState));
    return;
  }
  if (image.getAttribute("src") === source && image.complete && image.naturalWidth > 0) {
    image.hidden = false;
    empty.hidden = true;
    return;
  }
  pendingImageSource = source;
  image.hidden = true;
  showEmpty(currentState.source === "native-stream" ? "正在连接目标应用窗口" : "正在加载执行画面");
  image.src = source;
}

function showEmpty(message) {
  empty.hidden = false;
  empty.textContent = message || "等待执行画面";
}

function emptyMessage(state) {
  return state.placeholder
    || (state.streamError ? "实时画面暂不可用，任务仍在后台执行" : "等待执行画面");
}

function statusLabel(value) {
  if (value === "running") return "执行中";
  if (value === "waiting-approval") return "等待确认";
  if (value === "completed") return "已完成";
  if (value === "failed") return "失败";
  if (value === "aborted") return "已停止";
  return "待机";
}

function streamStatusLabel(value) {
  if (value === "starting") return "连接中";
  if (value === "waiting-target") return "等待窗口";
  if (value === "target-closed") return "窗口已关闭";
  if (value === "failed") return "画面中断";
  return "等待画面";
}

document.querySelector("[data-action='return']").addEventListener("click", () => {
  void api.focusMainWindow();
});
document.querySelector("[data-action='close']").addEventListener("click", () => {
  void api.close();
});
interactionButton.addEventListener("click", async () => {
  interactionButton.disabled = true;
  try {
    await api.setInteractionEnabled(!currentState.interactionEnabled);
  } catch (error) {
    subtitle.textContent = error?.message || "控制权切换失败";
  } finally {
    interactionButton.disabled = false;
  }
});
surface.addEventListener("click", async (event) => {
  if (
    currentState.source !== "native-stream"
    || !currentState.interactionEnabled
    || image.hidden
  ) return;
  const ratios = containedImageRatios(event, image);
  if (!ratios) return;
  surface.dataset.busy = "true";
  try {
    await api.clickNativeSurface(ratios);
  } catch (error) {
    subtitle.textContent = error?.message || "画中画操作失败";
  } finally {
    surface.dataset.busy = "false";
  }
});
image.addEventListener("error", () => {
  pendingImageSource = "";
  image.removeAttribute("src");
  image.hidden = true;
  showEmpty(emptyMessage(currentState));
});
image.addEventListener("load", () => {
  if (!pendingImageSource || image.getAttribute("src") !== pendingImageSource) return;
  pendingImageSource = "";
  image.hidden = false;
  empty.hidden = true;
});

function containedImageRatios(event, element) {
  const rect = element.getBoundingClientRect();
  const naturalWidth = element.naturalWidth;
  const naturalHeight = element.naturalHeight;
  if (!naturalWidth || !naturalHeight || !rect.width || !rect.height) return null;
  const scale = Math.min(rect.width / naturalWidth, rect.height / naturalHeight);
  const contentWidth = naturalWidth * scale;
  const contentHeight = naturalHeight * scale;
  const left = rect.left + (rect.width - contentWidth) / 2;
  const top = rect.top + (rect.height - contentHeight) / 2;
  if (
    event.clientX < left
    || event.clientX > left + contentWidth
    || event.clientY < top
    || event.clientY > top + contentHeight
  ) return null;
  return {
    xRatio: (event.clientX - left) / contentWidth,
    yRatio: (event.clientY - top) / contentHeight,
  };
}

void api.getState().then(applyState);
api.onStateChanged(applyState);
api.onFrame((frame) => {
  if (currentState.source !== "native-stream" || !frame.dataUrl) return;
  nativeFrameReceived = true;
  showImage(frame.dataUrl);
  live.hidden = false;
  live.dataset.status = "live";
  live.textContent = `${Math.max(1, Number(frame.configuredFps || frame.fps || 0))} FPS`;
});
