import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { setDownlinkPublisher } from '../modules/instruments/attribute-downlink.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';

/**
 * Changing an instrument's CODE (2026-09-16, operator: "in settings Instrument
 * id should be changable"). The code is the MQTT client id and every topic
 * segment, so a rename is not a label edit: the device must reconnect with the
 * new id, and every RETAINED slot keyed on the old code on the broker would
 * otherwise read as current state to anyone looking. This file pins what the
 * platform does about that, over a captured publisher:
 *
 *   - the old attribute slot is CLEARED (empty retained publish) and the
 *     complete set is republished under the new code;
 *   - a child's parent roster is republished naming the new code;
 *   - a gateway's own roster moves and each child's slot moves with it;
 *   - name follows the code when it WAS the code (the 2026-09-04 rule);
 *   - a duplicate is a 409, as on create. (No wildcard rule: removed on
 *     2026-09-16 at the operator's instruction.)
 */
let app: FastifyInstance;
let auth: Record<string, string>;
let profileId: string;
const created: string[] = [];

interface Sent { topic: string; payload: string; options: { retain: boolean } }
let sent: Sent[] = [];

beforeAll(async () => {
  app = await buildApp();
  auth = { authorization: `Bearer ${await loginAs(app)}` };
  profileId = await fixtureProfileId('fixture:instrument-rename');
  setDownlinkPublisher(async (topic, payload, options) => {
    sent.push({ topic, payload, options: options as { retain: boolean } });
  });
});

afterAll(async () => {
  setDownlinkPublisher(null);
  // Children before parents: the FK is RESTRICT.
  for (const id of [...created].reverse()) {
    await app.inject({ method: 'DELETE', url: `/api/instruments/${id}`, headers: auth });
  }
  await app.close();
});

beforeEach(() => { sent = []; });

