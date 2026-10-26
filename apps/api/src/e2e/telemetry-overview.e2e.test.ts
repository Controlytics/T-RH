import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp, loginAs } from './test-helper.js';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';
import { patchFixtureMeasurement } from '../test-support/fixture-measurements.js';

let app: FastifyInstance;
let auth: Record<string, string>;
const created: string[] = [];
const s = Date.now();

beforeAll(async () => {
  app = await buildApp();
  auth = { authorization: `Bearer ${await loginAs(app)}` };
});

afterAll(async () => {
  for (const id of created) await app.inject({ method: 'DELETE', url: `/api/instruments/${id}`, headers: auth });
  await app.close();
});

async function createInstrument(code: string, extra: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST', url: '/api/instruments', headers: auth,
    payload: {
      name: code,
      code,
      profileId: await fixtureProfileId('fixture:telemetry-overview'),
      ...extra,
    },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { id: string; token: string };
  created.push(body.id);
  return body;
}

async function ingest(deviceToken: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST', url: '/api/ingest/v1/telemetry',
    headers: { authorization: `Bearer ${deviceToken}` },
    payload,
  });
}

async function overview(qs = '') {
  const res = await app.inject({
    method: 'GET', url: `/api/instruments/telemetry-overview${qs}`, headers: auth,
  });
  expect(res.statusCode).toBe(200);
  return res.json().data as Record<string, any>[];
}

const rowFor = (rows: Record<string, any>[], id: string) => rows.find((r) => r.instrumentId === id);

describe('GET /api/instruments/telemetry-overview', () => {
  it('returns an instrument that has never reported as NO_DATA with null slots', async () => {
    const inst = await createInstrument(`TOV-NEW-${s}`);
    const row = rowFor(await overview(), inst.id);
    expect(row).toBeDefined();
    expect(row!.temperature).toBeNull();
    expect(row!.humidity).toBeNull();
    expect(row!.room).toBeNull();
    // Never reported and no expected interval → falls outside the fallback
    // window, so it is STALE rather than NO_DATA. NO_DATA is for an instrument
    // that IS reporting but whose readings map to neither slot.
    expect(row!.reporting).toBe(false);
    expect(row!.status).toBe('STALE');
  });

  it('resolves temperature and humidity from the configured aliases', async () => {
    const inst = await createInstrument(`TOV-OK-${s}`);
    await ingest(inst.token, { temperature: 22.4, humidity: 45.2 });
    const row = rowFor(await overview(), inst.id)!;
    expect(row.temperature).toMatchObject({ key: 'temperature', value: 22.4 });
    expect(row.humidity).toMatchObject({ key: 'humidity', value: 45.2 });
    expect(row.reporting).toBe(true);
    // No room, so no limits to breach.
    expect(row.status).toBe('OK');
  });

  it('resolves an alias key — a device sending temp/rh is not blank', async () => {
    const inst = await createInstrument(`TOV-ALIAS-${s}`);
    await ingest(inst.token, { temp: 21.0, rh: 44.0 });
    const row = rowFor(await overview(), inst.id)!;
    expect(row.temperature).toMatchObject({ key: 'temp', value: 21.0 });
    expect(row.humidity).toMatchObject({ key: 'rh', value: 44.0 });
  });

  it('ignores telemetry keys that map to no slot', async () => {
    const inst = await createInstrument(`TOV-OTHER-${s}`);
    await ingest(inst.token, { pressure: 1013 });
    const row = rowFor(await overview(), inst.id)!;
    expect(row.temperature).toBeNull();
    expect(row.humidity).toBeNull();
    // Reporting, but nothing maps to a slot — this is what NO_DATA means.
    expect(row.reporting).toBe(true);
    expect(row.status).toBe('NO_DATA');
  });

  it('ignores non-numeric values rather than emitting NaN', async () => {
    const inst = await createInstrument(`TOV-STR-${s}`);
    await ingest(inst.token, { temperature: 'warm' });
    const row = rowFor(await overview(), inst.id)!;
    expect(row.temperature).toBeNull();
  });

  it('returns every instrument, including inactive ones', async () => {
    const inst = await createInstrument(`TOV-INACTIVE-${s}`, { isActive: false });
    const row = rowFor(await overview(), inst.id);
    expect(row).toBeDefined();
    expect(row!.isActive).toBe(false);
  });

  it('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/instruments/telemetry-overview' });
    expect(res.statusCode).toBe(401);
  });

  it('does not shadow GET /api/instruments/:id', async () => {
    // The static path must match ahead of the uuid param route.
    const inst = await createInstrument(`TOV-ROUTE-${s}`);
    const res = await app.inject({
      method: 'GET', url: `/api/instruments/${inst.id}`, headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(inst.id);
  });
});

