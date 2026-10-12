/**
 * Outbound-request guard for OPERATOR-TYPED URLs — alarm webhook targets and the
 * SMS http-gateway (audit 2026-10-12 #1).
 *
 * THE THREAT. A webhook target is `method` + `url` + arbitrary `headers`, and the
 * test-fire returns the first 1,000 characters of the response. Pointed at
 * `http://169.254.169.254/` it reads the EC2 instance metadata service: a PUT to
 * `/latest/api/token` yields an IMDSv2 token, and a GET with that token yields the
 * instance role's AWS credentials. The holder of ALARM_RULE_MANAGE is not meant to
 * hold the server's cloud identity.
 *
 * WHAT IS BLOCKED, AND WHAT IS NOT. A hooter lives on the operator's LAN, so the
 * private ranges (10/8, 172.16/12, 192.168/16, fc00::/7) MUST stay reachable and
 * an allowlist is impossible. What no hooter can legitimately be:
 *   - link-local — 169.254.0.0/16 (the IMDS and every cloud's metadata service)
 *     and fe80::/10;
 *   - loopback — 127.0.0.0/8 and ::1 (the API itself, EMQX's dashboard, Postgres
 *     on the same host);
 *   - "this host" / unspecified — 0.0.0.0/8 and :: (connects to the local host on
 *     most stacks);
 *   - fd00:ec2::254, EC2's IPv6 metadata endpoint — inside fc00::/7, which is
 *     otherwise allowed, so it is named as a single host;
 *   - and each of those spelled as an IPv4-mapped / -compatible / NAT64 IPv6
 *     address (`::ffff:169.254.169.254`, `::ffff:a9fe:a9fe`, `64:ff9b::…`).
 *
 * WHEN. At SAVE (so a bad target is refused with a message) and at SEND, AFTER
 * DNS resolution. The send path resolves the name itself through `guardedLookup`
 * and hands the socket exactly the address it checked, so a name that resolves
 * to a LAN address when saved and to 169.254.169.254 when sent (DNS rebinding)
 * is refused at connect. Redirects are never followed (a 3xx is a failure).
 */

import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';

let loopbackAllowedForTests = false;

/**
 * TEST SEAM ONLY. The webhook and SMS suites talk to a real `node:http` server on
 * 127.0.0.1, which this guard blocks in production. Relaxes LOOPBACK alone —
 * link-local / metadata stay blocked even here. Not read from the environment on
 * purpose: nothing an operator configures can switch it on.
 */
export function allowLoopbackForTests(allowed: boolean): void {
  loopbackAllowedForTests = allowed;
}

function ipv4Reason(ip: string): string | null {
  const p = ip.split('.').map((x) => Number(x));
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  if (p[0] === 169 && p[1] === 254) return 'a link-local / cloud metadata address';
  if (p[0] === 127) return loopbackAllowedForTests ? null : 'a loopback address';
  if (p[0] === 0) return 'an unspecified ("this host") address';
  return null;
}

/** Eight 16-bit groups, or null if not a parseable IPv6 address. */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  // A trailing dotted IPv4 (`::ffff:1.2.3.4`) becomes two hex groups.
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = tail.split('.').map(Number);
    if (v4.length !== 4 || v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    s = `${s.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0) return null;
  const all = [...head, ...Array(fill).fill('0'), ...rest];
  if (all.length !== 8) return null;
  const groups = all.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return groups.some(Number.isNaN) ? null : groups;
}

const embeddedV4 = (g: number[]) => `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;

function ipv6Reason(ip: string): string | null {
  const g = ipv6Groups(ip);
  if (!g) return null;
  const zeroTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (g.every((x) => x === 0)) return 'an unspecified ("this host") address';
  if (zeroTo(7) && g[7] === 1) return loopbackAllowedForTests ? null : 'a loopback address';
  if ((g[0] & 0xffc0) === 0xfe80) return 'a link-local address';
  // fd00:ec2::254 — EC2's IPv6 instance metadata endpoint.
  if (g[0] === 0xfd00 && g[1] === 0x0ec2
      && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0 && g[6] === 0 && g[7] === 0x254) {
    return 'the cloud metadata address';
  }
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d) and NAT64
  // (64:ff9b::a.b.c.d) all reach the embedded IPv4 address: judge THAT.
  const mapped = zeroTo(5) && g[5] === 0xffff;
  const compatible = zeroTo(6) && !(g[6] === 0 && g[7] <= 1);
  const nat64 = g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0;
  if (mapped || compatible || nat64) return ipv4Reason(embeddedV4(g));
  return null;
}

/**
 * Why a resolved IP address may not be the target of an operator-typed request,
 * or null when it may. Not an IP at all → null (the caller resolves names).
 */
export function blockedAddressReason(address: string): string | null {
  const a = address.replace(/^\[|\]$/g, '');
  const family = net.isIP(a);
  if (family === 4) return ipv4Reason(a);
  if (family === 6) return ipv6Reason(a);
  return null;
}