async function mk(payload: Record<string, unknown>): Promise<{ id: string; code: string }> {
  const res = await app.inject({
    method: 'POST', url: '/api/instruments', headers: auth,
    payload: { profileId, ...payload },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  created.push(body.id);
  return body;
}
const put = (id: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'PUT', url: `/api/instruments/${id}`, headers: auth, payload });
const setAttr = (id: string, key: string, value: string) =>
  app.inject({ method: 'POST', url: `/api/instruments/${id}/attributes`, headers: auth, payload: { key, value } });
const topics = (pred: (s: Sent) => boolean) => sent.filter(pred);

describe('PUT /api/instruments/:id — code', () => {
  it('renames a standalone instrument: name follows, the old slot is cleared, the new one carries the set', async () => {
    const stamp = Date.now();
    const a = await mk({ name: `RN-${stamp}`, code: `RN-${stamp}` });
    await setAttr(a.id, 'Building', 'CWH');
    sent = [];

    const res = await put(a.id, { code: `RN-${stamp}-B` });
    expect(res.statusCode).toBe(200);
    expect(res.json().code).toBe(`RN-${stamp}-B`);
    // The 2026-09-04 rule: name = code on every instrument. A rename keeps it so.
    expect(res.json().name).toBe(`RN-${stamp}-B`);

    const cleared = topics((s) => s.topic === `instruments/RN-${stamp}/attributes`);
    expect(cleared).toHaveLength(1);
    expect(cleared[0].payload).toBe('');
    expect(cleared[0].options.retain).toBe(true);

    const moved = topics((s) => s.topic === `instruments/RN-${stamp}-B/attributes`);
    expect(moved).toHaveLength(1);
    expect(JSON.parse(moved[0].payload).attributes).toEqual({ Building: 'CWH' });

    // The old client id is refused from now on — the identity the auth hook
    // compares against is the row's code.
    const row = await prisma.instrument.findUnique({ where: { id: a.id }, select: { code: true } });
    expect(row?.code).toBe(`RN-${stamp}-B`);
  });

  it('keeps an explicitly different name when the name was NOT the code', async () => {
    const stamp = Date.now();
    const a = await mk({ name: 'Chiller A', code: `RN2-${stamp}` });
    const res = await put(a.id, { code: `RN2-${stamp}-B` });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Chiller A');
  });

  it('renaming a CHILD moves its slot under the gateway and republishes the parent roster', async () => {
    const stamp = Date.now();
    const gw = await mk({ name: `GW-${stamp}`, code: `GW-${stamp}`, isGateway: true });
    const kid = await mk({ name: `K-${stamp}`, code: `K-${stamp}`, gatewayId: gw.id });
    await setAttr(kid.id, 'Room', '101');
    sent = [];

    const res = await put(kid.id, { code: `K-${stamp}-B` });
    expect(res.statusCode).toBe(200);

    expect(topics((s) => s.topic === `instruments/GW-${stamp}/attributes/K-${stamp}` && s.payload === '')).toHaveLength(1);
    const moved = topics((s) => s.topic === `instruments/GW-${stamp}/attributes/K-${stamp}-B`);
    expect(moved).toHaveLength(1);
    expect(JSON.parse(moved[0].payload).attributes).toEqual({ Room: '101' });

    const roster = topics((s) => s.topic === `instruments/GW-${stamp}/children`);
    expect(roster.length).toBeGreaterThanOrEqual(1);
    const last = JSON.parse(roster[roster.length - 1].payload) as { children: { code: string }[] };
    expect(last.children.map((c) => c.code)).toEqual([`K-${stamp}-B`]);
  });

  it('renaming a GATEWAY moves its roster and every child slot', async () => {
    const stamp = Date.now();
    const gw = await mk({ name: `GW2-${stamp}`, code: `GW2-${stamp}`, isGateway: true });
    const kid = await mk({ name: `K2-${stamp}`, code: `K2-${stamp}`, gatewayId: gw.id });
    await setAttr(kid.id, 'Room', '202');
    sent = [];

    const res = await put(gw.id, { code: `GW2-${stamp}-B` });
    expect(res.statusCode).toBe(200);

    // Old roster cleared, new roster published naming the child.
    expect(topics((s) => s.topic === `instruments/GW2-${stamp}/children` && s.payload === '')).toHaveLength(1);
    const roster = topics((s) => s.topic === `instruments/GW2-${stamp}-B/children` && s.payload !== '');
    expect(roster).toHaveLength(1);
    // The child's slot lived under the OLD gateway code; it moves too.
    expect(topics((s) => s.topic === `instruments/GW2-${stamp}/attributes/K2-${stamp}` && s.payload === '')).toHaveLength(1);
    const moved = topics((s) => s.topic === `instruments/GW2-${stamp}-B/attributes/K2-${stamp}`);
    expect(moved).toHaveLength(1);
    expect(JSON.parse(moved[0].payload).attributes).toEqual({ Room: '202' });
  });

  it('refuses a duplicate code (409), leaving the row unchanged', async () => {
    const stamp = Date.now();
    const a = await mk({ name: `D1-${stamp}`, code: `D1-${stamp}` });
    const b = await mk({ name: `D2-${stamp}`, code: `D2-${stamp}` });

    const dup = await put(b.id, { code: `D1-${stamp}` });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe('DUPLICATE_CODE');

    const row = await prisma.instrument.findUnique({ where: { id: b.id }, select: { code: true } });
    expect(row?.code).toBe(`D2-${stamp}`);
    expect(sent).toEqual([]);
    expect(a.code).toBe(`D1-${stamp}`);
  });

  it('a PUT that re-sends the current code publishes nothing', async () => {
    const stamp = Date.now();
    const a = await mk({ name: `S-${stamp}`, code: `S-${stamp}` });
    sent = [];
    const res = await put(a.id, { code: `S-${stamp}`, isActive: false });
    expect(res.statusCode).toBe(200);
    expect(sent).toEqual([]);
  });
});
