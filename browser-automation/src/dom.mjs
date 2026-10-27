const MARKER_ATTRIBUTE = "data-dt-gui-browser-locator";

export function buildObserveExpression({ markerPrefix, maxElements = 300, maxTextLength = 20_000 }) {
  return `(${observePage.toString()})(${JSON.stringify({
    markerAttribute: MARKER_ATTRIBUTE,
    markerPrefix,
    maxElements,
    maxTextLength
  })})`;
}

export function buildElementActionExpression(input) {
  return `(${performElementAction.toString()})(${JSON.stringify({
    markerAttribute: MARKER_ATTRIBUTE,
    ...input
  })})`;
}

export function buildElementObjectExpression(locatorId) {
  return `(${findMarkedElement.toString()})(${JSON.stringify({
    markerAttribute: MARKER_ATTRIBUTE,
    locatorId
  })})`;
}

export function buildDragPointsExpression(sourceLocatorId, targetLocatorId) {
  return `(${dragPoints.toString()})(${JSON.stringify({
    markerAttribute: MARKER_ATTRIBUTE,
    sourceLocatorId,
    targetLocatorId
  })})`;
}

export function buildDomDragExpression(sourceLocatorId, targetLocatorId) {
  return `(${dispatchDomDrag.toString()})(${JSON.stringify({
    markerAttribute: MARKER_ATTRIBUTE,
    sourceLocatorId,
    targetLocatorId
  })})`;
}

