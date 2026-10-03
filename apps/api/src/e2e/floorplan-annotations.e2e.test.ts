/**
 * The annotation layer has to survive Fastify, not just Postgres.
 *
 * Fastify STRIPS any response property the schema does not declare, silently,
 * with no error anywhere — the value is written, read back correctly by Prisma,
 * and then vanishes between handler and wire. This repo has been bitten by that
 * twice already (`historySampled`/`summaries` on the telemetry route, and the
 * alarm list's `locationName`). `meta` and `annotations` are nested objects,
 * which is exactly the shape most likely to be half-declared: the outer key
 * passes, an inner one is dropped, and the floor renders with, say, its
 * equipment blocks but no ceiling heights.
 *
 * So these tests assert on the JSON that actually leaves the route, and check
 * the inner keys individually. Writing directly to the database and reading
 * back with Prisma would pass while the browser got nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp, loginAs } from './test-helper.js';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { Prisma } from '@prisma/client';

let app: FastifyInstance;
let auth: Record<string, string>;
let planId: string;
const PLAN = `fixture-annotations-${Date.now()}`;

const ANNOTATIONS = {
  // How the dashboard draws the plan (2026-10-01, "CWH — QC" in the 2D design).
  style: 'architectural',
  equipment: [{ x: 0.27, y: 0.42, w: 0.03, h: 0.03 }],
  hvac: [{ x: 0.98, y: 0.25, w: 0.02, h: 0.05 }],
  water: [{ x: 0.99, y: 0.11 }],
  airflow: [{ y: 0.83, x0: 0.05, x1: 0.47 }],
  labels: [{ x: 0.83, y: 0.14, text: 'NOD' }],
  // The building's structure (2026-10-01, QC Layout-2) — drawn on the dashboard.
  columns: [{ x: 0.22, y: 0.36, w: 0.045, h: 0.035 }],
  windows: [{ x: 0.001, y: 0.216, w: 0.017, h: 0.044 }],
  walls: [{ x1: 0.337, y1: 0.538, x2: 0.337, y2: 0.6 }],
  // One floor of a building of several, and where the drawing marks north
  // (2026-10-01, Module-F).
  floor: { group: 'FIX — Building', label: 'Ground Floor', order: 0 },
  north: 90,
};

beforeAll(async () => {
  app = await buildApp();
  auth = { authorization: `Bearer ${await loginAs(app)}` };
  const plan = await prisma.floorplan.create({
    data: {
      name: PLAN,
      imagePath: '/uploads/floorplans/x.png',
      imageWidth: 1082, imageHeight: 975,
      annotations: ANNOTATIONS as unknown as Prisma.InputJsonValue,
      rooms: {
        create: [
          {
            code: 'FIX-I/001', label: 'TRACED ROOM',
            x: 0.05, y: 0.05, w: 0.3, h: 0.3, grade: 'C',
            meta: { fill: '#fcf9f0', fch: '2.7m', dims: '4993 x 11390' } as unknown as Prisma.InputJsonValue,
          },
          {
            // The generated-plan case: no drawing, so SQL NULL.
            code: 'FIX-I/002', label: 'GENERATED ROOM',
            x: 0.40, y: 0.05, w: 0.3, h: 0.3, grade: 'C',
          },
        ],
      },
    },
    select: { id: true },
  });
  planId = plan.id;
});

afterAll(async () => {
  await prisma.floorplan.deleteMany({ where: { id: planId } });
  await app.close();
});

const qcPlan = async () => {
  const res = await app.inject({ method: 'GET', url: '/api/floorplans', headers: auth });
  expect(res.statusCode).toBe(200);
  const plans = res.json().data as Record<string, unknown>[];
  return plans.find((p) => p.name === PLAN)!;
};

describe('floorplan annotation layer over the wire', () => {
  it('returns the plan annotations rather than stripping them', async () => {
    const plan = await qcPlan();
    expect(plan.annotations).toBeTruthy();
  });

  it('keeps every annotation kind, not just the outer object', async () => {
    // The half-declared case: `annotations` survives but one inner array is
    // dropped, and the floor renders missing exactly one class of symbol.
    const a = (await qcPlan()).annotations as Record<string, unknown[]>;
    for (const key of ['equipment', 'hvac', 'water', 'airflow', 'labels']) {
      expect(a[key], `annotations.${key} was stripped`).toHaveLength(1);
    }
  });

  it('keeps the coordinates inside each annotation', async () => {
    const a = (await qcPlan()).annotations as typeof ANNOTATIONS;
    expect(a.equipment[0]).toEqual(ANNOTATIONS.equipment[0]);
    expect(a.hvac[0]).toEqual(ANNOTATIONS.hvac[0]);
    expect(a.water[0]).toEqual(ANNOTATIONS.water[0]);
    expect(a.airflow[0]).toEqual(ANNOTATIONS.airflow[0]);
    // A label losing its text renders as an empty box on the plan.
    expect(a.labels[0]).toEqual(ANNOTATIONS.labels[0]);
  });

  it('returns a traced room\'s fill, ceiling height and dimensions', async () => {
    const rooms = (await qcPlan()).rooms as Record<string, unknown>[];
    const traced = rooms.find((r) => r.code === 'FIX-I/001')!;
    expect(traced.meta).toEqual({ fill: '#fcf9f0', fch: '2.7m', dims: '4993 x 11390' });
  });

  it('leaves a room with no drawing carrying no meta', async () => {
    // NULL must stay NULL: an empty object would make the renderer believe a
    // generated plan had been traced, and it would draw an empty dimension line.
    const rooms = (await qcPlan()).rooms as Record<string, unknown>[];
    const generated = rooms.find((r) => r.code === 'FIX-I/002')!;
    expect(generated.meta ?? null).toBeNull();
  });

  it('still returns grade beside meta, since fill does not replace it', async () => {
    // `meta.fill` overrides the HUE on screen; it does not overwrite the
    // classification. Anything reading grade must go on seeing it.
    const rooms = (await qcPlan()).rooms as Record<string, unknown>[];
    expect(rooms.find((r) => r.code === 'FIX-I/001')!.grade).toBe('C');
  });
});

describe('the building STRUCTURE survives the response filter (2026-10-01)', () => {
  it('columns, windows and partition stubs reach the client, inner keys and all', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/floorplans', headers: auth });
    const plan = res.json().data.find((p: any) => p.id === planId);
    expect(plan.annotations.columns).toEqual(ANNOTATIONS.columns);
    expect(plan.annotations.windows).toEqual(ANNOTATIONS.windows);
    expect(plan.annotations.walls).toEqual(ANNOTATIONS.walls);
  });
  it('the FLOOR and NORTH reach the client, inner keys and all (or a building of two floors lists twice and north is "plan north")', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/floorplans', headers: auth });
    const plan = res.json().data.find((p: any) => p.id === planId);
    expect(plan.annotations.floor).toEqual({ group: 'FIX — Building', label: 'Ground Floor', order: 0 });
    expect(plan.annotations.north).toBe(90);
    const one = await app.inject({ method: 'GET', url: `/api/floorplans/${planId}`, headers: auth });
    expect(one.json().annotations.floor.label).toBe('Ground Floor');
    expect(one.json().annotations.north).toBe(90);
  });
  it('the drawing STYLE reaches the client (or the plan silently draws in the standard style)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/floorplans', headers: auth });
    expect(res.json().data.find((p: any) => p.id === planId).annotations.style).toBe('architectural');
    const one = await app.inject({ method: 'GET', url: `/api/floorplans/${planId}`, headers: auth });
    expect(one.json().annotations.style).toBe('architectural');
  });
});