describe('telemetry-overview with rooms', () => {
  async function makeRoom(
    code: string,
    limits: Partial<Record<'tempMin' | 'tempMax' | 'rhMin' | 'rhMax', number>>,
  ) {
    const plan = await prisma.floorplan.create({
      data: {
        name: `Plan ${code}`,
        imagePath: '/uploads/floorplans/x.png',
        imageWidth: 1000,
        imageHeight: 700,
      },
    });
    return prisma.floorplanRoom.create({
      data: { floorplanId: plan.id, code, x: 0.1, y: 0.1, w: 0.1, h: 0.1, ...limits },
    });
  }

  it('reports OUT_OF_SPEC against the room limits', async () => {
    const room = await makeRoom(`R-HOT-${s}`, { tempMin: 18, tempMax: 25 });
    const inst = await createInstrument(`TOV-HOT-${s}`);
    await prisma.instrument.update({ where: { id: inst.id }, data: { roomId: room.id } });
    await ingest(inst.token, { temperature: 27.5 });
    const row = rowFor(await overview(), inst.id)!;
    expect(row.room).toMatchObject({ code: `R-HOT-${s}` });
    expect(row.status).toBe('OUT_OF_SPEC');
  });

  it('reports PARTIAL when a limited slot has no reading', async () => {
    const room = await makeRoom(`R-PART-${s}`, { tempMin: 18, tempMax: 25, rhMin: 40, rhMax: 60 });
    const inst = await createInstrument(`TOV-PART-${s}`);
    await prisma.instrument.update({ where: { id: inst.id }, data: { roomId: room.id } });
    await ingest(inst.token, { temperature: 22 });
    const row = rowFor(await overview(), inst.id)!;
    expect(row.status).toBe('PARTIAL');
  });

  it('unlinks rather than deletes when its room is deleted', async () => {
    const room = await makeRoom(`R-GONE-${s}`, {});
    const inst = await createInstrument(`TOV-GONE-${s}`);
    await prisma.instrument.update({ where: { id: inst.id }, data: { roomId: room.id } });
    await prisma.floorplanRoom.delete({ where: { id: room.id } });
    const still = await prisma.instrument.findUnique({ where: { id: inst.id } });
    expect(still).not.toBeNull();
    expect(still!.roomId).toBeNull();
  });

  it('narrows to one plan with ?floorplanId=', async () => {
    const room = await makeRoom(`R-PLAN-${s}`, {});
    const inst = await createInstrument(`TOV-PLAN-${s}`);
    await prisma.instrument.update({ where: { id: inst.id }, data: { roomId: room.id } });
    const rows = await overview(`?floorplanId=${room.floorplanId}`);
    expect(rows.map((r) => r.instrumentId)).toEqual([inst.id]);
  });
});

/**
 * A bound the instrument switches OFF must not reach the client as a live bound.
 *
 * The alarm evaluator will not raise on it (`enabledBoundsFor`, worker), so a
 * payload that still carried it would have every DISPLAY surface — the dashboard
 * table, the floor tiles, the trend card and its chart's limit line — drawing and
 * reddening a bound that can never produce an alarm. On this installation a
 * `High Humidity Limit = 0` meaning "not judged" does exactly that at every real
 * humidity.
 *
 * The mapping is the thing worth pinning: NMT is the HIGH bound and NLT the LOW
 * one, so reversing it silently withholds the OPPOSITE bound while looking
 * entirely correct.
 */
