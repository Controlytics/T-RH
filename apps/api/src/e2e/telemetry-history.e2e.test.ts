import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp, loginAs } from './test-helper.js';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { invalidateRolePermsCache } from '../plugins/rbac.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';

/**
 * GET /api/instruments/telemetry-history — the Instruments page's history
 * widget (2026-09-05): the merged, paged readings of several instruments.
 *
 * Asserted over HTTP (`app.inject`), never off the repository's return value:
 * Fastify strips any response field the schema does not declare, and `values`
 * is an object of arbitrary keys — exactly the shape that vanishes silently.
 *
 * Every seeded instant is inside the last 24 hours: `instrument_telemetry_history`
 * is partitioned by `ts` and the test database only carries partitions around
 * now, so a fixed date fails with "no partition of relation … found for row".
 */

let app: FastifyInstance;
let auth: Record<string, string>;
const created: string[] = [];
const s = Date.now();
/** Base instant, well inside an existing partition. */
const t0 = Date.now() - 24 * 3_600_000;
/** An instant `min` minutes after the base, as the API will echo it. */
const at = (min: number) => new Date(t0 + min * 60_000).toISOString();

beforeAll(async () => {
  app = await buildApp();
  auth = { authorization: `Bearer ${await loginAs(app)}` };
});

afterAll(async () => {
  for (const id of created) await app.inject({ method: 'DELETE', url: `/api/instruments/${id}`, headers: auth });
  await app.close();
});

