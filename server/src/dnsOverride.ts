import dns from "node:dns";
import net from "node:net";
import fs from "node:fs/promises";
import fsSync from "node:fs";

const HOSTS_FILE = process.env.UIWARDEN_HOSTS_FILE ?? "/etc/hosts";
const SYSTEM_HOSTS = "/etc/hosts";
const CACHE_TTL_MS = 5000;

interface CachedEntry {
  address: string;
  family: 4 | 6;
}

let cachedHosts = new Map<string, CachedEntry[]>();
let cacheTimestamp = 0;
let refreshInProgress = false;
let originalLookup: typeof dns.lookup;
let originalPromisesLookup: typeof dns.promises.lookup;

function parseHostsFile(content: string): Map<string, CachedEntry[]> {
  const hosts = new Map<string, CachedEntry[]>();
  for (const line of content.split("\n")) {
    const trimmed = line.replace(/#.*$/, "").trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    const ip = parts[0];
    if (!ip) continue;
    const ipFamily = net.isIP(ip);
    if (ipFamily === 0) continue;
    for (let i = 1; i < parts.length; i++) {
      const hostname = parts[i]!.toLowerCase();
      const entries = hosts.get(hostname) ?? [];
      entries.push({ address: ip, family: ipFamily as 4 | 6 });
      hosts.set(hostname, entries);
    }
  }
  return hosts;
}

function loadHostsFileSync(): void {
  try {
    const content = fsSync.readFileSync(HOSTS_FILE, "utf8");
    cachedHosts = parseHostsFile(content);
    cacheTimestamp = Date.now();
  } catch {
    cachedHosts = new Map();
    cacheTimestamp = Date.now();
  }
}

function triggerAsyncRefresh(): void {
  const now = Date.now();
  if (now - cacheTimestamp < CACHE_TTL_MS || refreshInProgress) return;
  refreshInProgress = true;
  fs.readFile(HOSTS_FILE, "utf8")
    .then((content) => {
      cachedHosts = parseHostsFile(content);
      cacheTimestamp = Date.now();
    })
    .catch(() => {
      // keep existing cache on read error
    })
    .finally(() => {
      refreshInProgress = false;
    });
}

function lookupFromCache(
  hostname: string,
  family: 0 | 4 | 6
): CachedEntry[] | null {
  const entries = cachedHosts.get(hostname.toLowerCase());
  if (!entries) return null;
  if (family === 0) return entries;
  return entries.filter((e) => e.family === family);
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string, family: number) => void;
type LookupAllCallback = (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void;

function normalizeOptions(
  opts: number | dns.LookupOptions | undefined
): { family: 0 | 4 | 6; all: boolean; verbatim?: boolean } {
  if (opts === undefined) return { family: 0, all: false };
  if (typeof opts === "number") return { family: opts as 0 | 4 | 6, all: false };
  return {
    family: (opts.family as 0 | 4 | 6) ?? 0,
    all: opts.all ?? false,
    verbatim: opts.verbatim
  };
}

function overrideLookup(
  hostname: string,
  options?: number | dns.LookupOptions | LookupCallback | LookupAllCallback,
  callback?: LookupCallback | LookupAllCallback
): void {
  // Handle 2-arg form: lookup(hostname, callback)
  let normalizedOpts: { family: 0 | 4 | 6; all: boolean; verbatim?: boolean };
  let actualCallback: LookupCallback | LookupAllCallback;

  if (typeof options === "function") {
    actualCallback = options as LookupCallback | LookupAllCallback;
    normalizedOpts = { family: 0, all: false };
  } else {
    actualCallback = callback!;
    normalizedOpts = normalizeOptions(options);
  }

  // IP addresses: fall through to original
  if (net.isIP(hostname)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (originalLookup as any).call(dns, hostname, options, actualCallback);
    return;
  }

  // Trigger background refresh if cache is stale
  triggerAsyncRefresh();

  const cached = lookupFromCache(hostname, normalizedOpts.family);
  if (cached && cached.length > 0) {
    if (normalizedOpts.all) {
      let results = cached.map((e) => ({ address: e.address, family: e.family }));
      if (normalizedOpts.verbatim === false) {
        results = results.sort((a, b) => a.family - b.family);
      }
      process.nextTick(actualCallback as LookupAllCallback, null, results);
      return;
    }
    const entry = cached[0]!;
    process.nextTick(actualCallback as LookupCallback, null, entry.address, entry.family);
    return;
  }

  // Not found in custom hosts: fall through to original
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (originalLookup as any).call(dns, hostname, options, actualCallback);
}

function overridePromisesLookup(
  hostname: string,
  options?: number | dns.LookupOptions
): Promise<dns.LookupAddress | dns.LookupAddress[]> {
  const opts = normalizeOptions(options);

  if (net.isIP(hostname)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (originalPromisesLookup as any).call(dns.promises, hostname, options);
  }

  triggerAsyncRefresh();

  const cached = lookupFromCache(hostname, opts.family);
  if (cached && cached.length > 0) {
    if (opts.all) {
      let results = cached.map((e) => ({ address: e.address, family: e.family }));
      if (opts.verbatim === false) {
        results = results.sort((a, b) => a.family - b.family);
      }
      return Promise.resolve(results);
    }
    const entry = cached[0]!;
    return Promise.resolve({ address: entry.address, family: entry.family });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (originalPromisesLookup as any).call(dns.promises, hostname, options);
}

export function initDnsOverride(): void {
  if (HOSTS_FILE === SYSTEM_HOSTS) return;

  loadHostsFileSync();
  originalLookup = dns.lookup;
  originalPromisesLookup = dns.promises.lookup;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (dns as any).lookup = overrideLookup;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (dns.promises as any).lookup = overridePromisesLookup;

  console.log(`DNS override active: reading hosts from ${HOSTS_FILE}`);
}

export function refreshDnsCache(): void {
  cacheTimestamp = 0;
  triggerAsyncRefresh();
}