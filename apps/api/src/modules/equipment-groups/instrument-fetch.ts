/**
 * Instrument auto-fetch (2026-06-13, Phase 2) — SSRF-hardened outbound fetch of
 * a single instrument reading from an admin-configured URL.
 *
 * The backend makes the outbound HTTP call (server-proxied) so URLs/secrets stay
 * off the client and the value can be audited. Because we fetch admin-typed URLs,
 * every call is hardened: scheme allowlist, DNS-resolved destination check that
 * blocks loopback / link-local (incl. cloud-metadata 169.254.169.254) /
 * unspecified addresses, no redirect-follow, a short timeout, and a response-size
 * cap. Private LAN ranges (10/8, 172.16/12, 192.168/16) are intentionally
 * ALLOWED — cleanroom instruments live on the local network.
 *
 * Contract (D2): the instrument endpoint returns `{ "value": <number> }` already
 * in the instrument's UoM. The client owns the 1-min + 1-min retry loop; each
 * call here is one quick attempt.
 */
import { lookup } from 'node:dns/promises';

const TIMEOUT_MS = 5000;
const MAX_BYTES = 64 * 1024; // 64 KiB — a reading payload is tiny; anything bigger is suspect.

export type ReadingObjectResult =
  /** The flat reading object, e.g. { air_pressure: 6.2, ro_water_pressure: 4.1 }. */
  | { ok: true; reading: Record<string, number>; fetchedAt: string }
  | { ok: false; error: string };

/**
 * True for addresses we refuse to connect to even when an admin typed the URL:
 * loopback, link-local (covers the 169.254.169.254 metadata endpoint),
 * and the unspecified/this-network address. Private LAN ranges are allowed.
 */
export function isBlockedAddress(ip: string, family: number): boolean {
  if (family === 4 || ip.includes('.')) {
    const v4 = ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
    const parts = v4.split('.').map((n) => Number(n));
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true; // unparseable → block
    const [a, b] = parts;
    if (a === 127) return true; // loopback 127.0.0.0/8
    if (a === 0) return true; // 0.0.0.0/8 "this network"
    if (a === 169 && b === 254) return true; // link-local 169.254.0.0/16 (incl. metadata)
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true; // loopback / unspecified
  if (lower.startsWith('fe80') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
    return true; // link-local fe80::/10
  }
  return false;
}

/** Read a response body with a hard byte cap. Returns null if the cap is exceeded. */
async function readCapped(res: Response, max: number): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) {
    const t = await res.text();
    return Buffer.byteLength(t, 'utf8') > max ? null : t;
  }
  let received = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (received > max) {
      try { await reader.cancel(); } catch { /* ignore */ }
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * SSRF-hardened GET that returns parsed JSON. Never throws.
 */
async function fetchJsonHardened(rawUrl: string | null | undefined): Promise<{ ok: true; body: any } | { ok: false; error: string }> {
  if (!rawUrl || !rawUrl.trim()) return { ok: false, error: 'No URL configured' };

  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return { ok: false, error: 'Invalid URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'URL must use http or https' };
  }

  // Resolve the host and reject if ANY resolved address is blocked.
  let addrs: { address: string; family: number }[];
  try {
    addrs = await lookup(url.hostname, { all: true });
  } catch {
    return { ok: false, error: 'DNS resolution failed' };
  }
  if (addrs.length === 0 || addrs.some((a) => isBlockedAddress(a.address, a.family))) {
    return { ok: false, error: 'Destination address not allowed' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      redirect: 'error', // a redirect aborts the call (SSRF defense)
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

    const lenHeader = res.headers.get('content-length');
    if (lenHeader && Number(lenHeader) > MAX_BYTES) return { ok: false, error: 'Response too large' };

    const text = await readCapped(res, MAX_BYTES);
    if (text === null) return { ok: false, error: 'Response too large' };

    try {
      return { ok: true, body: JSON.parse(text) };
    } catch {
      return { ok: false, error: 'Response was not valid JSON' };
    }
  } catch (e: any) {
    if (e?.name === 'AbortError') return { ok: false, error: 'Timed out' };
    if (e?.cause?.code === 'UND_ERR_REDIRECT' || e?.message?.toLowerCase().includes('redirect')) {
      return { ok: false, error: 'Redirects are not allowed' };
    }
    return { ok: false, error: 'Request failed' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch the group's reading endpoint and return its flat reading object. The
 * instrument values live under a `reading` object, e.g.
 *   { "reading": { "air_pressure": 6.2, "ro_water_pressure": 4.1 } }
 * Falls back to top-level keys when there's no `reading` wrapper. Only finite
 * numeric values are kept. Never throws.
 */
export async function fetchReadingObject(rawUrl: string | null | undefined): Promise<ReadingObjectResult> {
  const res = await fetchJsonHardened(rawUrl);
  if (!res.ok) return { ok: false, error: res.error };
  const body = res.body;
  const raw = (body && typeof body === 'object' && body.reading && typeof body.reading === 'object') ? body.reading : body;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Response missing a reading object' };
  }
  const reading: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'number' && Number.isFinite(v)) reading[k] = v;
  }
  return { ok: true, reading, fetchedAt: new Date().toISOString() };
}