async function createInstrument(code: string) {
  const res = await app.inject({
    method: 'POST', url: '/api/instruments', headers: auth,
    payload: { name: code, code, profileId: await fixtureProfileId('fixture:telemetry-history') },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { id: string; token: string };
  created.push(body.id);
  return body;
}

/** Write readings straight into history at chosen instants, in one INSERT. */
async function seed(instrumentId: string, rows: { key: string; value: unknown; ts: string }[]) {
  const values = Prisma.join(rows.map((r) => Prisma.sql`(
    ${instrumentId}, ${r.key}, ${JSON.stringify(r.value)}::jsonb,
    ${typeof r.value === 'number' ? 'number' : 'string'}, ${new Date(r.ts)})`));
  await prisma.$executeRaw`
    INSERT INTO instrument_telemetry_history (instrument_id, key, value, value_type, ts)
    VALUES ${values}
    ON CONFLICT (instrument_id, key, ts) DO NOTHING`;
}

async function history(qs: string) {
  return app.inject({ method: 'GET', url: `/api/instruments/telemetry-history?${qs}`, headers: auth });
}

/** The POST twin (performance audit WA-26 / G1-05, 2026-11-18): the selection in the body. */
async function historyPost(payload: Record<string, unknown>, headers: Record<string, string> = auth) {
  return app.inject({ method: 'POST', url: '/api/instruments/telemetry-history', headers, payload });
}

describe('GET /api/instruments/telemetry-history', () => {
  it('merges several instruments newest first, one row per instant with every key on it', async () => {
    const a = await createInstrument(`TH-A-${s}`);
    const b = await createInstrument(`TH-B-${s}`);
    await seed(a.id, [
      { key: 'temperature', value: 21.5, ts: at(0) },
      { key: 'humidity', value: 58, ts: at(0) },
      { key: 'temperature', value: 21.7, ts: at(60) },
    ]);
    await seed(b.id, [{ key: 'temperature', value: 'NA', ts: at(30) }]);
    const res = await history(`instrumentIds=${a.id},${b.id}&from=${at(-10)}&to=${at(120)}`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: any[]; total: number };
    expect(body.total).toBe(3);
    expect(body.data.map((r) => [r.instrumentId, r.ts])).toEqual([
      [a.id, at(60)],
      [b.id, at(30)],
      [a.id, at(0)],
    ]);
    // Both keys of one instant ride on one row, RAW — the string survives.
    expect(body.data[2].values).toEqual({ temperature: 21.5, humidity: 58 });
    expect(body.data[1].values).toEqual({ temperature: 'NA' });
  });

  it('pages by instant, and the total counts instants, not readings', async () => {
    const a = await createInstrument(`TH-PAGE-${s}`);
    await seed(a.id, [
      { key: 'temperature', value: 1, ts: at(0) },
      { key: 'humidity', value: 1, ts: at(0) },
      { key: 'temperature', value: 2, ts: at(10) },
      { key: 'humidity', value: 2, ts: at(10) },
      { key: 'temperature', value: 3, ts: at(20) },
    ]);
    const p1 = (await history(`instrumentIds=${a.id}&limit=2&offset=0`)).json();
    const p2 = (await history(`instrumentIds=${a.id}&limit=2&offset=2`)).json();
    expect(p1.total).toBe(3);
    expect(p1.data.map((r: any) => r.ts)).toEqual([at(20), at(10)]);
    // The second instant is whole on page 1: temperature AND humidity together.
    expect(p1.data[1].values).toEqual({ temperature: 2, humidity: 2 });
    expect(p2.data.map((r: any) => r.ts)).toEqual([at(0)]);
  });

  it('honours the range', async () => {
    const a = await createInstrument(`TH-RANGE-${s}`);
    await seed(a.id, [
      { key: 'temperature', value: 1, ts: at(0) },
      { key: 'temperature', value: 2, ts: at(90) },
    ]);
    const body = (await history(`instrumentIds=${a.id}&from=${at(60)}&to=${at(120)}`)).json();
    expect(body.total).toBe(1);
    expect(body.data[0].ts).toBe(at(90));
  });

  it('is a 400 for a malformed id or a reversed range, and 200/empty for an unknown one', async () => {
    const a = await createInstrument(`TH-BAD-${s}`);
    expect((await history('instrumentIds=not-a-uuid')).statusCode).toBe(400);
    expect((await history(`instrumentIds=${a.id}&from=${at(60)}&to=${at(0)}`)).statusCode).toBe(400);
    // An id that exists nowhere is indistinguishable from one out of scope:
    // absent from the rows, never an error.
    const ghost = '00000000-0000-4000-8000-000000000000';
    const body = (await history(`instrumentIds=${ghost}`)).json();
    expect(body).toEqual({ data: [], total: 0 });
  });

  it('withholds an instrument outside the caller\'s visibility scope — absent, never 403', async () => {
    const seen = await createInstrument(`TH-SEEN-${s}`);
    const hidden = await createInstrument(`TH-HIDDEN-${s}`);
    await seed(seen.id, [{ key: 'temperature', value: 1, ts: at(0) }]);
    await seed(hidden.id, [{ key: 'temperature', value: 2, ts: at(10) }]);

    // The OPERATOR role, granted INSTRUMENT_READ and scoped to ONE named
    // instrument — the same fixture user, grant and column write
    // `instrument-scope-selection.test.ts` uses. Both restored below.
    const role = await prisma.role.findFirstOrThrow({ where: { name: 'OPERATOR' } });
    const permsBefore = role.permissions as string[];
    await prisma.role.update({
      where: { id: role.id },
      data: { permissions: [...new Set([...permsBefore, 'INSTRUMENT_READ'])] },
    });
    invalidateRolePermsCache('OPERATOR');
    const scope = { locationIds: [] as string[], instrumentIds: [seen.id] };
    await prisma.roleConfig.upsert({
      where: { role: 'OPERATOR' },
      create: { role: 'OPERATOR', instrumentScope: scope as never },
      update: { instrumentScope: scope as never },
    });
    const operator = { authorization: `Bearer ${await loginAs(app, 'RB0001', 'Test@1234')}` };

    try {
      const res = await app.inject({
        method: 'GET', url: `/api/instruments/telemetry-history?instrumentIds=${seen.id},${hidden.id}`, headers: operator,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(1);
      expect(body.data.map((r: any) => r.instrumentId)).toEqual([seen.id]);
      // The POST answers the OPERATOR identically — the same visibility, applied once, in one implementation.
      const posted = await historyPost({ instrumentIds: [seen.id, hidden.id] }, operator);
      expect(posted.statusCode).toBe(200);
      expect(posted.json()).toEqual(body);
      // And the unrestricted caller sees both — the withholding is the scope's.
      const all = (await history(`instrumentIds=${seen.id},${hidden.id}`)).json();
      expect(all.total).toBe(2);
    } finally {
      await prisma.roleConfig.updateMany({ where: { role: 'OPERATOR' }, data: { instrumentScope: Prisma.DbNull } });
      await prisma.role.update({ where: { id: role.id }, data: { permissions: permsBefore as never } });
      invalidateRolePermsCache('OPERATOR');
    }
  });
});

describe('POST /api/instruments/telemetry-history — the same answer, the selection in the body', () => {
  it('answers exactly as the GET for the same selection — rows, values, paging and the total', async () => {
    const a = await createInstrument(`TH-POST-A-${s}`);
    const b = await createInstrument(`TH-POST-B-${s}`);
    await seed(a.id, [
      { key: 'temperature', value: 21.5, ts: at(0) },
      { key: 'humidity', value: 58, ts: at(0) },
      { key: 'pressure', value: 1013, ts: at(5) },
      { key: 'temperature', value: 21.7, ts: at(60) },
    ]);
    await seed(b.id, [{ key: 'temperature', value: 'NA', ts: at(30) }]);
    for (const [qs, body] of [
      [`instrumentIds=${a.id},${b.id}&from=${at(-10)}&to=${at(120)}`, { instrumentIds: [a.id, b.id], from: at(-10), to: at(120) }],
      [`instrumentIds=${a.id},${b.id}&limit=2&offset=1`, { instrumentIds: [a.id, b.id], limit: 2, offset: 1 }],
      [`instrumentIds=${a.id},${b.id}&keys=temperature,humidity`, { instrumentIds: [a.id, b.id], keys: ['temperature', 'humidity'] }],
    ] as const) {
      const viaGet = await history(qs);
      const viaPost = await historyPost(body as Record<string, unknown>);
      expect(viaPost.statusCode).toBe(200);
      expect(viaPost.json()).toEqual(viaGet.json());
    }
    // And the keys filter really narrowed it: the pressure-only instant is not a row.
    const narrowed = (await historyPost({ instrumentIds: [a.id, b.id], keys: ['temperature', 'humidity'] })).json();
    expect(narrowed.total).toBe(3);
  });

  it('takes a selection too long for any URL — 450 ids, the one that answered HTTP 431', async () => {
    const a = await createInstrument(`TH-POST-MANY-${s}`);
    await seed(a.id, [{ key: 'temperature', value: 7, ts: at(0) }]);
    const ghosts = Array.from({ length: 449 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const res = await historyPost({ instrumentIds: [...ghosts, a.id] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: 1, data: [{ instrumentId: a.id }] });
  });

  it('refuses more than 2,000 instruments on BOTH routes — a 400, never a silent cut', async () => {
    const ids = Array.from({ length: 2_001 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const viaPost = await historyPost({ instrumentIds: ids });
    expect(viaPost.statusCode).toBe(400);
    expect(viaPost.json().message).toMatch(/At most 2000 instruments/);
    const viaGet = await history(`instrumentIds=${ids.join(',')}`);
    expect(viaGet.statusCode).toBe(400);
    expect(viaGet.json().message).toBe(viaPost.json().message);
    // 2,000 exactly is allowed.
    expect((await historyPost({ instrumentIds: ids.slice(0, 2_000) })).statusCode).toBe(200);
  });

  it('judges the body by the GET\'s rules — a bad id, a reversed range, too many keys, an empty list', async () => {
    const a = await createInstrument(`TH-POST-BAD-${s}`);
    expect((await historyPost({ instrumentIds: ['not-a-uuid'] })).statusCode).toBe(400);
    expect((await historyPost({ instrumentIds: [a.id], from: at(60), to: at(0) })).statusCode).toBe(400);
    const keys = Array.from({ length: 21 }, (_, i) => `k${i}`);
    const tooMany = await historyPost({ instrumentIds: [a.id], keys });
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json().message).toBe((await history(`instrumentIds=${a.id}&keys=${keys.join(',')}`)).json().message);
    expect((await historyPost({ instrumentIds: [] })).statusCode).toBe(400);
    // An unknown field is DROPPED, as on every route here (Fastify's default Ajv `removeAdditional`; app.ts does not
    // override it) — it can neither widen nor change the answer.
    const extra = await historyPost({ instrumentIds: [a.id], surprise: true });
    expect(extra.statusCode).toBe(200);
    expect(extra.json()).toEqual((await historyPost({ instrumentIds: [a.id] })).json());
  });
});