function observePage(args) {
  const interactiveTags = new Set(["a", "button", "input", "select", "textarea", "summary", "details", "option"]);
  const interactiveRoles = new Set([
    "button", "link", "checkbox", "radio", "textbox", "searchbox", "combobox", "listbox",
    "option", "menuitem", "menuitemcheckbox", "menuitemradio", "switch", "slider", "spinbutton", "tab", "treeitem"
  ]);
  const elements = [];
  const gaps = [];
  let index = 0;

  function rootsFrom(root) {
    const roots = [root];
    for (const element of root.querySelectorAll?.("*") || []) {
      if (element.shadowRoot) roots.push(...rootsFrom(element.shadowRoot));
      if (element.tagName?.toLowerCase() === "iframe") {
        try {
          if (element.contentDocument) roots.push(...rootsFrom(element.contentDocument));
          else gaps.push("cross-origin-or-unavailable-iframe");
        } catch {
          gaps.push("cross-origin-iframe");
        }
      }
    }
    return roots;
  }

  function isVisible(element) {
    if (!element || element.nodeType !== 1) return false;
    const style = element.ownerDocument?.defaultView?.getComputedStyle(element);
    if (!style || style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && element.getClientRects().length > 0;
  }

  function globalRect(element) {
    const local = element.getBoundingClientRect();
    let x = local.x;
    let y = local.y;
    let view = element.ownerDocument?.defaultView;
    while (view && view !== view.top) {
      const frame = view.frameElement;
      if (!frame) break;
      const frameRect = frame.getBoundingClientRect();
      x += frameRect.x + Number(frame.clientLeft || 0);
      y += frameRect.y + Number(frame.clientTop || 0);
      view = frame.ownerDocument?.defaultView;
    }
    return { x, y, width: local.width, height: local.height };
  }

  function accessibleName(element) {
    const labelledBy = element.getAttribute("aria-labelledby");
    const labelledText = labelledBy
      ? labelledBy.split(/\s+/).map((id) => element.ownerDocument?.getElementById(id)?.textContent || "").join(" ")
      : "";
    let labelText = "";
    if (element.id) {
      try {
        labelText = element.ownerDocument?.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.textContent || "";
      } catch {
        labelText = "";
      }
    }
    labelText ||= element.closest("label")?.textContent || "";
    const tag = element.tagName.toLowerCase();
    const type = String(element.getAttribute("type") || "").toLowerCase();
    const valueAsName = (tag === "button" || ["button", "submit", "reset"].includes(type))
      ? element.value
      : "";
    return [
      element.getAttribute("aria-label"),
      labelledText,
      labelText,
      element.getAttribute("alt"),
      element.getAttribute("title"),
      element.getAttribute("placeholder"),
      valueAsName,
      element.innerText,
      element.textContent,
      element.getAttribute("name")
    ].map((value) => String(value || "").replace(/\s+/g, " ").trim()).find(Boolean)?.slice(0, 500) || "";
  }

  function isInteractive(element) {
    const tag = element.tagName.toLowerCase();
    const type = String(element.getAttribute("type") || "").toLowerCase();
    if (tag === "input" && type === "hidden") return false;
    const role = String(element.getAttribute("role") || "").toLowerCase();
    const tabIndex = Number(element.getAttribute("tabindex"));
    const cursor = element.ownerDocument?.defaultView?.getComputedStyle(element)?.cursor;
    return interactiveTags.has(tag)
      || interactiveRoles.has(role)
      || element.isContentEditable
      || element.draggable
      || element.hasAttribute("aria-dropeffect")
      || element.hasAttribute("dropzone")
      || typeof element.onclick === "function"
      || (Number.isFinite(tabIndex) && tabIndex >= 0)
      || cursor === "pointer";
  }

  function elementActions(element) {
    const tag = element.tagName.toLowerCase();
    const type = String(element.getAttribute("type") || "").toLowerCase();
    const actions = ["click", "hover"];
    if (tag === "input" || tag === "textarea" || element.isContentEditable) {
      actions.push("set-value", "type-text");
    }
    if (tag === "select") actions.push("select-option");
    if (tag === "input" && type === "file") actions.push("upload-file");
    if (element.draggable) actions.push("drag");
    if (element.hasAttribute("aria-dropeffect") || element.hasAttribute("dropzone")) actions.push("drop");
    if (["checkbox", "radio"].includes(type) && !actions.includes("click")) actions.push("click");
    return actions;
  }

  function stableElementKey(element, rootIndex) {
    const segments = [];
    let current = element;
    while (current?.nodeType === 1) {
      const tag = current.tagName.toLowerCase();
      const id = String(current.id || "").trim();
      if (id) {
        segments.push(`${tag}#${id}`);
        break;
      }
      let position = 1;
      let sibling = current.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === current.tagName) position += 1;
        sibling = sibling.previousElementSibling;
      }
      segments.push(`${tag}:nth-of-type(${position})`);
      const parent = current.parentElement;
      if (parent) {
        current = parent;
        continue;
      }
      const rootNode = current.getRootNode?.();
      current = rootNode?.host || null;
    }
    return `root-${rootIndex}/${segments.reverse().join("/")}`;
  }

  const roots = rootsFrom(document);
  for (const root of roots) {
    for (const old of root.querySelectorAll?.(`[${args.markerAttribute}]`) || []) {
      old.removeAttribute(args.markerAttribute);
    }
  }
  for (const [rootIndex, root] of roots.entries()) {
    for (const element of root.querySelectorAll?.("*") || []) {
      if (elements.length >= args.maxElements) break;
      if (!isInteractive(element) || !isVisible(element)) continue;
      const locatorId = `${args.markerPrefix}-${index}`;
      const elementId = `web-${index}`;
      index += 1;
      element.setAttribute(args.markerAttribute, locatorId);
      const rect = globalRect(element);
      const tag = element.tagName.toLowerCase();
      const type = String(element.getAttribute("type") || "").toLowerCase();
      const secure = tag === "input" && type === "password";
      const rawValue = "value" in element ? element.value : element.isContentEditable ? element.textContent : undefined;
      const name = accessibleName(element);
      const normalizedName = name.toLowerCase();
      const riskLevel = /delete|remove|submit|send|pay|purchase|confirm|删除|移除|提交|发送|支付|购买|确认/.test(normalizedName)
        ? "high"
        : "normal";
      elements.push({
        elementId,
        locatorId,
        stableKey: stableElementKey(element, rootIndex),
        tag,
        role: String(element.getAttribute("role") || ""),
        name,
        type,
        value: secure ? "[REDACTED]" : rawValue == null ? undefined : String(rawValue).slice(0, 2_000),
        secure,
        enabled: !(element.disabled || element.getAttribute("aria-disabled") === "true"),
        checked: "checked" in element ? Boolean(element.checked) : undefined,
        actions: elementActions(element),
        riskLevel,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      });
    }
    if (elements.length >= args.maxElements) break;
  }

  const bodyText = String(document.body?.innerText || "").replace(/\n{3,}/g, "\n\n").slice(0, args.maxTextLength);
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      devicePixelRatio: window.devicePixelRatio
    },
    text: bodyText,
    elements,
    captureGaps: [...new Set(gaps)]
  };
}

