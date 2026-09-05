import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { setDownlinkPublisher } from '../modules/instruments/attribute-downlink.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';

/**
 * Attribute DOWNLINK wiring — the first platform→device path in this codebase.
 *
 * The pure topic/payload builders are covered without a broker in
 * `modules/instruments/__tests__/attribute-downlink.test.ts`. What THIS file
 * pins is the wiring, which is where it actually goes wrong:
 *
 *   - all three write verbs publish, and the read verb does not;
 *   - a REFUSED write publishes nothing (a device must never be told about a
 *     change the platform rejected);
 *   - the message is built from state read AFTER the commit;
 *   - a child is addressed under its gateway, a standalone on its own topic;
 *   - a broker failure does not fail the operator's write.
 *
 * A real broker cannot be assumed in CI, so the publisher is replaced with a
 * capture. The properties a fake cannot establish — that EMQX's ACL admits the
 * bridge's publish and admits a device's subscribe to its own topic but not to
 * another's — are verified live against EMQX 5.3.2 and recorded in
 * `LOCAL_SETUP_WINDOWS.md` §9B.5.
 */

let app: FastifyInstance;
let auth: Record<string, string>;
const created: string[] = [];

interface Sent { topic: string; payload: { attributes: Record<string, string>; changed: Record<string, string | null>; ts: string }; options: unknown }
let sent: Sent[] = [];
/** Set to make the fake publisher reject, simulating a broker refusal. */
let publishError: string | null = null;

beforeAll(async () => {
  app = await buildApp();
  auth = { authorization: `Bearer ${await loginAs(app)}` };
  setDownlinkPublisher(async (topic, payload, options) => {
    // ATTRIBUTE traffic only. `child-roster.ts` (2026-08-07) shares this one
    // publisher singleton and publishes on `instruments/<gw>/children` when a
    // gateway's membership changes — including from the `mk()` calls that set
    // these fixtures up. Capturing those here would make every `sent[0]` /
    // `toHaveLength(1)` assertion below depend on a subsystem this file does
    // not test. Roster wiring has its own file, `instrument-child-roster.test.ts`.
    //
    // The filter is on the topic, so an attribute publish that went to a wrong
    // topic would still be caught by the equality assertions below — it would
    // simply be absent, and `toHaveLength(1)` fails on 0 as loudly as on 2.
    // …and, since 2026-09-05, the whole-gateway BUNDLE
    // (`…/children/attributes`), which every child edit and every membership
    // change republishes. Same reasoning: it has its own file,
    // `instrument-child-attributes-bundle.test.ts`.
    if (topic.includes('/attributes') && !topic.endsWith('/children/attributes')) {
      sent.push({ topic, payload: JSON.parse(payload), options });
    }
    if (publishError) throw new Error(publishError);
  });
});

afterAll(async () => {
  // Module-level singleton: `test-helper.ts` builds several apps in one
  // process, so an installed publisher would leak into the next file.
  setDownlinkPublisher(null);
  for (const id of created) {
    await app.inject({ method: 'DELETE', url: `/api/instruments/${id}`, headers: auth });
  }
  await app.close();
});

beforeEach(() => { sent = []; publishError = null; });

async function mk(payload: Record<string, unknown>) {
  const res = await app.inject({
    method: 'POST', url: '/api/instruments', headers: auth,
    payload: { profileId: await fixtureProfileId('fixture:instrument-attribute-downlink'), ...payload },
  });
  expect(res.statusCode).toBe(201);
  created.push(res.json().id);
  return res.json() as { id: string; code: string };
}
const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const set = (id: string, key: string, value: string, reason?: string) =>
  app.inject({
    method: 'POST', url: `/api/instruments/${id}/attributes`, headers: auth,
    payload: reason ? { key, value, reason } : { key, value },
  });
// A remark is MANDATORY on any write that changes or removes a recorded value
// (2026-08-19). Not on a first fill, which is why `set` above carries none.
const REMARK = 'Downlink test — changing the recorded value';
const edit = (id: string, key: string, value: string) =>
  app.inject({ method: 'PUT', url: `/api/instruments/${id}/attributes/${encodeURIComponent(key)}`, headers: auth, payload: { value, reason: REMARK } });
const remove = (id: string, key: string) =>
  app.inject({ method: 'DELETE', url: `/api/instruments/${id}/attributes/${encodeURIComponent(key)}`, headers: auth, payload: { reason: REMARK } });

