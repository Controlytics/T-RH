import { describe, it, expect } from 'vitest';
import { interpretHttpGatewayResult, detectUnambiguousGatewayFailure } from '../sms-channel.js';

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