function findMarkedElement(args) {
  function findIn(root) {
    const direct = root.querySelector?.(`[${args.markerAttribute}="${args.locatorId}"]`);
    if (direct) return direct;
    for (const element of root.querySelectorAll?.("*") || []) {
      if (element.shadowRoot) {
        const shadowMatch = findIn(element.shadowRoot);
        if (shadowMatch) return shadowMatch;
      }
      if (element.tagName?.toLowerCase() === "iframe") {
        try {
          if (element.contentDocument) {
            const frameMatch = findIn(element.contentDocument);
            if (frameMatch) return frameMatch;
          }
        } catch {
          // Cross-origin frames cannot expose a page object to this target.
        }
      }
    }
    return null;
  }
  return findIn(document);
}

function dragPoints(args) {
  function findIn(root, locatorId) {
    const direct = root.querySelector?.(`[${args.markerAttribute}="${locatorId}"]`);
    if (direct) return direct;
    for (const element of root.querySelectorAll?.("*") || []) {
      if (element.shadowRoot) {
        const shadowMatch = findIn(element.shadowRoot, locatorId);
        if (shadowMatch) return shadowMatch;
      }
      if (element.tagName?.toLowerCase() === "iframe") {
        try {
          if (element.contentDocument) {
            const frameMatch = findIn(element.contentDocument, locatorId);
            if (frameMatch) return frameMatch;
          }
        } catch {
          // Cross-origin frames are unavailable to the current target.
        }
      }
    }
    return null;
  }
  function point(element) {
    const rect = element.getBoundingClientRect();
    return {
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2
    };
  }
  const source = findIn(document, args.sourceLocatorId);
  const target = findIn(document, args.targetLocatorId);
  if (!source || !target) return { error: { code: "STALE_SNAPSHOT", message: "拖放元素已重渲染，请重新 observe" } };
  source.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  target.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  return { source: point(source), target: point(target) };
}

function dispatchDomDrag(args) {
  function findIn(root, locatorId) {
    const direct = root.querySelector?.(`[${args.markerAttribute}="${locatorId}"]`);
    if (direct) return direct;
    for (const element of root.querySelectorAll?.("*") || []) {
      if (element.shadowRoot) {
        const shadowMatch = findIn(element.shadowRoot, locatorId);
        if (shadowMatch) return shadowMatch;
      }
      if (element.tagName?.toLowerCase() === "iframe") {
        try {
          if (element.contentDocument) {
            const frameMatch = findIn(element.contentDocument, locatorId);
            if (frameMatch) return frameMatch;
          }
        } catch {
          // Cross-origin frames are unavailable to the current target.
        }
      }
    }
    return null;
  }
  const source = findIn(document, args.sourceLocatorId);
  const target = findIn(document, args.targetLocatorId);
  if (!source || !target) {
    return { error: { code: "STALE_SNAPSHOT", message: "拖放元素已重渲染，请重新 observe" } };
  }
  if (typeof DataTransfer !== "function" || typeof DragEvent !== "function") {
    return { error: { code: "UNSUPPORTED_ACTION", message: "页面环境不支持标准 HTML5 拖放事件" } };
  }
  const dataTransfer = new DataTransfer();
  const dispatch = (element, type) => element.dispatchEvent(new DragEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    dataTransfer
  }));
  source.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  target.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  dispatch(source, "dragstart");
  dispatch(target, "dragenter");
  dispatch(target, "dragover");
  dispatch(target, "drop");
  dispatch(source, "dragend");
  return { performed: true, dispatch: "html5-drag" };
}