/**
 * Save-time check of a URL's host WITHOUT touching the network: refuses an IP
 * literal that is blocked. Synchronous so the pure draft validator can use it.
 * A NAME is judged by {@link resolveBlockedReason} (async) and again at send.
 */
export function literalHostBlockedReason(url: string): string | null {
  let host: string;
  try { host = new URL(url).hostname; } catch { return null; }
  return blockedAddressReason(host);
}

/**
 * Save-time check that resolves a NAME: refuses a URL whose host resolves to
 * any blocked address (`localhost`, `metadata.google.internal`, a name pointed at
 * 169.254.169.254). A name that does not resolve here is NOT refused — the
 * hooter's DNS may be unreachable from where it is configured — because the send
 * path judges the address it actually connects to.
 */
export async function resolveBlockedReason(url: string): Promise<string | null> {
  let host: string;
  try { host = new URL(url).hostname.replace(/^\[|\]$/g, ''); } catch { return null; }
  const literal = blockedAddressReason(host);
  if (literal || net.isIP(host)) return literal ? `${host} is ${literal}` : null;
  try {
    const addrs = await dns.promises.lookup(host, { all: true, verbatim: true });
    for (const a of addrs) {
      const r = blockedAddressReason(a.address);
      if (r) return `${host} resolves to ${a.address}, ${r}`;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * A `lookup` for `http.request` that refuses the connection if ANY address the
 * name resolves to is blocked, and otherwise hands back exactly the addresses it
 * judged — so the socket connects to a checked address and a rebinding answer
 * cannot slip in between check and connect. Handles both the single-address and
 * the `all: true` (happy-eyeballs) calling conventions.
 */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
    if (err) return (callback as (e: Error) => void)(err);
    const list = addresses as dns.LookupAddress[];
    for (const a of list) {
      const r = blockedAddressReason(a.address);
      if (r) {
        const e = Object.assign(new Error(`Refused: ${hostname} resolves to ${a.address}, ${r}`), { code: 'EADDRBLOCKED' });
        return (callback as (e: Error) => void)(e);
      }
    }
    if (list.length === 0) {
      return (callback as (e: Error) => void)(Object.assign(new Error(`No address for ${hostname}`), { code: 'ENOTFOUND' }));
    }
    if ((options as { all?: boolean }).all) {
      return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
    }
    return (callback as (e: null, a: string, f: number) => void)(null, list[0].address, list[0].family);
  });
};

export interface GuardedResponse {
  status: number;
  /** Decoded body, at most `maxBodyChars` characters. */
  text: string;
}

/**
 * One HTTP(S) request to an operator-typed URL under the guard. No redirects are
 * followed (a 3xx comes back as its status for the caller to judge as a failure),
 * the whole exchange — connect, response, body — is bounded by `timeoutMs`, and
 * the body read stops after `maxBodyChars`. Throws on refusal, DNS failure,
 * connection failure or timeout; the caller turns that into its failure record.
 */
export function guardedRequest(opts: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxBodyChars: number;
}): Promise<GuardedResponse> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try { u = new URL(opts.url); } catch (e) { reject(e); return; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      reject(new Error(`Refused: unsupported scheme ${u.protocol}`));
      return;
    }
    // An IP literal never reaches `lookup` (Node connects to it directly), so it
    // is judged here; a name is judged inside `guardedLookup`.
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const literal = blockedAddressReason(host);
    if (literal) {
      reject(Object.assign(new Error(`Refused: ${host} is ${literal}`), { code: 'EADDRBLOCKED' }));
      return;
    }

    const headers: Record<string, string> = { ...opts.headers };
    if (opts.body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(opts.body));
    const mod = u.protocol === 'https:' ? https : http;
    let settled = false;
    const done = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

    const req = mod.request(u, {
      method: opts.method,
      headers,
      lookup: guardedLookup,
      // No pooled keep-alive socket may be reused across targets.
      agent: false,
      signal: AbortSignal.timeout(opts.timeoutMs),
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      // Bytes ≥ characters, so 4 bytes per char is a safe ceiling for the cap.
      const byteCap = opts.maxBodyChars * 4;
      res.on('data', (c: Buffer) => {
        if (size >= byteCap) return;
        chunks.push(c);
        size += c.length;
        if (size >= byteCap) res.destroy();
      });
      const finish = () => done(() => resolve({
        status: res.statusCode ?? 0,
        text: Buffer.concat(chunks).toString('utf8').slice(0, opts.maxBodyChars),
      }));
      res.on('end', finish);
      // Destroyed after the cap: what was read is the answer.
      res.on('close', () => { if (size >= byteCap) finish(); });
      res.on('error', (e) => done(() => (size >= byteCap ? finish() : reject(e))));
    });
    req.on('error', (e) => done(() => reject(e)));
    if (opts.body !== undefined) req.end(opts.body); else req.end();
  });
}
