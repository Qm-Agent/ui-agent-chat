export function filterApps(result: Record<string, unknown>, query: string | undefined, limit: number): Record<string, unknown> {
  const apps = Array.isArray(result.apps) ? result.apps as Array<Record<string, unknown>> : [];
  const needle = query?.trim().toLowerCase();
  const matches = apps.filter((app) => !needle || [app.displayName, app.id].some((value) => String(value || "").toLowerCase().includes(needle)))
    .slice(0, clamp(limit, 1, 200));
  const fallbackRequired = Boolean(needle && matches.length === 0 && apps.length > 0);
  return {
    ...result,
    query: query ?? null,
    totalAppCount: apps.length,
    matchedAppCount: matches.length,
    fallbackRequired,
    fallbackHint: fallbackRequired
      ? "显示名称可能受系统语言影响；请立即执行一次不带 --query 的 apps list，并通过 bundle ID 和应用语义选择目标。"
      : undefined,
    apps: matches
  };
}

export function filterObservation<T extends Record<string, unknown>>(
  snapshot: T,
  query: string | undefined,
  limit: number,
  diff = false
): T {
  if (!query?.trim()) return diff ? diffObservation(snapshot, limit) : compactObservation(snapshot, limit);
  const normalizedQuery = query.trim();
  const needle = normalizedQuery.toLowerCase();
  const elements = Array.isArray(snapshot.elements) ? snapshot.elements as Array<Record<string, unknown>> : [];
  const allMatches = elements.filter((element) => [element.name, element.value, element.role, element.elementId]
    .some((value) => String(value ?? "").toLowerCase().includes(needle)));
  const matches = allMatches.slice(0, clamp(limit, 1, 100));
  const text = String(snapshot.text || "").split("\n").filter((line) => line.toLowerCase().includes(needle)).slice(0, clamp(limit, 1, 100)).join("\n");
  return {
    ...snapshot,
    query: normalizedQuery,
    totalElementCount: elements.length,
    matchedElementCount: allMatches.length,
    responseElementCount: matches.length,
    responseTruncated: allMatches.length > matches.length,
    elements: matches,
    text
  };
}

function diffObservation<T extends Record<string, unknown>>(snapshot: T, limit: number): T {
  const changes = record(snapshot.changes);
  const added = arrayOfRecords(changes.addedElements);
  const updated = arrayOfRecords(changes.updatedElements);
  const removedElementIds = Array.isArray(changes.removedElementIds)
    ? changes.removedElementIds.map(String)
    : [];
  if (!Object.hasOwn(snapshot, "changes")) return compactObservation(snapshot, limit);
  const boundedLimit = clamp(limit, 1, 100);
  const changedElements = [...added, ...updated];
  const elements = changedElements.slice(0, boundedLimit);
  const text = elements.map((element) => {
    const value = element.secure === true ? "[REDACTED]" : element.value;
    const valueText = value == null ? "" : ` value=${JSON.stringify(value)}`;
    return `${String(element.elementId || "")} ${String(element.role || "")} ${String(element.name || "")}${valueText}`.trim();
  }).join("\n");
  const { changes: _changes, ...base } = snapshot;
  return {
    ...base,
    diff: true,
    diffTruncated: changedElements.length > elements.length,
    totalElementCount: Array.isArray(snapshot.elements) ? snapshot.elements.length : 0,
    changedElementCount: changedElements.length,
    removedElementIds,
    elements,
    text
  } as unknown as T;
}

function compactObservation<T extends Record<string, unknown>>(snapshot: T, limit: number): T {
  const elements = arrayOfRecords(snapshot.elements);
  const projection = record(snapshot.projection);
  if (projection.mode === "full") return snapshot;
  const boundedLimit = clamp(limit, 1, 100);
  const selected = elements
    .map((element, index) => ({ element, index, score: observationElementScore(element) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, boundedLimit)
    .sort((left, right) => left.index - right.index)
    .map(({ element }) => element);
  const text = selected.map(observationElementText).filter(Boolean).join("\n");
  return {
    ...snapshot,
    totalElementCount: elements.length,
    responseElementCount: selected.length,
    responseTruncated: elements.length > selected.length,
    elements: selected,
    text
  };
}

function observationElementScore(element: Record<string, unknown>): number {
  const role = String(element.role || "").toLowerCase();
  const name = String(element.name || "").trim();
  const value = element.secure === true ? "" : String(element.value || "").trim();
  const actions = Array.isArray(element.actions) ? element.actions : [];
  const interactiveRole = /(button|textfield|textarea|combobox|checkbox|radiobutton|menuitem|link|popupbutton|tab|slider|searchfield)/.test(role);
  let score = 0;
  if (element.focused === true) score += 1_000;
  if (interactiveRole) score += 300;
  if (element.enabled !== false && actions.length > 0 && (interactiveRole || name || value)) score += 200;
  if (name) score += 100;
  if (value) score += 60;
  if (element.bounds) score += 5;
  return score;
}

function observationElementText(element: Record<string, unknown>): string {
  const value = element.secure === true ? "[REDACTED]" : element.value;
  const valueText = value == null || value === "" ? "" : ` value=${JSON.stringify(value)}`;
  return `${String(element.elementId || "")} ${String(element.role || "")} ${String(element.name || "")}${valueText}`.trim();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
