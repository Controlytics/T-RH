import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp, loginAs } from './test-helper.js';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';

let app: FastifyInstance;
let auth: Record<string, string>;
const s = Date.now();
const plans: string[] = [];
const instruments: string[] = [];

let planId = '';
let roomId = '';
let emptyRoomId = '';
let instA = '';
let instB = '';

/** Seed history directly: ingest stamps now() and cannot produce a 7-day spread. */
async function seedHistory(
  instrumentId: string, key: string, points: { minutesAgo: number; value: number }[],
) {
  for (const p of points) {
    const ts = new Date(Date.now() - p.minutesAgo * 60_000);
    await prisma.$executeRaw`
      INSERT INTO instrument_telemetry_history (instrument_id, key, value, value_type, ts)
      VALUES (${instrumentId}, ${key}, ${Prisma.raw(`'${p.value}'::jsonb`)}, 'number', ${ts})
      ON CONFLICT (instrument_id, key, ts) DO NOTHING`;
  }
}

async function createInstrument(code: string) {
  const res = await app.inject({
    method: 'POST', url: '/api/instruments', headers: auth,
    payload: { name: code, code, profileId: await fixtureProfileId('fixture:room-history') },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { id: string };
  instruments.push(body.id);
  return body.id;
}

beforeAll(async () => {
  app = await buildApp();
  auth = { authorization: `Bearer ${await loginAs(app)}` };

  const plan = await prisma.floorplan.create({
    data: {
      name: `RH Plan ${s}`, imagePath: '/uploads/floorplans/x.png',
      imageWidth: 1000, imageHeight: 700,
    },
  });
  planId = plan.id;
  plans.push(plan.id);

  const room = await prisma.floorplanRoom.create({
    data: { floorplanId: planId, code: `RH-${s}`, x: 0.1, y: 0.1, w: 0.2, h: 0.2, tempMin: 18, tempMax: 25 },
  });
  roomId = room.id;

  const empty = await prisma.floorplanRoom.create({
    data: { floorplanId: planId, code: `RH-EMPTY-${s}`, x: 0.5, y: 0.5, w: 0.2, h: 0.2 },
  });
  emptyRoomId = empty.id;

  instA = await createInstrument(`RH-A-${s}`);
  instB = await createInstrument(`RH-B-${s}`);
  await prisma.instrument.updateMany({ where: { id: { in: [instA, instB] } }, data: { roomId } });

  // A: both slots. B: temperature only — a slot with no readings must produce
  // NO series rather than an empty one.
  await seedHistory(instA, 'temperature', [
    { minutesAgo: 1, value: 22.0 }, { minutesAgo: 5, value: 22.5 }, { minutesAgo: 300, value: 23.0 },
    { minutesAgo: 60 * 40, value: 21.0 },
  ]);
  await seedHistory(instA, 'humidity', [{ minutesAgo: 1, value: 45 }, { minutesAgo: 5, value: 46 }]);
  await seedHistory(instB, 'temperature', [{ minutesAgo: 2, value: 20.0 }]);
});

afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM instrument_telemetry_history WHERE instrument_id = ANY(${instruments}::text[])`;
  for (const id of instruments) {
    await app.inject({ method: 'DELETE', url: `/api/instruments/${id}`, headers: auth });
  }
  for (const id of plans) await prisma.floorplan.deleteMany({ where: { id } });
  await app.close();
});

async function history(room: string, window: string) {
  return app.inject({
    method: 'GET',
    url: `/api/floorplans/${planId}/rooms/${room}/history?window=${window}`,
    headers: auth,
  });
}

describe('GET /api/floorplans/:id/rooms/:roomId/history', () => {
  it('returns one series per instrument and slot that has readings', async () => {
    const res = await history(roomId, '6h');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const keys = body.series.map((x: { instrumentCode: string; slot: string }) => `${x.instrumentCode}:${x.slot}`).sort();
    expect(keys).toEqual([`RH-A-${s}:humidity`, `RH-A-${s}:temperature`, `RH-B-${s}:temperature`]);
  });

  it('omits a slot with no readings rather than returning an empty series', async () => {
    // An empty series renders as axes with no line, which reads as "flat"
    // rather than "nothing here".
    const res = await history(roomId, '6h');
    const bHumidity = res.json().series.find(
      (x: { instrumentCode: string; slot: string }) => x.instrumentCode === `RH-B-${s}` && x.slot === 'humidity',
    );
    expect(bHumidity).toBeUndefined();
  });

  it('returns raw points below the bucketing threshold', async () => {
    const res = await history(roomId, '1h');
    const body = res.json();
    expect(body.bucketSeconds).toBeNull();
    const temp = body.series.find((x: { instrumentCode: string; slot: string }) => x.instrumentCode === `RH-A-${s}` && x.slot === 'temperature');
    // Only the two points inside the last hour.
    expect(temp.points).toHaveLength(2);
  });

  it('buckets a long window and caps the point count', async () => {
    const res = await history(roomId, '7d');
    const body = res.json();
    expect(body.bucketSeconds).toBeGreaterThan(0);
    for (const series of body.series) {
      expect(series.points.length).toBeLessThanOrEqual(500);
    }
  });

  it('honours the window boundary', async () => {
    const short = await history(roomId, '15m');
    const long = await history(roomId, '24h');
    const shortTemp = short.json().series.find((x: { slot: string; instrumentCode: string }) => x.slot === 'temperature' && x.instrumentCode === `RH-A-${s}`);
    const longTemp = long.json().series.find((x: { slot: string; instrumentCode: string }) => x.slot === 'temperature' && x.instrumentCode === `RH-A-${s}`);
    expect(shortTemp.points.length).toBeLessThan(longTemp.points.length);
  });

  it('orders points oldest first, because charts draw left to right', async () => {
    const res = await history(roomId, '6h');
    for (const series of res.json().series) {
      const ts = series.points.map((p: { ts: string }) => p.ts);
      expect(ts).toEqual([...ts].sort());
    }
  });

  it('returns the room and its limits alongside the series', async () => {
    const res = await history(roomId, '1h');
    expect(res.json().room).toMatchObject({ code: `RH-${s}`, tempMin: 18, tempMax: 25 });
  });

  it('returns an empty series list for a room with no instruments', async () => {
    const res = await history(emptyRoomId, '1h');
    expect(res.statusCode).toBe(200);
    expect(res.json().series).toEqual([]);
  });

  it('rejects an unknown window rather than silently defaulting', async () => {
    const res = await history(roomId, '3y');
    expect(res.statusCode).toBe(400);
  });

  it('404s for a room on a different plan', async () => {
    const other = await prisma.floorplan.create({
      data: { name: `RH Other ${s}`, imagePath: '/x.png', imageWidth: 10, imageHeight: 10 },
    });
    plans.push(other.id);
    const res = await app.inject({
      method: 'GET', url: `/api/floorplans/${other.id}/rooms/${roomId}/history?window=1h`, headers: auth,
    });
    expect(res.statusCode).toBe(404);
  });

  it('requires authentication', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/floorplans/${planId}/rooms/${roomId}/history?window=1h`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('survives a non-numeric reading in the same window', async () => {
    // Real data here contains a string value. A cast that is not guarded by a
    // CASE can be evaluated before the WHERE filter depending on the plan, and
    // then the whole query errors.
    const ts = new Date(Date.now() - 3 * 60_000);
    await prisma.$executeRaw`
      INSERT INTO instrument_telemetry_history (instrument_id, key, value, value_type, ts)
      VALUES (${instA}, 'temperature', '"warm"'::jsonb, 'string', ${ts})
      ON CONFLICT (instrument_id, key, ts) DO NOTHING`;

    const res = await history(roomId, '1h');
    expect(res.statusCode).toBe(200);
    const temp = res.json().series.find((x: { slot: string; instrumentCode: string }) => x.slot === 'temperature' && x.instrumentCode === `RH-A-${s}`);
    for (const p of temp.points) expect(typeof p.value).toBe('number');
  });
});
