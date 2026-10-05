/**
 * The Layout Designer writes the 2D layer through the plan routes
 * (2026-10-05). Until then `annotations` was written only by the trace
 * scripts through Prisma: the zod plan schema had no such key, so a PUT
 * carrying it was silently ignored. These cases assert on the JSON that
 * LEAVES the route, inner keys individually — Fastify strips an undeclared
 * one without a word.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp, loginAs, ADMIN_PASSWORD } from './test-helper.js';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';

let app: FastifyInstance;
let auth: Record<string, string>;
const reauth = { 'x-reauth-password': ADMIN_PASSWORD };
const s = Date.now();
const made: string[] = [];

const ANN = {
  style: 'architectural',
  columns: [{ x: 0.1, y: 0.1, w: 0.02, h: 0.02 }],
  windows: [{ x: 0.2, y: 0.196, w: 0.1, h: 0.008 }],
  walls: [{ x1: 0.5, y1: 0.5, x2: 0.5, y2: 0.6 }],
  equipment: [{ x: 0.3, y: 0.3, w: 0.05, h: 0.03 }],
  labels: [{ x: 0.4, y: 0.4, text: 'HPLC' }],
  floor: { group: `B-${s}`, label: 'Ground Floor', order: 0 },
  north: 90,
};

beforeAll(async () => {
  app = await buildApp();
  auth = { authorization: `Bearer ${await loginAs(app)}` };
});
afterAll(async () => {
  await prisma.floorplan.deleteMany({ where: { id: { in: made } } });
  await app.close();
});

const create = async (name: string, annotations?: unknown) => {
  const res = await app.inject({
    method: 'POST', url: '/api/floorplans', headers: { ...auth, ...reauth },
    payload: { name, imagePath: null, imageWidth: 1600, imageHeight: 1200, ...(annotations !== undefined ? { annotations } : {}) },
  });
  if (res.statusCode === 201) made.push(res.json().id);
  return res;
};

describe('annotations through the plan routes', () => {
  it('POST lands every key and reads it back over HTTP', async () => {
    const res = await create(`ann-${s}-a`, ANN);
    expect(res.statusCode, res.body).toBe(201);
    const back = await app.inject({ method: 'GET', url: `/api/floorplans/${res.json().id}`, headers: auth });
    const a = back.json().annotations;
    expect(a.style).toBe('architectural');
    expect(a.columns).toEqual(ANN.columns);
    expect(a.windows).toEqual(ANN.windows);
    expect(a.walls).toEqual(ANN.walls);
    expect(a.equipment).toEqual(ANN.equipment);
    expect(a.labels).toEqual(ANN.labels);
    expect(a.floor).toEqual(ANN.floor);
    expect(a.north).toBe(90);
  });

  it('PUT replaces the object WHOLE; a PUT without the key leaves it untouched', async () => {
    const id = (await create(`ann-${s}-b`, ANN)).json().id;
    const put = await app.inject({
      method: 'PUT', url: `/api/floorplans/${id}`, headers: { ...auth, ...reauth },
      payload: { annotations: { style: 'architectural', labels: [{ x: 0.5, y: 0.5, text: 'ONLY' }] } },
    });
    expect(put.statusCode, put.body).toBe(200);
    let row = await prisma.floorplan.findUnique({ where: { id }, select: { annotations: true } });
    expect(row?.annotations).toEqual({ style: 'architectural', labels: [{ x: 0.5, y: 0.5, text: 'ONLY' }] });

    const rename = await app.inject({ method: 'PUT', url: `/api/floorplans/${id}`, headers: { ...auth, ...reauth }, payload: { name: `ann-${s}-b2` } });
    expect(rename.statusCode, rename.body).toBe(200);
    row = await prisma.floorplan.findUnique({ where: { id }, select: { annotations: true } });
    expect(row?.annotations).toEqual({ style: 'architectural', labels: [{ x: 0.5, y: 0.5, text: 'ONLY' }] });
  });

  it('image size and annotations in ONE PUT both land (the tracing-image path)', async () => {
    const id = (await create(`ann-${s}-c`)).json().id;
    const put = await app.inject({
      method: 'PUT', url: `/api/floorplans/${id}`, headers: { ...auth, ...reauth },
      payload: { imageWidth: 800, imageHeight: 600, annotations: { style: 'standard' } },
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json().imageWidth).toBe(800);
    expect(put.json().annotations.style).toBe('standard');
  });

  it.each([
    ['null', null],
    ['a bad style', { style: 'wrong' }],
    ['a box leaving the plan', { columns: [{ x: 0.99, y: 0.1, w: 0.05, h: 0.02 }] }],
    ['a zero-length wall', { walls: [{ x1: 0.5, y1: 0.5, x2: 0.5, y2: 0.5 }] }],
    ['an empty label', { labels: [{ x: 0.5, y: 0.5, text: '  ' }] }],
    ['north out of range', { north: 360 }],
    ['a floor order out of range', { floor: { group: 'g', label: 'l', order: 100 } }],
    ['an unknown key', { style: 'standard', bogus: 1 }],
  ])('refuses %s with a 400 naming the field', async (label, annotations) => {
    const id = (await create(`ann-${s}-d-${label.replace(/\W/g, '')}`)).json().id;
    const put = await app.inject({ method: 'PUT', url: `/api/floorplans/${id}`, headers: { ...auth, ...reauth }, payload: { annotations } });
    expect(put.statusCode, put.body).toBe(400);
    expect(put.json().error).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(put.json().details)).toContain('annotations');
  });

  it('the audit row carries a SUMMARY of the layer, not the arrays', async () => {
    const id = (await create(`ann-${s}-e`)).json().id;
    await app.inject({ method: 'PUT', url: `/api/floorplans/${id}`, headers: { ...auth, ...reauth }, payload: { annotations: ANN } });
    const row = await prisma.auditTrail.findFirst({ where: { action: 'FLOORPLAN_UPDATED', targetId: id }, orderBy: { timestamp: 'desc' } });
    const after = row?.afterValue as { annotations?: Record<string, unknown> };
    expect(after.annotations).toEqual({ style: 'architectural', columns: 1, windows: 1, walls: 1, equipment: 1, labels: 1, floor: ANN.floor, north: 90 });
  });
});
