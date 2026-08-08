import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs } from './test-helper.js';
import { setDownlinkPublisher } from '../modules/instruments/attribute-downlink.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';

/**
 * Child ROSTER wiring — which route publishes a gateway's membership.
 *
 * The pure builders are covered without a broker in
 * `modules/instruments/__tests__/child-roster.test.ts`. What THIS file pins is
 * the wiring, which is where it goes wrong:
 *
 *   - every membership change republishes, including the ones with no `gatewayId`
 *     in the request body (a rename, a deactivation);
 *   - a MOVE republishes BOTH gateways, or the old one keeps naming a child
 *     someone else now owns;
 *   - a refused write publishes nothing;
 *   - deleting a gateway CLEARS its slot rather than stranding a roster of
 *     still-live instruments;
 *   - a standalone instrument's edit publishes no roster at all.
 *
 * A real broker cannot be assumed in CI, so the publisher is replaced with a
 * capture — the same fake, and the same singleton, as the attribute path.
 */

let app: FastifyInstance;
let auth: Record<string, string>;
const created: string[] = [];

interface Sent { topic: string; payload: string }
let sent: Sent[] = [];

const rosters = () => sent.filter((s) => s.topic.endsWith('/children'));
const rosterFor = (gwId: string) => rosters().filter((s) => s.topic === `instruments/${gwId}/children`);
const codesIn = (s: Sent) => (JSON.parse(s.payload).children as { code: string }[]).map((c) => c.code).sort();
/** The membership the gateway is left holding after everything this test did. */
const latestFor = (gwId: string) => {
  const all = rosterFor(gwId);
  return all.length ? all[all.length - 1] : undefined;
};

beforeAll(async () => {
  app = await buildApp();
  auth = { authorization: `Bearer ${await loginAs(app)}` };
  setDownlinkPublisher(async (topic, payload) => { sent.push({ topic, payload }); });
});

afterAll(async () => {
  // Module-level singleton: `test-helper.ts` builds several apps in one
  // process, so an installed publisher would leak into the next file.
  setDownlinkPublisher(null);
  for (const id of created.reverse()) {
    await app.inject({ method: 'DELETE', url: `/api/instruments/${id}`, headers: auth });
  }
  await app.close();
});

