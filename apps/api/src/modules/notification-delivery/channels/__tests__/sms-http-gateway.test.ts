import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { interpretHttpGatewayResult, detectUnambiguousGatewayFailure, sendViaHttpGateway } from '../sms-channel.js';
import { allowLoopbackForTests } from '../../../../lib/outbound-guard.js';
import type { SmsConfig } from '../../types.js';

// #sms-2xx (2026-07-04): an HTTP-gateway SMS must not be recorded SENT just
// because the transport returned 2xx — many gateways return HTTP 200 with an
// error body.
describe('interpretHttpGatewayResult', () => {
  it('non-2xx → fail with status', () => {
    const r = interpretHttpGatewayResult(false, 502, 'Bad Gateway');
    expect(r.ok).toBe(false);
    expect((r as any).error).toContain('502');
  });

  it('2xx + no matcher + plain-text body → SENT (unchanged default)', () => {
    expect(interpretHttpGatewayResult(true, 200, 'OK id=123')).toEqual({ ok: true });
  });

  it('2xx + no matcher + JSON {"success":false} → FAILED (the core bug)', () => {
    const r = interpretHttpGatewayResult(true, 200, '{"success":false,"message":"invalid number"}');
    expect(r.ok).toBe(false);
    expect((r as any).error).toContain('invalid number');
  });

  it('2xx + no matcher + JSON {"status":"error"} → FAILED', () => {
    const r = interpretHttpGatewayResult(true, 200, '{"status":"error","error":"insufficient balance"}');
    expect(r.ok).toBe(false);
    expect((r as any).error).toContain('insufficient balance');
  });

  it('2xx + no matcher + JSON success body → SENT (no false positive)', () => {
    expect(interpretHttpGatewayResult(true, 200, '{"status":"success","id":"m1"}')).toEqual({ ok: true });
    expect(interpretHttpGatewayResult(true, 200, '{"success":true,"error":null}')).toEqual({ ok: true });
  });

  it('configured regex is AUTHORITATIVE: body must match', () => {
    const pat = '"status"\\s*:\\s*"queued"';
    expect(interpretHttpGatewayResult(true, 200, '{"status":"queued"}', pat)).toEqual({ ok: true });
    const r = interpretHttpGatewayResult(true, 200, '{"status":"blocked"}', pat);
    expect(r.ok).toBe(false);
    expect((r as any).error).toContain('did not match success pattern');
  });

  it('configured regex overrides even a would-be-success default body', () => {
    // Body looks fine by the default heuristic, but the operator requires "delivered".
    const r = interpretHttpGatewayResult(true, 200, '{"status":"success"}', 'delivered');
    expect(r.ok).toBe(false);
  });

  it('invalid regex is ignored (never crashes the send) → falls through to default', () => {
    // '(' is an invalid regex; must not throw, and a plain body → SENT.
    expect(interpretHttpGatewayResult(true, 200, 'ok', '(')).toEqual({ ok: true });
  });
});

describe('detectUnambiguousGatewayFailure', () => {
  it('returns null for plain text, arrays, empty, and non-JSON (only trusts JSON objects)', () => {
    expect(detectUnambiguousGatewayFailure('ERROR: nope')).toBeNull(); // plain text is NOT trusted → avoid FP
    expect(detectUnambiguousGatewayFailure('[{"success":false}]')).toBeNull();
    expect(detectUnambiguousGatewayFailure('')).toBeNull();
    expect(detectUnambiguousGatewayFailure('not json')).toBeNull();
  });
  it('flags success=false / ok=false / status error-ish', () => {
    expect(detectUnambiguousGatewayFailure('{"ok":false}')).toBeTruthy();
    expect(detectUnambiguousGatewayFailure('{"status":"REJECTED"}')).toBeTruthy();
  });
  it('does not flag a success body', () => {
    expect(detectUnambiguousGatewayFailure('{"status":"sent","success":true}')).toBeNull();
  });
});

/**
 * Audit 2026-10-12 #12 (SMS half) and #1 (the same SSRF vector). The gateway
 * fetch had no timeout (a gateway that accepts the connection and never answers
 * held the notification job forever), followed redirects, and ran the
 * operator-typed success regex over the whole body with no time budget. It also
 * reached any address, returning 200 characters of the answer in the error.
 */
describe('sendViaHttpGateway — transport', () => {
  let server: Server;
  let base = '';
  let hits = 0;

  beforeAll(async () => {
    allowLoopbackForTests(true);
    server = createServer((req, res) => {
      hits++;
      if (req.url?.startsWith('/hang')) return; // accepts, never answers
      if (req.url?.startsWith('/redirect')) { res.writeHead(302, { Location: '/ok' }); res.end(); return; }
      if (req.url?.startsWith('/aaaa')) { res.writeHead(200); res.end(`${'a'.repeat(30)}b`); return; }
      res.writeHead(200); res.end('{"status":"queued"}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    allowLoopbackForTests(false);
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  const cfg = (over: Partial<SmsConfig>): SmsConfig => ({
    provider: 'http-gateway', enabled: true, httpGatewayMethod: 'GET',
    httpGatewayUrl: `${base}/ok?to={phone}&msg={message}`, ...over,
  } as SmsConfig);

  it('positive control: a 2xx body is SENT', async () => {
    const r = await sendViaHttpGateway(cfg({}), '+919999999999', 'hi', 2000);
    expect(r.success).toBe(true);
  });

  it('gives up after its timeout instead of hanging', async () => {
    const started = Date.now();
    const r = await sendViaHttpGateway(cfg({ httpGatewayUrl: `${base}/hang?to={phone}` }), '+919999999999', 'hi', 300);
    expect(r.success).toBe(false);
    expect(Date.now() - started).toBeLessThan(3000);
  }, 10_000);

  it('does not follow a redirect', async () => {
    const r = await sendViaHttpGateway(cfg({ httpGatewayUrl: `${base}/redirect?to={phone}` }), '+919999999999', 'hi', 2000);
    expect(r.success).toBe(false);
  });

  it('runs the success regex under a time budget and fails closed on a runaway pattern', async () => {
    const started = Date.now();
    const r = await sendViaHttpGateway(
      cfg({ httpGatewayUrl: `${base}/aaaa?to={phone}`, httpGatewaySuccessRegex: '(a+)+$' }), '+919999999999', 'hi', 2000,
    );
    expect(r.success).toBe(false);
    expect(Date.now() - started).toBeLessThan(1500);
  }, 30_000);

  it('refuses the cloud metadata service, sending nothing', async () => {
    allowLoopbackForTests(false);
    try {
      const r = await sendViaHttpGateway(cfg({ httpGatewayUrl: 'http://169.254.169.254/latest/meta-data/?p={phone}' }), '+919999999999', 'hi', 2000);
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/Refused/);
      const before = hits;
      const r2 = await sendViaHttpGateway(cfg({}), '+919999999999', 'hi', 2000);
      expect(r2.success).toBe(false);
      expect(hits).toBe(before);
    } finally {
      allowLoopbackForTests(true);
    }
  });
});
