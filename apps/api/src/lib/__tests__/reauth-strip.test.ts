import { describe, it, expect } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { enforceReauth, enforceReauthAlways, stripPrivateFields } from '../reauth-check.js';

/**
 * Audit 2026-10-03, SEC-1: `enforceReauth` deleted `_currentPassword` from
 * the body only on the path where the role REQUIRED re-auth; when it did
 * not, the early return left the password in the body and the dynamic
 * config PUT stored it. The strip runs before any return now, in both
 * helpers, and nothing underscore-prefixed survives.
 */
const fakeReq = (body: Record<string, unknown>) => ({
  user: { sub: '00000000-0000-4000-8000-000000000000', role: 'OPERATOR', username: 'nobody' },
  body,
  headers: {},
  ip: '127.0.0.1',
}) as unknown as FastifyRequest;

const fakeReply = () => {
  const sent: unknown[] = [];
  const reply = { code: () => reply, send: (b: unknown) => { sent.push(b); return reply; } };
  return { reply: reply as unknown as FastifyReply, sent };
};

describe('re-auth helpers strip private fields before any early return', () => {
  it('enforceReauth: an action no role requires returns ok WITHOUT the password in the body', async () => {
    const body = { _currentPassword: 'Hunter2!', _other: 1, keep: 'me' };
    const { reply } = fakeReply();
    const res = await enforceReauth('ACTION_NOBODY_CONFIGURED_e2e', fakeReq(body), reply);
    expect(res.ok).toBe(true);
    expect(body).toEqual({ keep: 'me' });
  });

  it('enforceReauthAlways: a refused password still leaves no private field behind', async () => {
    const body = { _currentPassword: 'wrong', keep: 'me' };
    const { reply } = fakeReply();
    const res = await enforceReauthAlways('ANY', fakeReq(body), reply);
    expect(res.ok).toBe(false);
    expect(body).toEqual({ keep: 'me' });
  });

  // 2026-10-14: the strip-first fix (ae146d1) made every route that runs the
  // optional check and THEN the always-on one unusable from the browser: the
  // first deleted `_currentPassword`, the second found none and answered
  // REAUTH_REQUIRED for ever (General & Password, Date/Time, Session, Login
  // Security, profile key removal, bulk upload). The second check must still
  // see the password the first one stripped.
  it('enforceReauth then enforceReauthAlways on ONE request: the second still verifies the body password', async () => {
    const body = { _currentPassword: 'Hunter2!', keep: 'me' };
    const req = fakeReq(body);
    const first = fakeReply();
    expect((await enforceReauth('ACTION_NOBODY_CONFIGURED_e2e', req, first.reply)).ok).toBe(true);
    expect(body).toEqual({ keep: 'me' });
    const second = fakeReply();
    const res = await enforceReauthAlways('ANY', req, second.reply);
    expect(res.ok).toBe(false);
    // The fake user does not exist, so verification FAILS — what matters is
    // that it was attempted, i.e. the password reached the second check.
    expect(second.sent[0]).toMatchObject({ error: 'REAUTH_FAILED' });
    expect(body).toEqual({ keep: 'me' });
  });

  it('stripPrivateFields removes every underscore key in place and tolerates undefined', () => {
    const b = { _a: 1, b: 2, _c: 3 };
    expect(stripPrivateFields(b)).toBe(b);
    expect(b).toEqual({ b: 2 });
    expect(stripPrivateFields(undefined)).toBeUndefined();
  });
});
