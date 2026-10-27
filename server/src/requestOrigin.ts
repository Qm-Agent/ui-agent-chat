export function isAllowedRequestOrigin(
  origin: string | undefined,
  host: string | undefined,
  allowedOrigins: readonly string[]
): boolean {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) return false;
    if (allowedOrigins.includes(origin)) return true;
    if (!host) return false;
    return new URL(`${parsed.protocol}//${host}`).host === parsed.host;
  } catch {
    return false;
  }
}
