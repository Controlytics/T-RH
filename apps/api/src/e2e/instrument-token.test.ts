import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { resetTokenKeyCache } from '../modules/instruments/token-crypto.js';
import { invalidateIngestAuthCache } from '../modules/instruments/ingest-auth.js';
import { invalidateReauthCache, getActionReauthConfig } from '../lib/reauth-check.js';

/**
 * Reveal / set of a device access token — the 2026-08-06 reversal of spec D5.
 *
 * The key is pinned here rather than taken from `.env` so the suite proves the
 * same thing on a machine that has no INSTRUMENT_TOKEN_KEY configured. Two tests
 * deliberately unset it again; both restore it.
 */
const KEY = randomBytes(32).toString('base64');
const savedKey = process.env.INSTRUMENT_TOKEN_KEY;

function setKey(value: string | undefined): void {
  if (value === undefined) delete process.env.INSTRUMENT_TOKEN_KEY;
  else process.env.INSTRUMENT_TOKEN_KEY = value;
  resetTokenKeyCache();
}

let app: FastifyInstance;
let auth: Record<string, string>;
const created: string[] = [];

beforeAll(async () => {
  setKey(KEY);
  app = await buildApp();
  auth = { authorization: `Bearer ${await loginAs(app)}` };
});

afterAll(async () => {
  for (const id of created) await app.inject({ method: 'DELETE', url: `/api/instruments/${id}`, headers: auth });
  setKey(savedKey);
  await app.close();
});

