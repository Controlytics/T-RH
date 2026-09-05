import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs } from './test-helper.js';
import { setDownlinkPublisher } from '../modules/instruments/attribute-downlink.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';

/**
 * The whole-gateway attribute BUNDLE wiring (2026-09-05) — which routes
 * publish `instruments/<gw>/children/attributes`, and what it holds.
 *
 * Same capture as the roster and per-child downlink e2e: the publisher is a
 * fake, so these assert on what was HANDED to the broker, not on a broker.
 *
 *   - an attribute change on a child republishes the bundle with EVERY child's
 *     complete set and names the change;
 *   - the per-child slot still publishes too — the bundle is beside it, not
 *     instead of it;
 *   - link and unlink republish it (membership is part of the set);
 *   - deleting a gateway clears it with a zero-byte retained publish;
 *   - a standalone instrument's edit publishes no bundle at all.
 */

let app: FastifyInstance;
let auth: Record<string, string>;
const created: string[] = [];

interface Sent { topic: string; payload: string }
let sent: Sent[] = [];
const bundlesFor = (gwCode: string) => sent.filter((s) => s.topic === `instruments/${gwCode}/children/attributes`);
const latestBundle = (gwCode: string) => {
  const all = bundlesFor(gwCode);
  return all.length ? JSON.parse(all[all.length - 1].payload) : undefined;
};

beforeAll(async () => {
  app = await buildApp();
  auth = { authorization: `Bearer ${await loginAs(app)}` };
  setDownlinkPublisher(async (topic, payload) => { sent.push({ topic, payload }); });
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
    payload: { key, value, reason: 'bundle e2e' },
  });
  expect([200, 201]).toContain(res.statusCode);
}
async function put(id: string, payload: Record<string, unknown>) {
  const res = await app.inject({ method: 'PUT', url: `/api/instruments/${id}`, headers: { ...auth, ...reauth }, payload });
  expect(res.statusCode).toBe(200);
}

describe('the child attributes bundle', () => {
  it('republishes the WHOLE set, naming the change, when one child\'s attribute moves — beside the per-child slot', async () => {
    const u = uniq();
    const gw = await mk({ code: `BGW-${u}`, name: 'gw', isGateway: true });
    const a = await mk({ code: `BA-${u}`, name: 'a', gatewayId: gw.id });
    const b = await mk({ code: `BB-${u}`, name: 'b', gatewayId: gw.id });
    await setAttr(a.id, 'High Temperature Limit', '25');
    sent = [];

    await setAttr(b.id, 'Location', 'HPLC Room');

    const bundle = latestBundle(gw.code);
    expect(bundle).toBeDefined();
    expect(bundle.gateway).toBe(gw.code);
    const block = (code: string) => bundle.devices.find((d: { devN: string }) => d.devN === code);
    expect(bundle.devices.map((d: { devN: string }) => d.devN).sort()).toEqual([a.code, b.code].sort());
    // Every child's COMPLETE set as plain keys, not just the one that changed.
    expect(block(a.code)['High Temperature Limit']).toBe('25');
    expect(block(b.code)['Location']).toBe('HPLC Room');
    expect(bundle.changed).toEqual({ devN: b.code, key: 'Location', value: 'HPLC Room' });
    // The per-child slot published too.
    expect(sent.some((s) => s.topic === `instruments/${gw.code}/attributes/${b.code}`)).toBe(true);
  });

  it('republishes on link (the new child appears) and on unlink (it goes)', async () => {
    const u = uniq();
    const gw = await mk({ code: `BGW2-${u}`, name: 'gw', isGateway: true });
    const c = await mk({ code: `BC-${u}`, name: 'c' });
    await setAttr(c.id, 'Location', 'Stability');
    sent = [];

    await put(c.id, { gatewayId: gw.id });
    let bundle = latestBundle(gw.code);
    expect(bundle.devices).toEqual([expect.objectContaining({ devN: c.code, Location: 'Stability' })]);
    expect(bundle.changed).toBeNull();

    sent = [];
    await put(c.id, { gatewayId: null });
    bundle = latestBundle(gw.code);
    expect(bundle.devices).toEqual([]);
  });

  it('clears the slot with a zero-byte retained publish when the gateway is deleted', async () => {
    const u = uniq();
    const gw = await mk({ code: `BGW3-${u}`, name: 'gw', isGateway: true });
    sent = [];
    const res = await app.inject({ method: 'DELETE', url: `/api/instruments/${gw.id}`, headers: { ...auth, ...reauth } });
    expect(res.statusCode).toBe(200);
    created.splice(created.indexOf(gw.id), 1);
    const all = bundlesFor(gw.code);
    expect(all.length).toBeGreaterThan(0);
    expect(all[all.length - 1].payload).toBe('');
  });

  it('publishes NO bundle for a standalone instrument\'s edit', async () => {
    const u = uniq();
    const s = await mk({ code: `BS-${u}`, name: 's' });
    sent = [];
    await setAttr(s.id, 'Location', 'Anywhere');
    expect(sent.some((x) => x.topic.endsWith('/children/attributes'))).toBe(false);
    // Its own slot still publishes.
    expect(sent.some((x) => x.topic === `instruments/${s.code}/attributes`)).toBe(true);
  });
});
