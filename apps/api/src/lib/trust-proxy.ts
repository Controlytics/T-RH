/**
 * Parse TRUST_PROXY into Fastify's `trustProxy` option.
 *
 * Only trust the X-Forwarded-* family when explicitly behind a known reverse
 * proxy. Unset / "false" → false: req.ip is the raw socket address, which a
 * caller cannot lie about (it is written into the audit trail and keys the
 * rate limiter).
 *
 * Accepted values:
 *   - "true"                       trust every hop (only when the API cannot be reached directly)
 *   - "false" / unset              trust nothing (default)
 *   - "10.0.0.5" / "10.0.0.0/24,127.0.0.1"   trust only these proxy addresses
 *
 * A bare hop count ("1") is REFUSED. Fastify 5.12 removed hop-count trust
 * because it cannot validate the immediate peer: a client that reaches the
 * API directly can forge X-Forwarded-For (the 2026-10-12 fastify advisory).
 * Failing at startup is deliberate — silently treating "1" as false would
 * change the recorded IP behind a proxy without anyone noticing.
 */
export function parseTrustProxy(raw: string | undefined): boolean | string {
  const v = (raw ?? '').trim();
  if (v === '' || v.toLowerCase() === 'false') return false;
  if (v.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(v)) {
    throw new Error(
      `TRUST_PROXY=${v} is a hop count, which is no longer supported: it lets a client that reaches `
      + 'the API directly forge X-Forwarded-For. Set it to the proxy\'s IP or CIDR '
      + '(e.g. TRUST_PROXY=127.0.0.1 or TRUST_PROXY=10.0.0.0/24), or to true/false.',
    );
  }
  return v;
}
