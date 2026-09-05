import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs } from './test-helper.js';
import { setDownlinkPublisher } from '../modules/instruments/attribute-downlink.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';

/**
 * The gateway's child attribute CHANGE event (2026-09-05) —
 * `instruments/<gw>/children/attributes`:
 *
 *   - an attribute change on a child publishes ONE message, NOT retained,
 *     carrying that child alone with its complete set and the key;
 *   - the per-child retained slot still publishes beside it;
 *   - link, unlink and a gateway's own edit publish NOTHING here;
 *   - a standalone instrument's edit publishes nothing here either.
 *
 * Same capture as the roster and per-child downlink e2e — including the
 * publish OPTIONS, because "not retained" is the whole point.
 */

let app: FastifyInstance;
let auth: Record<string, string>;
const created: string[] = [];

interface Sent { topic: string; payload: string; retain: boolean }
let sent: Sent[] = [];
const eventsFor = (gwCode: string) => sent.filter((s) => s.topic === `instruments/${gwCode}/children/attributes`);

beforeAll(async () => {
  app = await buildApp();
  auth = { authorization: `Bearer ${await loginAs(app)}` };
  setDownlinkPublisher(async (topic, payload, options) => { sent.push({ topic, payload, retain: options.retain }); });
});

afterAll(async () => {
  setDownlinkPublisher(null);
  for (const id of created.reverse()) {
    await app.inject({ method: 'DELETE', url: `/api/instruments/${id}`, headers: auth });
  }
  await app.close();
});

beforeEach(() => { sent = []; });

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const reauth = { 'x-reauth-password': 'Admin@123' };

async function mk(payload: Record<string, unknown>) {
  const res = await app.inject({
    method: 'POST', url: '/api/instruments', headers: auth,
    payload: { profileId: await fixtureProfileId('fixture:child-attributes-bundle'), ...payload },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { id: string; code: string };
  created.push(body.id);
  return body;
}
async function setAttr(id: string, key: string, value: string) {
  const res = await app.inject({
    method: 'POST', url: `/api/instruments/${id}/attributes`, headers: { ...auth, ...reauth },
    payload: { key, value, reason: 'change e2e' },
  });
  expect([200, 201]).toContain(res.statusCode);
}
async function put(id: string, payload: Record<string, unknown>) {
  const res = await app.inject({ method: 'PUT', url: `/api/instruments/${id}`, headers: { ...auth, ...reauth }, payload });
  expect(res.statusCode).toBe(200);
}

describe('the child attribute change event', () => {
  it('publishes ONE non-retained message carrying the child\'s code and ONLY the key that changed', async () => {
    const u = uniq();
    const gw = await mk({ code: `BGW-${u}`, name: 'gw', isGateway: true });
    const a = await mk({ code: `BA-${u}`, name: 'a', gatewayId: gw.id });
    const b = await mk({ code: `BB-${u}`, name: 'b', gatewayId: gw.id });
    await setAttr(a.id, 'High Temperature Limit', '25');
    await setAttr(b.id, 'High Temperature Limit', '27');
    sent = [];

    await setAttr(b.id, 'Location', 'HPLC Room');

    const events = eventsFor(gw.code);
    expect(events).toHaveLength(1);
    expect(events[0].retain).toBe(false);
    const body = JSON.parse(events[0].payload);
    expect(body.gateway).toBe(gw.code);
    // Only B, and only Location — not its High Temperature Limit, not A.
    expect(body.devices).toEqual([{ devN: b.code, Location: 'HPLC Room' }]);
    // No `changed`, no `ts` — the message is the change and nothing else.
    expect(Object.keys(body).sort()).toEqual(['devices', 'gateway']);
    // The per-child slot published too, retained.
    const slot = sent.find((s) => s.topic === `instruments/${gw.code}/attributes/${b.code}`);
    expect(slot?.retain).toBe(true);
  });

  it('publishes nothing on link or unlink — membership is the roster\'s', async () => {
    const u = uniq();
    const gw = await mk({ code: `BGW2-${u}`, name: 'gw', isGateway: true });
    const c = await mk({ code: `BC-${u}`, name: 'c' });
    await setAttr(c.id, 'Location', 'Stability');
    sent = [];
    await put(c.id, { gatewayId: gw.id });
    await put(c.id, { gatewayId: null });
    expect(eventsFor(gw.code)).toEqual([]);
    expect(sent.some((s) => s.topic === `instruments/${gw.code}/children`)).toBe(true);
  });

  it('publishes nothing for a gateway\'s OWN attribute, nor for a standalone instrument', async () => {
    const u = uniq();
    const gw = await mk({ code: `BGW3-${u}`, name: 'gw', isGateway: true });
    const s = await mk({ code: `BS-${u}`, name: 's' });
    sent = [];
    await setAttr(gw.id, 'site', 'Plant 2');
    await setAttr(s.id, 'Location', 'Anywhere');
    expect(sent.some((x) => x.topic.endsWith('/children/attributes'))).toBe(false);
    expect(sent.some((x) => x.topic === `instruments/${gw.code}/attributes`)).toBe(true);
    expect(sent.some((x) => x.topic === `instruments/${s.code}/attributes`)).toBe(true);
  });
});
