const TAB_MARKER_DOCUMENT = encodeURIComponent("<!doctype html><title>UIWarden</title>");

function embeddedTabMarkerUrl(id) {
  return `data:text/html;charset=utf-8,${TAB_MARKER_DOCUMENT}#uiwarden-tab-${id}`;
}

module.exports = { embeddedTabMarkerUrl };