async function newInstrument(prefix: string) {
  const res = await app.inject({
    method: 'POST', url: '/api/instruments', headers: auth,
    payload: { name: prefix, code: `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}` },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  created.push(body.id);
  return body as { id: string; code: string; token: string; tokenPrefix: string };
}

/**
 * Re-auth on all three token endpoints (reveal / set / regenerate) is ALWAYS ON
 * (`enforceReauthAlways`) — not the admin-managed `action-reauth` policy. Every
 * request below therefore carries a password, and the gate test at the bottom
 * proves one is genuinely required even when the policy row exists and does not
 * cover the acting role.
 */
const reauth = { 'x-reauth-password': 'Admin@123' };

const reveal = (id: string, headers = auth) =>
  app.inject({ method: 'GET', url: `/api/instruments/${id}/token`, headers: { ...headers, ...reauth } });

const setToken = (id: string, token: string, headers = auth) =>
  app.inject({ method: 'PUT', url: `/api/instruments/${id}/token`, headers: { ...headers, ...reauth }, payload: { token } });

const regenerate = (id: string, headers = auth) =>
  app.inject({ method: 'POST', url: `/api/instruments/${id}/regenerate-token`, headers: { ...headers, ...reauth } });

/** `audit_trail.chain_position` is a BigInt, which JSON.stringify throws on. */
function serialise(row: unknown): string {
  return JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}

const ingest = (t: string) => app.inject({
  method: 'POST', url: '/api/ingest/v1/telemetry',
  headers: { authorization: `Bearer ${t}` },
  payload: { temperature: 21.5 },
});

describe('Instrument token reveal', () => {
  it('returns EXACTLY the token that creation returned', async () => {
    const inst = await newInstrument('REV');
    const res = await reveal(inst.id);
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toBe(inst.token);
    expect(res.json().tokenPrefix).toBe(inst.tokenPrefix);
  });

  it('the revealed token still authenticates at ingest — it is the live one, not a copy', async () => {
    const inst = await newInstrument('REVLIVE');
    const shown = (await reveal(inst.id)).json().token;
    expect((await ingest(shown)).statusCode).toBe(200);
  });

  it('advertises revealability on the detail response WITHOUT exposing the value', async () => {
    const inst = await newInstrument('FLAG');
    const detail = await app.inject({ method: 'GET', url: `/api/instruments/${inst.id}`, headers: auth });
    expect(detail.json().tokenRevealable).toBe(true);
    expect(detail.json().token).toBeUndefined();
    expect(detail.json().tokenEncrypted).toBeUndefined();
  });

  it('writes EXACTLY ONE audit row per view, carrying the prefix and never the token', async () => {
    const inst = await newInstrument('AUD');
    const since = new Date();
    expect((await reveal(inst.id)).statusCode).toBe(200);

    const rows = await prisma.auditTrail.findMany({
      where: { action: 'INSTRUMENT_TOKEN_VIEWED', targetId: inst.id, timestamp: { gte: since } },
    });
    expect(rows).toHaveLength(1);
    const after = rows[0].afterValue as Record<string, unknown>;
    expect(after.code).toBe(inst.code);
    expect(after.tokenPrefix).toBe(inst.tokenPrefix);
    // The whole point of the compensating control: the ACT is recorded, the
    // SECRET is not. Serialise every field of the row (minus the BigInt
    // chain_position, which JSON.stringify refuses) and assert the token is
    // nowhere in it.
    expect(serialise(rows[0])).not.toContain(inst.token);
  });

  it('a legacy credential with no ciphertext reports TOKEN_NOT_RECOVERABLE, not a 500', async () => {
    const inst = await newInstrument('LEGACY');
    // Exactly the state of every credential issued before this migration.
    await prisma.instrumentCredential.updateMany({
      where: { instrumentId: inst.id, revokedAt: null },
      data: { tokenEncrypted: null },
    });

    const res = await reveal(inst.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('TOKEN_NOT_RECOVERABLE');

    // And the UI is told not to offer Reveal in the first place.
    const detail = await app.inject({ method: 'GET', url: `/api/instruments/${inst.id}`, headers: auth });
    expect(detail.json().tokenRevealable).toBe(false);

    // The credential is untouched by the failed reveal: ingest still works.
    expect((await ingest(inst.token)).statusCode).toBe(200);
  });

  it('reports TOKEN_KEY_MISSING with no key configured — while INGEST KEEPS WORKING', async () => {
    const inst = await newInstrument('NOKEY');
    setKey(undefined);
    try {
      const res = await reveal(inst.id);
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe('TOKEN_KEY_MISSING');
      // Fail closed on reveal, OPEN on ingest. Authentication reads the hash and
      // never the ciphertext, so the key's absence must not cost a reading.
      expect((await ingest(inst.token)).statusCode).toBe(200);
      // Issuance must not depend on the key either.
      const born = await newInstrument('NOKEYBORN');
      expect((await ingest(born.token)).statusCode).toBe(200);
      const detail = await app.inject({ method: 'GET', url: `/api/instruments/${born.id}`, headers: auth });
      expect(detail.json().tokenRevealable).toBe(false);
    } finally {
      setKey(KEY);
    }
  });

  it('reports TOKEN_DECRYPT_FAILED on a WRONG key rather than returning garbage', async () => {
    const inst = await newInstrument('WRONGKEY');
    setKey(randomBytes(32).toString('base64'));
    try {
      const res = await reveal(inst.id);
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe('TOKEN_DECRYPT_FAILED');
      // The hash is authoritative: the device is unaffected by the key mishap.
      expect((await ingest(inst.token)).statusCode).toBe(200);
    } finally {
      setKey(KEY);
    }
  });

  it('404s for an unknown instrument', async () => {
    const res = await reveal('00000000-0000-0000-0000-000000000000');
    expect(res.statusCode).toBe(404);
  });
});

describe('Instrument token set', () => {
  const custom = () => `DEVICE-FIXED-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

  it('replaces the token: the OLD one 401s at ingest and the new one 200s', async () => {
    const inst = await newInstrument('SET');
    expect((await ingest(inst.token)).statusCode).toBe(200);

    const value = custom();
    const res = await setToken(inst.id, value);
    expect(res.statusCode).toBe(200);
    expect(res.json().tokenPrefix).toBe(value.slice(0, 8));
    // The set response never echoes the value back.
    expect(res.json().token).toBeUndefined();

    // No TTL wait: the route calls invalidateIngestAuthCache.
    expect((await ingest(inst.token)).statusCode).toBe(401);
    expect((await ingest(value)).statusCode).toBe(200);
  });

  it('the set token is then revealable', async () => {
    const inst = await newInstrument('SETREV');
    const value = custom();
    expect((await setToken(inst.id, value)).statusCode).toBe(200);
    expect((await reveal(inst.id)).json().token).toBe(value);
  });

  it('REVOKES rather than overwrites: the old credential row survives for the §11 record', async () => {
    const inst = await newInstrument('HIST');
    expect((await setToken(inst.id, custom())).statusCode).toBe(200);

    const rows = await prisma.instrumentCredential.findMany({
      where: { instrumentId: inst.id }, orderBy: { createdAt: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].revokedAt).not.toBeNull();
    expect(rows[0].tokenPrefix).toBe(inst.tokenPrefix);   // history intact
    expect(rows[1].revokedAt).toBeNull();
  });

  it('refuses a token already live on ANOTHER instrument — ambiguous authentication', async () => {
    const a = await newInstrument('CLASHA');
    const b = await newInstrument('CLASHB');
    const value = custom();
    expect((await setToken(a.id, value)).statusCode).toBe(200);

    const res = await setToken(b.id, value);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('TOKEN_IN_USE');

    // The refusal rolled back: B's own credential was NOT revoked on the way.
    expect((await ingest(b.token)).statusCode).toBe(200);
    // ...and the token still resolves to A, unambiguously.
    expect((await ingest(value)).statusCode).toBe(200);
    const live = await prisma.instrumentCredential.findMany({
      where: { instrumentId: b.id, revokedAt: null },
    });
    expect(live).toHaveLength(1);
  });

  it('refuses re-setting an instrument to the token it already has', async () => {
    const inst = await newInstrument('SAME');
    const value = custom();
    expect((await setToken(inst.id, value)).statusCode).toBe(200);
    const res = await setToken(inst.id, value);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('TOKEN_IN_USE');
  });

  it('ALLOWS a token that only a REVOKED credential used — a revoked one authenticates nothing', async () => {
    const inst = await newInstrument('REUSE');
    const first = custom();
    expect((await setToken(inst.id, first)).statusCode).toBe(200);
    expect((await setToken(inst.id, custom())).statusCode).toBe(200);   // revokes `first`
    expect((await setToken(inst.id, first)).statusCode).toBe(200);      // reusable
    invalidateIngestAuthCache(inst.id);
    expect((await ingest(first)).statusCode).toBe(200);
  });

  it('rejects tokens that would not survive a header, an MQTT username or a JSON line', async () => {
    const inst = await newInstrument('BADTOK');
    const bad = [
      'short',                                   // under 32
      'x'.repeat(129),                           // over 128
      'has spaces in it aaaaaaaaaaaaaaaaaaaaaa', // space
      'has:a:colon:aaaaaaaaaaaaaaaaaaaaaaaaaaa', // colon (our own blob separator)
      'has/a/slash/aaaaaaaaaaaaaaaaaaaaaaaaaaa', // MQTT topic separator
      '<script>aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</script>',
      '',
    ];
    for (const t of bad) {
      const res = await setToken(inst.id, t);
      expect(res.statusCode, `expected 400 for ${JSON.stringify(t)}`).toBe(400);
    }
    // Nothing was revoked by any of those.
    expect((await ingest(inst.token)).statusCode).toBe(200);
  });

  it('writes exactly one INSTRUMENT_TOKEN_SET audit row, never carrying the value', async () => {
    const inst = await newInstrument('SETAUD');
    const since = new Date();
    const value = custom();
    expect((await setToken(inst.id, value)).statusCode).toBe(200);

    const rows = await prisma.auditTrail.findMany({
      where: { action: 'INSTRUMENT_TOKEN_SET', targetId: inst.id, timestamp: { gte: since } },
    });
    expect(rows).toHaveLength(1);
    expect((rows[0].afterValue as Record<string, unknown>).tokenPrefix).toBe(value.slice(0, 8));
    expect(serialise(rows[0])).not.toContain(value);
  });

  it('404s for an unknown instrument', async () => {
    const res = await setToken('00000000-0000-0000-0000-000000000000', custom());
    expect(res.statusCode).toBe(404);
  });
});

describe('Instrument token permission gate', () => {
  it('refuses an OPERATOR on BOTH reveal and set', async () => {
    const inst = await newInstrument('PERM');
    // `admin` is SUPER_ADMIN and bypasses requirePermission entirely, so every
    // other test in this file would pass with a misspelt permission string.
    const operator = { authorization: `Bearer ${await loginAs(app, 'RB0001', 'Test@1234')}` };

    expect((await reveal(inst.id, operator)).statusCode).toBe(403);
    expect((await setToken(inst.id, `OPERATOR-${'x'.repeat(30)}`, operator)).statusCode).toBe(403);

    // The refused reveal left no audit row — a 403 is not a view.
    const rows = await prisma.auditTrail.findMany({
      where: { action: 'INSTRUMENT_TOKEN_VIEWED', targetId: inst.id },
    });
    expect(rows).toHaveLength(0);

    auth = { authorization: `Bearer ${await loginAs(app)}` };
  });

  // THE POINT OF THIS TEST: the password is required when the `action-reauth`
  // policy does NOT cover the acting role — the state of a stock install, and
  // the state this suite's other tests would otherwise run in without noticing.
  //
  // Until 2026-08-06 all three token endpoints used the admin-configurable
  // `enforceReauth`, so an installation that never opened the policy page handed
  // out live device credentials on INSTRUMENT_UPDATE alone. The D5 reversal was
  // granted on three compensating controls (encrypted at rest, re-auth, audited);
  // one of them being opt-in meant most installs had two. `enforceReauthAlways`
  // is what makes it three everywhere, and this test is what keeps it that way:
  // a regression to `enforceReauth` turns these assertions red rather than
  // passing on someone's configured dev box.
  it('demands the password when the action-reauth policy does not cover the role — the gate is not opt-in', async () => {
    const inst = await newInstrument('REAUTH');
    const before = await prisma.systemConfig.findUnique({ where: { configKey: 'action-reauth' } });
    const previous = (before?.configValue as Record<string, unknown>) ?? {};

    // A policy row that EXISTS and deliberately does not enable these actions
    // for this suite's role — stronger than deleting the row, and
    // non-destructive, which matters because `compliance_core_db_test` is
    // shared: deleting a global config row mid-run would turn re-auth silently
    // off for anything else executing at the same time, and a crash between the
    // delete and the restore would leave it off permanently.
    //
    // The `REGENERATE_INSTRUMENT_TOKEN: ['VIEWER']` entry is the sharpest part
    // of the fixture and is deliberate, not leftover. Under the old
    // `enforceReauth`, `isReauthRequired('REGENERATE_INSTRUMENT_TOKEN',
    // 'SUPER_ADMIN')` reads that array, does not find this suite's role, and
    // returns "no password needed" — so the pre-change code passes the
    // regenerate assertions below with no password. Under
    // `enforceReauthAlways` the config is never consulted and it 401s. (The key
    // is also no longer in `REAUTH_ACTIONS`; it is written here as a raw string
    // precisely to prove an orphaned policy row cannot re-open the gate.)
    const policy = { ...previous, REGENERATE_INSTRUMENT_TOKEN: ['VIEWER'] };
    delete (policy as Record<string, unknown>).REVEAL_INSTRUMENT_TOKEN;
    delete (policy as Record<string, unknown>).SET_INSTRUMENT_TOKEN;
    await prisma.systemConfig.upsert({
      where: { configKey: 'action-reauth' },
      create: { configKey: 'action-reauth', configType: 'SYSTEM', configValue: policy as never },
      update: { configValue: policy as never },
    });
    invalidateReauthCache();
    try {
      // Sanity: the live policy really does not cover these actions, so a 401
      // below cannot come from a leftover config row. Without this the test
      // could pass for the wrong reason on a machine whose dev DB happens to
      // enable them.
      const live = await getActionReauthConfig();
      expect(live.REVEAL_INSTRUMENT_TOKEN).toBeUndefined();
      expect(live.SET_INSTRUMENT_TOKEN).toBeUndefined();

      // No password at all.
      const bare = await app.inject({ method: 'GET', url: `/api/instruments/${inst.id}/token`, headers: auth });
      expect(bare.statusCode).toBe(401);
      expect(bare.json().error).toBe('REAUTH_REQUIRED');

      // Wrong password.
      const wrong = await app.inject({
        method: 'GET', url: `/api/instruments/${inst.id}/token`,
        headers: { ...auth, 'x-reauth-password': 'not-the-password' },
      });
      expect(wrong.statusCode).toBe(401);

      // A refused reveal is not a view: no audit row, and no token in the body.
      expect(bare.json().token).toBeUndefined();
      const rows = await prisma.auditTrail.findMany({
        where: { action: 'INSTRUMENT_TOKEN_VIEWED', targetId: inst.id },
      });
      expect(rows).toHaveLength(0);

      // Set is gated the same way.
      const set = await app.inject({
        method: 'PUT', url: `/api/instruments/${inst.id}/token`, headers: auth,
        payload: { token: `GATED-${'x'.repeat(30)}` },
      });
      expect(set.statusCode).toBe(401);
      expect(set.json().error).toBe('REAUTH_REQUIRED');

      // Regenerate is gated the same way, and this is the assertion the old
      // `enforceReauth` would have passed: the policy above names this action
      // for VIEWER only, so the configurable gate would have waved a SUPER_ADMIN
      // straight through and handed back a live plaintext credential.
      const regen = await app.inject({
        method: 'POST', url: `/api/instruments/${inst.id}/regenerate-token`, headers: auth,
      });
      expect(regen.statusCode).toBe(401);
      expect(regen.json().error).toBe('REAUTH_REQUIRED');
      expect(regen.json().action).toBe('REGENERATE_INSTRUMENT_TOKEN');
      // The 200 body is what makes this endpoint the sharpest of the three.
      expect(regen.json().token).toBeUndefined();

      const regenWrong = await app.inject({
        method: 'POST', url: `/api/instruments/${inst.id}/regenerate-token`,
        headers: { ...auth, 'x-reauth-password': 'not-the-password' },
      });
      expect(regenWrong.statusCode).toBe(401);

      // A refused regeneration revoked nothing.
      expect(await prisma.auditTrail.count({
        where: { action: 'INSTRUMENT_TOKEN_REGENERATED', targetId: inst.id },
      })).toBe(0);

      // No refusal touched the credential: the original token still works.
      expect((await ingest(inst.token)).statusCode).toBe(200);

      // With the right password all three go through — the gate is a password
      // check, not a blanket refusal.
      expect((await reveal(inst.id)).statusCode).toBe(200);
      expect((await setToken(inst.id, `PASSED-${'x'.repeat(30)}`)).statusCode).toBe(200);
      expect((await regenerate(inst.id)).statusCode).toBe(200);
    } finally {
      // Put the original policy back byte-for-byte; if there was no row before,
      // remove the one this test created.
      if (before) {
        await prisma.systemConfig.update({
          where: { configKey: 'action-reauth' }, data: { configValue: previous as never },
        });
      } else {
        await prisma.systemConfig.deleteMany({ where: { configKey: 'action-reauth' } });
      }
      invalidateReauthCache();
    }
  });

  it('requires authentication at all', async () => {
    const inst = await newInstrument('ANON');
    expect((await app.inject({ method: 'GET', url: `/api/instruments/${inst.id}/token` })).statusCode).toBe(401);
    expect((await app.inject({
      method: 'PUT', url: `/api/instruments/${inst.id}/token`, payload: { token: `A${'x'.repeat(40)}` },
    })).statusCode).toBe(401);
  });
});