describe('telemetry-overview and the per-bound enable attributes', () => {
  async function withAttributes(code: string, attrs: Record<string, string>) {
    const inst = await createInstrument(code);
    await prisma.instrumentAttribute.createMany({
      data: Object.entries(attrs).map(([key, value]) => ({ instrumentId: inst.id, key, value })),
    });
    return inst;
  }

  const LIMITS = {
    'High Temperature Limit': '25',
    'Low Temperature Limit': '18',
    'High Humidity Limit': '60',
    'Low Humidity Limit': '40',
  };

  it('withholds ONLY the disabled bound, and NLT is the LOW one', async () => {
    const inst = await withAttributes(`TOV-NLT-${s}`, { ...LIMITS, Enable_Temp_NLT: '0' });
    const row = rowFor(await overview(), inst.id)!;
    expect(row.limits.tempMin).toBeNull();
    expect(row.limits.tempMax).toBe(25);
    // The humidity pair is untouched — one flag disables one bound.
    expect(row.limits.rhMin).toBe(40);
    expect(row.limits.rhMax).toBe(60);
    expect(row.limitEnabled).toMatchObject({ tempMin: false, tempMax: true, rhMin: true, rhMax: true });
  });

  it('NMT is the HIGH one — the reversal that would look correct', async () => {
    const inst = await withAttributes(`TOV-NMT-${s}`, { ...LIMITS, Enable_Humid_NMT: '0' });
    const row = rowFor(await overview(), inst.id)!;
    expect(row.limits.rhMax).toBeNull();
    expect(row.limits.rhMin).toBe(40);
    expect(row.limitEnabled).toMatchObject({ rhMax: false, rhMin: true });
  });

  it('a 0 bound switched off cannot make the instrument OUT_OF_SPEC', async () => {
    // The exact live case: "not judged" written as a zero high-humidity bound,
    // which every real reading breaches. 17 CRITICAL alarms stood on this.
    const inst = await withAttributes(`TOV-ZERO-${s}`, {
      'High Humidity Limit': '0', Enable_Humid_NMT: '0',
    });
    await ingest(inst.token, { humidity: 47 });
    const row = rowFor(await overview(), inst.id)!;
    expect(row.limits?.rhMax ?? null).toBeNull();
    expect(row.status).not.toBe('OUT_OF_SPEC');
  });

  it('an absent flag means ENABLED, so nothing that predates the flags moves', async () => {
    const inst = await withAttributes(`TOV-NOFLAG-${s}`, LIMITS);
    const row = rowFor(await overview(), inst.id)!;
    expect(row.limits).toMatchObject({ tempMin: 18, tempMax: 25, rhMin: 40, rhMax: 60 });
    expect(row.limitEnabled).toMatchObject({ tempMin: true, tempMax: true, rhMin: true, rhMax: true });
  });

  it('drops limitSource once no bound survives — a source for an empty band asserts one', async () => {
    const inst = await withAttributes(`TOV-ALLOFF-${s}`, {
      ...LIMITS,
      Enable_Temp_NMT: '0', Enable_Temp_NLT: '0', Enable_Humid_NMT: '0', Enable_Humid_NLT: '0',
    });
    const row = rowFor(await overview(), inst.id)!;
    expect(row.limits).toMatchObject({ tempMin: null, tempMax: null, rhMin: null, rhMax: null });
    expect(row.limitSource).toBeNull();
  });

  /**
   * A limit attribute may carry TEXT beside its number (operator, 2026-10-03:
   * "text is included in limits and ranges show that text in reports and show
   * max and min values, in dashboard show the same text only"). The live case:
   * CWH/RDU/101-00's `h_hl` was edited to `60 (For Reference)` and the
   * humidity bound vanished from every screen and report, with
   * `Enable_Humid_NMT = True` looking like the thing that had failed.
   *
   * Over the wire, inner key by inner key: `limitText` is a nested object,
   * and Fastify strips an undeclared inner key silently.
   */
  it('a limit carrying text keeps its NUMBER as the bound and sends the TEXT beside it', async () => {
    const inst = await withAttributes(`TOV-TEXT-${s}`, {
      ...LIMITS,
      'High Humidity Limit': '60 (For Reference)',
      Enable_Humid_NMT: 'True',
    });
    await ingest(inst.token, { temperature: 22, humidity: 65 });
    const row = rowFor(await overview(), inst.id)!;
    // The number is still the bound — enforced, and breached by 65.
    expect(row.limits.rhMax).toBe(60);
    expect(row.status).toBe('OUT_OF_SPEC');
    // The text rides beside it, for that bound ALONE; a bare number has none.
    expect(row.limitText).toEqual({ tempMin: null, tempMax: null, rhMin: null, rhMax: '60 (For Reference)' });
  });

  it('a switched-off bound keeps no text either — the caption follows the bound', async () => {
    const inst = await withAttributes(`TOV-TEXTOFF-${s}`, {
      ...LIMITS,
      'High Humidity Limit': '60 (For Reference)',
      Enable_Humid_NMT: '0',
    });
    const row = rowFor(await overview(), inst.id)!;
    expect(row.limits.rhMax).toBeNull();
    expect(row.limitText.rhMax).toBeNull();
  });
});

/**
 * The dashboard table's AREA and LOCATION columns, asserted OVER THE WIRE.
 *
 * **These go through `app.inject`, never off `buildTelemetryOverview()`'s return
 * value, and that is the entire point of the block.** Fastify STRIPS any
 * response property the route's 200 schema does not name, silently and with no
 * error anywhere — a field the builder computes and returns simply never reaches
 * the browser. It has cost this repo four times: `historySampled`/`summaries`,
 * the alarm list's `locationName`, the floorplan `meta`/`annotations`, and
 * `rangeBounds`, which was computed and returned for weeks while the trend table
 * could not tell a saturated reading from a real one. A test that called the
 * builder directly would pass against every one of those.
 *
 * The two are DIFFERENT FACTS and the tests keep them apart deliberately: Area
 * is `Instrument.functionalLocation.name`, the authoritative Block > Area
 * grouping, and Location is the instrument's own `Location` ATTRIBUTE — not
 * `Instrument.location`, the superseded free-text column of the same name, which
 * is why one case sets that column to something different and asserts it is not
 * what comes back.
 */
