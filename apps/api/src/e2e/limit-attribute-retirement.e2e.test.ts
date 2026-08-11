import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp, loginAs } from './test-helper.js';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { parseInstrumentAttributeKeys } from '@digilog/shared';
import { fixtureProfileId } from '../test-support/fixture-profile.js';

/**
 * Locks in the 2026-08-11 reversal: temperature and humidity SPEC LIMITS live on
 * the room, not on the instrument.
 *
 * See docs/superpowers/specs/2026-08-11-instrument-dashboard-floorplan-design.md §3.
 */

const RETIRED_KEYS = [
  'Low Temperature Limit',
  'High Temperature Limit',
  'Low Humidity Limit',
  'High Humidity Limit',
];

let app: FastifyInstance;
let auth: Record<string, string>;
const s = Date.now();
const plans: string[] = [];
const instruments: string[] = [];

beforeAll(async () => {
  app = await buildApp();
  auth = { authorization: `Bearer ${await loginAs(app)}` };
});

afterAll(async () => {
  for (const id of instruments) {
    await app.inject({ method: 'DELETE', url: `/api/instruments/${id}`, headers: auth });
  }
  for (const id of plans) await prisma.floorplan.deleteMany({ where: { id } });
  await app.close();
});

describe('limit attributes are retired from the registration prompts', () => {
  it('no profile asks for any of the four limit keys', async () => {
    const profiles = await prisma.instrumentProfile.findMany({ select: { name: true, attributeKeys: true } });
    for (const p of profiles) {
      const keys = parseInstrumentAttributeKeys(p.attributeKeys ?? '');
      for (const retired of RETIRED_KEYS) {
        expect(keys, `profile "${p.name}" still asks for "${retired}"`).not.toContain(retired);
      }
    }
  });

  it('leaves the * Range keys alone — those describe the device, not the room', async () => {
    // A probe's measurement range is genuinely a per-instrument fact. Only the
    // SPEC limits moved.
    const profile = await prisma.instrumentProfile.findFirst({
      where: { attributeKeys: { contains: 'Range' } },
      select: { attributeKeys: true },
    });
    if (!profile) return; // no install here uses them; nothing to assert
    const keys = parseInstrumentAttributeKeys(profile.attributeKeys ?? '');
    expect(keys.some((k) => k.endsWith('Range'))).toBe(true);
  });
});

describe('the room is the source of truth for limits', () => {
  it('reports OUT_OF_SPEC from the room, with no limit attribute anywhere', async () => {
    const plan = await prisma.floorplan.create({
      data: { name: `LIMIT Plan ${s}`, imagePath: '/x.png', imageWidth: 1000, imageHeight: 700 },
    });
    plans.push(plan.id);

    const room = await prisma.floorplanRoom.create({
      data: { floorplanId: plan.id, code: `LIMIT-${s}`, x: 0.1, y: 0.1, w: 0.2, h: 0.2, tempMin: 18, tempMax: 25 },
    });

    const created = await app.inject({
      method: 'POST', url: '/api/instruments', headers: auth,
      payload: {
        name: `LIM-${s}`, code: `LIM-${s}`,
        profileId: await fixtureProfileId('fixture:limit-retirement'),
      },
    });
    expect(created.statusCode).toBe(201);
    const inst = created.json() as { id: string; token: string };
    instruments.push(inst.id);

    await prisma.instrument.update({ where: { id: inst.id }, data: { roomId: room.id } });
    await app.inject({
      method: 'POST', url: '/api/ingest/v1/telemetry',
      headers: { authorization: `Bearer ${inst.token}` },
      payload: { temperature: 27.5 },
    });

    // The instrument carries no attributes at all — the verdict can only have
    // come from the room.
    const attrs = await prisma.instrumentAttribute.findMany({ where: { instrumentId: inst.id } });
    expect(attrs).toHaveLength(0);

    const res = await app.inject({
      method: 'GET', url: '/api/instruments/telemetry-overview', headers: auth,
    });
    const row = (res.json().data as Record<string, any>[]).find((r) => r.instrumentId === inst.id);
    expect(row.status).toBe('OUT_OF_SPEC');
  });

  it('an unplaced instrument has no limits to breach, whatever it reads', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/instruments', headers: auth,
      payload: {
        name: `LIMU-${s}`, code: `LIMU-${s}`,
        profileId: await fixtureProfileId('fixture:limit-retirement'),
      },
    });
    const inst = created.json() as { id: string; token: string };
    instruments.push(inst.id);

    await app.inject({
      method: 'POST', url: '/api/ingest/v1/telemetry',
      headers: { authorization: `Bearer ${inst.token}` },
      payload: { temperature: 99 },
    });

    const res = await app.inject({
      method: 'GET', url: '/api/instruments/telemetry-overview', headers: auth,
    });
    const row = (res.json().data as Record<string, any>[]).find((r) => r.instrumentId === inst.id);
    // Nobody has said what this space is supposed to hold, so 99 °C is not a
    // breach — it is an unplaced reading.
    expect(row.status).not.toBe('OUT_OF_SPEC');
  });
});