describe('attribute downlink — addressing', () => {
  it('publishes a standalone instrument on its OWN topic, QoS 1 and retained', async () => {
    const inst = await mk({ name: 'DLS', code: `DLS-${uniq()}` });
    expect((await set(inst.id, 'assetTag', 'AT-99412')).statusCode).toBe(201);

    expect(sent).toHaveLength(1);
    expect(sent[0].topic).toBe(`instruments/${inst.code}/attributes`);
    // Retain is what makes a device that was powered off during the change
    // correct on its next connect. Without it every other assertion here still
    // passes and the feature is broken for exactly the case it exists for.
    expect(sent[0].options).toEqual({ qos: 1, retain: true });
  });

  it('publishes a CHILD on its gateway\'s topic, addressed to the child', async () => {
    const s = uniq();
    const gw = await mk({ name: 'DLGW', code: `DLGW-${s}`, isGateway: true });
    const child = await mk({ name: 'DLCH', code: `DLCH-${s}`, gatewayId: gw.id });

    await set(child.id, 'assetTag', 'AT-1');
    expect(sent).toHaveLength(1);
    // A child has no broker connection of its own — nothing is subscribed to
    // `instruments/<childCode>/attributes`.
    expect(sent[0].topic).toBe(`instruments/${gw.code}/attributes/${child.code}`);
    expect(sent[0].topic).not.toBe(`instruments/${child.code}/attributes`);
  });

  it('gives two children of one gateway two DIFFERENT retained slots', async () => {
    const s = uniq();
    const gw = await mk({ name: 'DLGW2', code: `DLGW2-${s}`, isGateway: true });
    const a = await mk({ name: 'DLA', code: `DLA-${s}`, gatewayId: gw.id });
    const b = await mk({ name: 'DLB', code: `DLB-${s}`, gatewayId: gw.id });

    await set(a.id, 'k', 'va');
    await set(b.id, 'k', 'vb');
    // One shared topic would mean a reconnecting gateway is handed whichever
    // child changed last and silently loses the other. (The whole-set BUNDLE
    // beside these slots, added 2026-09-05, carries every child each time and
    // is asserted in its own e2e; the capture above excludes it.)
    expect(sent.map((m) => m.topic)).toEqual([
      `instruments/${gw.code}/attributes/${a.code}`,
      `instruments/${gw.code}/attributes/${b.code}`,
    ]);
  });

  it('a gateway\'s OWN attributes go on its own topic, not under itself', async () => {
    const gw = await mk({ name: 'DLGW3', code: `DLGW3-${uniq()}`, isGateway: true });
    await set(gw.id, 'site', 'Plant 2');
    expect(sent[0].topic).toBe(`instruments/${gw.code}/attributes`);
  });
});

describe('attribute downlink — payload', () => {
  it('carries the complete current set alongside the delta', async () => {
    const inst = await mk({ name: 'DLP', code: `DLP-${uniq()}` });
    await set(inst.id, 'assetTag', 'AT-1');
    await set(inst.id, 'calibrationDue', '2027-01-01');

    expect(sent[1].payload.attributes).toEqual({ assetTag: 'AT-1', calibrationDue: '2027-01-01' });
    expect(sent[1].payload.changed).toEqual({ calibrationDue: '2027-01-01' });
    expect(Date.parse(sent[1].payload.ts)).not.toBeNaN();
  });

  it('reflects state read AFTER the commit, not before it', async () => {
    const inst = await mk({ name: 'DLC', code: `DLC-${uniq()}` });
    await set(inst.id, 'k', 'first');
    // The second POST OVERWRITES a recorded value, so it is a change and owes a
    // remark — POST is the upsert, and the rule follows the act, not the verb.
    await set(inst.id, 'k', 'second', REMARK);
    // A message built from the pre-write read would say 'first' here.
    expect(sent[1].payload.attributes).toEqual({ k: 'second' });
    expect(sent[1].payload.changed).toEqual({ k: 'second' });
  });

  it('an EDIT publishes the new value', async () => {
    const inst = await mk({ name: 'DLE', code: `DLE-${uniq()}` });
    await set(inst.id, 'k', 'old');
    expect((await edit(inst.id, 'k', 'new')).statusCode).toBe(200);
    expect(sent).toHaveLength(2);
    expect(sent[1].payload.changed).toEqual({ k: 'new' });
    expect(sent[1].payload.attributes).toEqual({ k: 'new' });
  });

  it('a DELETE publishes null in `changed` and drops the key from `attributes`', async () => {
    const inst = await mk({ name: 'DLD', code: `DLD-${uniq()}` });
    await set(inst.id, 'assetTag', 'AT-1');
    await set(inst.id, 'calibrationDue', '2027-01-01');
    expect((await remove(inst.id, 'calibrationDue')).statusCode).toBe(200);

    const last = sent[2];
    // Both facts, in the same message: the null is how a device learns the
    // attribute was REMOVED rather than merely not mentioned.
    expect(last.payload.changed).toEqual({ calibrationDue: null });
    expect(last.payload.attributes).toEqual({ assetTag: 'AT-1' });
    expect('calibrationDue' in last.payload.attributes).toBe(false);
  });

  it('publishes the trimmed, sanitised key the server actually stored', async () => {
    const inst = await mk({ name: 'DLK', code: `DLK-${uniq()}` });
    await set(inst.id, '  Asset Tag  ', 'AT-1');
    // A device keyed on the raw operator input would never match the stored row.
    expect(sent[0].payload.changed).toEqual({ 'Asset Tag': 'AT-1' });
    expect(sent[0].payload.attributes).toEqual({ 'Asset Tag': 'AT-1' });
  });
});