/**
 * The PROFILE's NMT / NLT switch (2026-10-26, operator: "in instrument profiles
 * NLT and MNT … enabled or disabled"). An AND gate in front of the per-instrument
 * enable attribute: off at the profile = withheld for every instrument in it,
 * whatever the instrument's own flag says. Its own fixture profile, so no other
 * case here sees the switch.
 */
describe('telemetry-overview and the profile NMT / NLT switch', () => {
  it('a profile with temperature NMT off withholds the high bound and only it', async () => {
    const profileId = await fixtureProfileId('fixture:telemetry-overview-nmt-off');
    await patchFixtureMeasurement(profileId, 'TEMPERATURE', (m) => ({ ...m, high: { ...m.high, enabled: false } }));
    const inst = await createInstrument(`TOV-PNMT-${s}`, { profileId });
    await prisma.instrumentAttribute.createMany({
      data: [
        // The instrument's own flag says ON — the profile still wins.
        { instrumentId: inst.id, key: 'Enable_Temp_NMT', value: '1' },
        { instrumentId: inst.id, key: 'High Temperature Limit', value: '25' },
        { instrumentId: inst.id, key: 'Low Temperature Limit', value: '18' },
      ],
    });
    const row = rowFor(await overview(), inst.id)!;
    expect(row.limits.tempMax).toBeNull();
    expect(row.limitEnabled.tempMax).toBe(false);
    expect(row.limits.tempMin).toBe(18);
    expect(row.limitEnabled.tempMin).toBe(true);
  });
});

describe('telemetry-overview placement columns (Area and Location)', () => {
  it('returns the FUNCTIONAL location name and the Location attribute over the wire', async () => {
    const block = await prisma.functionalLocation.create({
      data: { name: `TOV Block ${s}`, type: 'BLOCK' },
    });
    const area = await prisma.functionalLocation.create({
      data: { name: `TOV Area ${s}`, type: 'AREA', parentId: block.id },
    });
    const inst = await createInstrument(`TOV-PLACE-${s}`);
    await prisma.instrument.update({
      where: { id: inst.id },
      data: { functionalLocationId: area.id },
    });
    await prisma.instrumentAttribute.create({
      data: { instrumentId: inst.id, key: 'Location', value: 'Dissolution & UV Room' },
    });

    const row = rowFor(await overview(), inst.id)!;
    expect(row.functionalLocationName).toBe(`TOV Area ${s}`);
    expect(row.locationAttribute).toBe('Dissolution & UV Room');
  });

  it('is the ATTRIBUTE, not the superseded Instrument.location column', async () => {
    // Both are named "location" and they hold different things. If the builder
    // ever reads the column, this is the case that says so.
    const inst = await createInstrument(`TOV-COLUMN-${s}`);
    await prisma.instrument.update({
      where: { id: inst.id },
      data: { location: 'the superseded column' },
    });
    await prisma.instrumentAttribute.create({
      data: { instrumentId: inst.id, key: 'Location', value: 'the attribute' },
    });

    const row = rowFor(await overview(), inst.id)!;
    expect(row.locationAttribute).toBe('the attribute');
  });

  it('matches the attribute key case-insensitively, as every other lookup here does', async () => {
    // `resolveLimit()` in @digilog/shared trims and lowercases; a hand-typed
    // `location` names the same fact as the live rows' `Location`.
    const inst = await createInstrument(`TOV-CASE-${s}`);
    await prisma.instrumentAttribute.create({
      data: { instrumentId: inst.id, key: ' location ', value: 'Cold Room 2' },
    });
    const row = rowFor(await overview(), inst.id)!;
    expect(row.locationAttribute).toBe('Cold Room 2');
  });

  it('sends null for both when neither is set, rather than omitting the keys', async () => {
    // Null is a value the column can render as "Unassigned" / "Not set". An
    // absent KEY is indistinguishable from a Fastify strip.
    const inst = await createInstrument(`TOV-NOPLACE-${s}`);
    const row = rowFor(await overview(), inst.id)!;
    expect(row).toHaveProperty('functionalLocationName');
    expect(row).toHaveProperty('locationAttribute');
    expect(row.functionalLocationName).toBeNull();
    expect(row.locationAttribute).toBeNull();
  });

  it('treats a blank attribute value as absent', async () => {
    // An attribute somebody created and left empty says nothing; letting it
    // through renders an empty cell that looks like a rendering fault.
    const inst = await createInstrument(`TOV-BLANK-${s}`);
    await prisma.instrumentAttribute.create({
      data: { instrumentId: inst.id, key: 'Location', value: '   ' },
    });
    const row = rowFor(await overview(), inst.id)!;
    expect(row.locationAttribute).toBeNull();
  });
});
