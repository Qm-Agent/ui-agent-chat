export function isHtmlPreviewPath(filePath: string): boolean {
  return /\.html?$/i.test(filePath);
}

export function untrustedPreviewHeaders(html: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin"
  };
  if (html) {
    headers["Content-Security-Policy"] = "sandbox; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:";
  }
  return headers;
}