describe('attribute downlink — when it must NOT publish', () => {
  it('says nothing on a READ', async () => {
    const inst = await mk({ name: 'DLR', code: `DLR-${uniq()}` });
    await app.inject({ method: 'GET', url: `/api/instruments/${inst.id}/attributes`, headers: auth });
    expect(sent).toEqual([]);
  });

  it('says nothing when the write is REFUSED', async () => {
    const inst = await mk({ name: 'DLX', code: `DLX-${uniq()}` });
    // PUT does not create: 404.
    expect((await edit(inst.id, 'never-set', 'v')).statusCode).toBe(404);
    // DELETE of an absent key: 404.
    expect((await remove(inst.id, 'never-set')).statusCode).toBe(404);
    // A value over the 1000-char bound: 400, refused before any transaction.
    expect((await set(inst.id, 'k', 'x'.repeat(1001))).statusCode).toBe(400);
    // A device told about a change the platform rejected is worse than one told
    // nothing — and the message is RETAINED, so it would survive the mistake.
    expect(sent).toEqual([]);
  });

  it('says nothing for an unknown instrument', async () => {
    const res = await set('00000000-0000-4000-8000-000000000000', 'k', 'v');
    expect(res.statusCode).toBe(404);
    expect(sent).toEqual([]);
  });

  it('says nothing when the caller is unauthenticated', async () => {
    const inst = await mk({ name: 'DLU', code: `DLU-${uniq()}` });
    const res = await app.inject({
      method: 'POST', url: `/api/instruments/${inst.id}/attributes`, payload: { key: 'k', value: 'v' },
    });
    expect(res.statusCode).toBe(401);
    expect(sent).toEqual([]);
  });
});

describe('attribute downlink — the broker is not the source of truth', () => {
  it('a publish failure does not fail the write, and the attribute is stored', async () => {
    const inst = await mk({ name: 'DLF', code: `DLF-${uniq()}` });
    publishError = 'not authorized';

    const res = await set(inst.id, 'assetTag', 'AT-7');
    // The write already committed by the time the publish was attempted.
    // Reporting an error here would invite a retry of a change that landed.
    expect(res.statusCode).toBe(201);
    expect(sent).toHaveLength(1);

    const stored = await prisma.instrumentAttribute.findMany({ where: { instrumentId: inst.id } });
    expect(stored.map((r) => [r.key, r.value])).toEqual([['assetTag', 'AT-7']]);
  });

  it('a delete still deletes when the publish fails', async () => {
    const inst = await mk({ name: 'DLF2', code: `DLF2-${uniq()}` });
    await set(inst.id, 'k', 'v');
    publishError = 'broker down';

    expect((await remove(inst.id, 'k')).statusCode).toBe(200);
    expect(await prisma.instrumentAttribute.count({ where: { instrumentId: inst.id } })).toBe(0);
  });

  it('attribute writes work with NO publisher configured at all', async () => {
    // The MQTT_BROKER_URL-unset install: there is no bridge, so there is no
    // downlink, and every attribute endpoint must behave exactly as it did
    // before this path existed.
    setDownlinkPublisher(null);
    try {
      const inst = await mk({ name: 'DLN', code: `DLN-${uniq()}` });
      expect((await set(inst.id, 'k', 'v')).statusCode).toBe(201);
      expect((await edit(inst.id, 'k', 'v2')).statusCode).toBe(200);
      expect((await remove(inst.id, 'k')).statusCode).toBe(200);
      expect(sent).toEqual([]);
    } finally {
      setDownlinkPublisher(async (topic, payload, options) => {
        sent.push({ topic, payload: JSON.parse(payload), options });
        if (publishError) throw new Error(publishError);
      });
    }
  });
});