beforeEach(() => { sent = []; });

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function mk(payload: Record<string, unknown>) {
  const res = await app.inject({
    method: 'POST', url: '/api/instruments', headers: auth,
    payload: { profileId: await fixtureProfileId('fixture:instrument-child-roster'), ...payload },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { id: string; code: string };
  created.push(body.id);
  return body;
}
const put = (id: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'PUT', url: `/api/instruments/${id}`, headers: auth, payload });
const del = (id: string) =>
  app.inject({ method: 'DELETE', url: `/api/instruments/${id}`, headers: auth });

describe('child roster — membership changes', () => {
  it('publishes an EMPTY roster when a gateway is created', async () => {
    const gw = await mk({ name: 'RGW', code: `RGW-${uniq()}`, isGateway: true });
    const r = rosterFor(gw.id);
    expect(r).toHaveLength(1);
    // Explicit "no children" — a gateway must be able to tell that from a
    // broker that lost the message.
    expect(JSON.parse(r[0].payload).children).toEqual([]);
  });

  it('republishes when an instrument is BORN linked', async () => {
    const gw = await mk({ name: 'RGW2', code: `RGW2-${uniq()}`, isGateway: true });
    sent = [];
    const kid = await mk({ name: 'RK', code: `RK-${uniq()}`, gatewayId: gw.id });

    expect(rosterFor(gw.id)).toHaveLength(1);
    expect(codesIn(latestFor(gw.id)!)).toEqual([kid.code]);
  });

  it('republishes on link and on unlink', async () => {
    const gw = await mk({ name: 'RGW3', code: `RGW3-${uniq()}`, isGateway: true });
    const kid = await mk({ name: 'RK3', code: `RK3-${uniq()}` });

    sent = [];
    expect((await put(kid.id, { gatewayId: gw.id })).statusCode).toBe(200);
    expect(codesIn(latestFor(gw.id)!)).toEqual([kid.code]);

    sent = [];
    expect((await put(kid.id, { gatewayId: null })).statusCode).toBe(200);
    expect(codesIn(latestFor(gw.id)!)).toEqual([]);
  });

  // The failure this catches: publishing only the NEW gateway leaves the old
  // one retaining a roster that names a child it no longer owns — and retained,
  // so it survives every restart.
  it('republishes BOTH gateways on a move', async () => {
    const a = await mk({ name: 'RGWA', code: `RGWA-${uniq()}`, isGateway: true });
    const b = await mk({ name: 'RGWB', code: `RGWB-${uniq()}`, isGateway: true });
    const kid = await mk({ name: 'RKM', code: `RKM-${uniq()}`, gatewayId: a.id });

    sent = [];
    expect((await put(kid.id, { gatewayId: b.id })).statusCode).toBe(200);

    expect(codesIn(latestFor(a.id)!)).toEqual([]);
    expect(codesIn(latestFor(b.id)!)).toEqual([kid.code]);
  });

  // `name` and `isActive` are IN the payload, so an edit that carries no
  // `gatewayId` at all still has to republish the child's current parent.
  it('republishes on a child rename and on a deactivation', async () => {
    const gw = await mk({ name: 'RGW4', code: `RGW4-${uniq()}`, isGateway: true });
    const kid = await mk({ name: 'Before', code: `RK4-${uniq()}`, gatewayId: gw.id });

    sent = [];
    expect((await put(kid.id, { name: 'After' })).statusCode).toBe(200);
    expect(JSON.parse(latestFor(gw.id)!.payload).children).toEqual([
      { code: kid.code, name: 'After', isActive: true },
    ]);

    sent = [];
    expect((await put(kid.id, { isActive: false })).statusCode).toBe(200);
    // Present and flagged, not dropped: a deactivated child is still this
    // gateway's responsibility, an unlinked one is not.
    expect(JSON.parse(latestFor(gw.id)!.payload).children).toEqual([
      { code: kid.code, name: 'After', isActive: false },
    ]);
  });

  it('republishes when a child is deleted', async () => {
    const gw = await mk({ name: 'RGW5', code: `RGW5-${uniq()}`, isGateway: true });
    const keep = await mk({ name: 'Keep', code: `RKEEP-${uniq()}`, gatewayId: gw.id });
    const drop = await mk({ name: 'Drop', code: `RDROP-${uniq()}`, gatewayId: gw.id });

    sent = [];
    expect((await del(drop.id)).statusCode).toBe(200);
    created.splice(created.indexOf(drop.id), 1);

    expect(codesIn(latestFor(gw.id)!)).toEqual([keep.code]);
  });
});

describe('child roster — clearing', () => {
  // A stranded roster is worse than a stranded attribute slot: it NAMES
  // instruments that are still live and have just been orphaned.
  it('clears the slot with a zero-byte retained publish when a gateway is deleted', async () => {
    const gw = await mk({ name: 'RGWD', code: `RGWD-${uniq()}`, isGateway: true });
    await mk({ name: 'RKD', code: `RKD-${uniq()}`, gatewayId: gw.id });

    sent = [];
    expect((await del(gw.id)).statusCode).toBe(200);
    created.splice(created.indexOf(gw.id), 1);

    const r = rosterFor(gw.id);
    expect(r).toHaveLength(1);
    expect(r[0].payload).toBe('');
  });

  it('clears the slot when gateway mode is turned off', async () => {
    const gw = await mk({ name: 'RGWX', code: `RGWX-${uniq()}`, isGateway: true });

    sent = [];
    expect((await put(gw.id, { isGateway: false })).statusCode).toBe(200);

    expect(rosterFor(gw.id)).toHaveLength(1);
    expect(rosterFor(gw.id)[0].payload).toBe('');
  });
});

describe('child roster — what must NOT publish', () => {
  it('publishes nothing for a standalone instrument', async () => {
    const solo = await mk({ name: 'RSOLO', code: `RSOLO-${uniq()}` });
    sent = [];
    expect((await put(solo.id, { name: 'Renamed' })).statusCode).toBe(200);
    expect(rosters()).toEqual([]);
  });

  // A device must never be told about a change the platform refused.
  it('publishes nothing when the write is refused', async () => {
    const gw = await mk({ name: 'RGWR', code: `RGWR-${uniq()}`, isGateway: true });
    const kid = await mk({ name: 'RKR', code: `RKR-${uniq()}`, gatewayId: gw.id });

    sent = [];
    // NESTED_GATEWAY: a child cannot also be a gateway.
    expect((await put(kid.id, { isGateway: true })).statusCode).toBe(400);
    expect(rosters()).toEqual([]);

    sent = [];
    expect((await put('11111111-1111-1111-1111-111111111111', { name: 'X' })).statusCode).toBe(404);
    expect(rosters()).toEqual([]);
  });

  it('does not fail the operator\'s write when the broker refuses', async () => {
    const gw = await mk({ name: 'RGWF', code: `RGWF-${uniq()}`, isGateway: true });
    const kid = await mk({ name: 'RKF', code: `RKF-${uniq()}` });

    setDownlinkPublisher(async () => { throw new Error('broker down'); });
    try {
      // The link is durable whatever the broker does — the database is the
      // source of truth and the roster is only a delivery mechanism.
      expect((await put(kid.id, { gatewayId: gw.id })).statusCode).toBe(200);
      const check = await app.inject({ method: 'GET', url: `/api/instruments/${gw.id}/children`, headers: auth });
      expect((check.json() as { data: { code: string }[] }).data.map((c) => c.code)).toEqual([kid.code]);
    } finally {
      setDownlinkPublisher(async (topic, payload) => { sent.push({ topic, payload }); });
    }
  });
});