function performElementAction(args) {
  function findIn(root) {
    const direct = root.querySelector?.(`[${args.markerAttribute}="${args.locatorId}"]`);
    if (direct) return direct;
    for (const element of root.querySelectorAll?.("*") || []) {
      if (element.shadowRoot) {
        const shadowMatch = findIn(element.shadowRoot);
        if (shadowMatch) return shadowMatch;
      }
      if (element.tagName?.toLowerCase() === "iframe") {
        try {
          if (element.contentDocument) {
            const frameMatch = findIn(element.contentDocument);
            if (frameMatch) return frameMatch;
          }
        } catch {
          // Cross-origin frames are not represented by semantic element IDs.
        }
      }
    }
    return null;
  }

  function setValue(element, value, append) {
    const tag = element.tagName.toLowerCase();
    const view = element.ownerDocument?.defaultView || window;
    const next = append
      ? String(("value" in element ? element.value : element.textContent) || "") + value
      : value;
    if (element.isContentEditable) {
      element.focus();
      element.textContent = next;
    } else if (tag === "input" || tag === "textarea") {
      element.focus();
      const proto = tag === "textarea" ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(element, next);
      else element.value = next;
    } else {
      return { error: { code: "UNSUPPORTED_ACTION", message: "目标元素不支持文本输入" } };
    }
    element.dispatchEvent(new view.InputEvent("input", { bubbles: true, inputType: append ? "insertText" : "insertReplacementText", data: value }));
    element.dispatchEvent(new view.Event("change", { bubbles: true }));
    return { performed: true, valueLength: next.length };
  }

  function globalPoint(element) {
    const local = element.getBoundingClientRect();
    let x = local.x + local.width / 2;
    let y = local.y + local.height / 2;
    let view = element.ownerDocument?.defaultView;
    while (view && view !== view.top) {
      const frame = view.frameElement;
      if (!frame) break;
      const frameRect = frame.getBoundingClientRect();
      x += frameRect.x + Number(frame.clientLeft || 0);
      y += frameRect.y + Number(frame.clientTop || 0);
      view = frame.ownerDocument?.defaultView;
    }
    return { x, y };
  }

  const element = findIn(document);
  if (!element) return { error: { code: "STALE_SNAPSHOT", message: "目标元素已重渲染，请重新 observe" } };
  const tag = element.tagName.toLowerCase();
  const type = String(element.getAttribute("type") || "").toLowerCase();
  if (tag !== args.expectedTag || type !== args.expectedType) {
    return { error: { code: "STALE_SNAPSHOT", message: "目标元素语义已变化，请重新 observe" } };
  }
  if (element.disabled || element.getAttribute("aria-disabled") === "true") {
    return { error: { code: "ELEMENT_DISABLED", message: "目标元素不可用" } };
  }
  element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });

  if (args.kind === "click") {
    const point = globalPoint(element);
    const anchor = element.closest?.("a[href]");
    return {
      performed: false,
      dispatch: "click",
      x: point.x,
      y: point.y,
      anchor: anchor ? {
        href: String(anchor.href || ""),
        download: String(anchor.getAttribute("download") || ""),
        target: String(anchor.getAttribute("target") || "")
      } : undefined
    };
  }
  if (args.kind === "set-value") return setValue(element, String(args.value || ""), false);
  if (args.kind === "type-text") return setValue(element, String(args.value || ""), true);
  if (args.kind === "select-option") {
    if (tag !== "select") return { error: { code: "UNSUPPORTED_ACTION", message: "目标元素不是 select" } };
    const wanted = String(args.value || "");
    const option = [...element.options].find((item) => item.value === wanted || item.label === wanted || item.text === wanted);
    if (!option) return { error: { code: "OPTION_NOT_FOUND", message: `未找到选项：${wanted}` } };
    element.value = option.value;
    const view = element.ownerDocument?.defaultView || window;
    element.dispatchEvent(new view.Event("input", { bubbles: true }));
    element.dispatchEvent(new view.Event("change", { bubbles: true }));
    return { performed: true, selected: option.label || option.text || option.value };
  }
  if (args.kind === "hover") {
    const point = globalPoint(element);
    return { performed: false, dispatch: "hover", x: point.x, y: point.y };
  }
  return { error: { code: "UNSUPPORTED_ACTION", message: `不支持的元素动作：${args.kind}` } };
}
