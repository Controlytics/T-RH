# Layout Designer 2D Design Model — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Layout Designer can author a plan in the 2D architectural style — plan style / floor / north, columns, windows, wall stubs, equipment outlines, labels, and door hinge / swing / width / double leaf — through the existing audited plan and room endpoints, rendered by the dashboard exactly as the traced floors are.

**Architecture:** The data already exists (`floorplans.annotations` JSONB and the door fields); the API gains a zod `annotationsSchema` so `POST`/`PUT /api/floorplans` can write it, the shared geometry gains two pure helpers (`segmentOnEdge`, `splitDoor`), and the designer gains five structure tools, a plan panel, a structure panel and 2D door controls, saving the plan's whole `annotations` object on every change the way a room's doors are saved. The dashboard is untouched.

**Tech Stack:** TypeScript, Fastify 5 + zod + Prisma 6 (api), React 19 + SWR + vitest/jsdom + Testing Library (web), `@digilog/shared`.

**Spec:** `docs/superpowers/specs/2026-10-05-layout-designer-2d-design.md`

## Global Constraints

- Plan units are 0..1 for every coordinate; boxes are `{x, y, w, h}`, segments `{x1, y1, x2, y2}`, labels `{x, y, text}` — the shapes `planProps` already declares.
- `style` is `'standard' | 'architectural'`; a new plan is created with `'architectural'`; a plan without a style is standard.
- Limits: ≤ 500 columns / windows / walls / equipment, ≤ 200 labels, label text 1..60 chars, `north` 0 ≤ n < 360, `floor.order` 0..99.
- Omitted `annotations` on PUT leaves the column untouched; given, it replaces the column whole. `hvac` / `water` / `airflow` pass through unvalidated beyond "an array of objects".
- A double door is TWO doors (`hinge: 'start'` then `'end'`, half width each); there is no flag.
- The structure tools show only when the plan's style is 2D.
- No count moves: no model, enum, migration, permission, reauth action, def, page, route, hook, lib module or shared type file.
- Every web test file is run ALONE by exit code (`npx vitest run <file>`); API e2e the same; mutation checks restore from a backup COPY, never `git checkout`.
- The five script-drawn plans (names in `SCRIPT_DRAWN_PLANS`) are editable but carry a note; the scripts remain their source.

## Review Focus

Inputs the spec implies that no task's tests would otherwise exercise; each line's test is added to the owning task below.

1. A window two-click whose second click lands on a DIFFERENT room edge than the first — must stay a free segment, never snap one end to each edge (Task 1).
2. A `PUT /api/floorplans/:id` with `annotations: null` — the API must refuse it (400), since "null" would read as "clear everything" to a client that meant "untouched" (Task 2).
3. `imageWidth` / `imageHeight` in the same PUT as `annotations` (the tracing-image upload path) — both must land; a partial schema that swallowed one would break the upload (Task 2).
4. Switching a 2D plan back to Standard — the structure arrays must survive on the row (Task 4).
5. Deleting a structure element while a room is ALSO selected (the Delete key) — the element goes, the room stays (Task 5).

---

### Task 1: Shared geometry — `segmentOnEdge` and `splitDoor`

**Files:**
- Modify: `packages/shared/src/types/floorplan-geometry.ts` (append after `unionRectilinear`)
- Modify: `packages/shared/src/index.ts:136` (add the two names to the existing `floorplan-geometry` export list)
- Test: `packages/shared/src/types/__tests__/floorplan-geometry-2d.test.ts` (new)

**Interfaces:**
- Produces: `SEGMENT_SNAP_TOL = 0.01`; `segmentOnEdge(a: Point, b: Point, polys: Polygon[], tol?: number): { a: Point; b: Point; snapped: boolean }`; `splitDoor<D extends { offset: number; width: number; hinge?: string }>(door: D): [D, D]`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/shared/src/types/__tests__/floorplan-geometry-2d.test.ts
import { describe, it, expect } from 'vitest';
import { segmentOnEdge, splitDoor, rectanglePoints, SEGMENT_SNAP_TOL } from '../floorplan-geometry';

/**
 * Two pure helpers for the Layout Designer's 2D tools (2026-10-05): a window or
 * wall stub drawn ALONG a wall lands ON the wall; a double door is two doors.
 */
const room = rectanglePoints({ x: 0.2, y: 0.2, w: 0.4, h: 0.3 }); // top edge y=0.2 from x=0.2..0.6

describe('segmentOnEdge', () => {
  it('snaps both ends onto the one edge they both lie beside', () => {
    const r = segmentOnEdge({ x: 0.3, y: 0.205 }, { x: 0.5, y: 0.196 }, [room]);
    expect(r.snapped).toBe(true);
    expect(r.a).toEqual({ x: 0.3, y: 0.2 });
    expect(r.b).toEqual({ x: 0.5, y: 0.2 });
  });

  it('leaves a free segment alone (a duct stub across a room)', () => {
    const r = segmentOnEdge({ x: 0.3, y: 0.3 }, { x: 0.5, y: 0.35 }, [room]);
    expect(r.snapped).toBe(false);
    expect(r.a).toEqual({ x: 0.3, y: 0.3 });
    expect(r.b).toEqual({ x: 0.5, y: 0.35 });
  });

  it('never snaps one end to each of two DIFFERENT edges', () => {
    // a beside the top edge, b beside the left edge: not one wall.
    const r = segmentOnEdge({ x: 0.3, y: 0.205 }, { x: 0.205, y: 0.4 }, [room]);
    expect(r.snapped).toBe(false);
    expect(r.a).toEqual({ x: 0.3, y: 0.205 });
    expect(r.b).toEqual({ x: 0.205, y: 0.4 });
  });

  it('honours the tolerance', () => {
    expect(SEGMENT_SNAP_TOL).toBe(0.01);
    expect(segmentOnEdge({ x: 0.3, y: 0.22 }, { x: 0.5, y: 0.22 }, [room]).snapped).toBe(false);
    expect(segmentOnEdge({ x: 0.3, y: 0.22 }, { x: 0.5, y: 0.22 }, [room], 0.03).snapped).toBe(true);
  });
});

describe('splitDoor', () => {
  it('returns two half-width doors with mirrored hinges, abutting', () => {
    const [a, b] = splitDoor({ edge: 1, offset: 0.4, width: 0.2, kind: 'ENTRY', hinge: 'start', swing: 'in' });
    expect(a).toEqual({ edge: 1, offset: 0.4, width: 0.1, kind: 'ENTRY', hinge: 'start', swing: 'in' });
    expect(b).toEqual({ edge: 1, offset: 0.5, width: 0.1, kind: 'ENTRY', hinge: 'end', swing: 'in' });
  });

  it('keeps a wall-named door on its wall', () => {
    const [a, b] = splitDoor({ wall: 'top', offset: 0.1, width: 0.3, kind: 'EXIT' });
    expect(a.wall).toBe('top'); expect(b.wall).toBe('top');
    expect(a.width + b.width).toBeCloseTo(0.3, 9);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/shared && npx vitest run src/types/__tests__/floorplan-geometry-2d.test.ts`
Expected: FAIL — `segmentOnEdge is not a function` / `splitDoor is not a function`.

- [ ] **Step 3: Implement the two helpers**

Append to `packages/shared/src/types/floorplan-geometry.ts`:

```ts
/** How close BOTH ends of a drawn segment must be to one edge to land on it (1 % of the plan). */
export const SEGMENT_SNAP_TOL = 0.01;

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

function projectOnto(p: Point, e: Segment): { point: Point; dist: number } {
  const dx = e.x2 - e.x1, dy = e.y2 - e.y1;
  const len2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - e.x1) * dx + (p.y - e.y1) * dy) / len2));
  const q = { x: r6(e.x1 + dx * t), y: r6(e.y1 + dy * t) };
  return { point: q, dist: Math.hypot(q.x - p.x, q.y - p.y) };
}

/**
 * A two-click segment (a window, a wall stub) drawn ALONG a wall lands ON the
 * wall (Layout Designer 2D, 2026-10-05): when BOTH ends lie within `tol` of the
 * SAME polygon edge, both are projected onto it. One end near one edge and the
 * other near a different edge is not "along a wall" and is left alone, as is a
 * free segment across a room — Module-E's duct stubs are drawn that way.
 */
export function segmentOnEdge(a: Point, b: Point, polys: Polygon[], tol = SEGMENT_SNAP_TOL): { a: Point; b: Point; snapped: boolean } {
  let best: { a: Point; b: Point; worst: number } | null = null;
  for (const poly of polys) {
    for (const e of polygonEdges(poly)) {
      const pa = projectOnto(a, e), pb = projectOnto(b, e);
      const worst = Math.max(pa.dist, pb.dist);
      if (worst <= tol && (!best || worst < best.worst)) best = { a: pa.point, b: pb.point, worst };
    }
  }
  return best ? { a: best.a, b: best.b, snapped: true } : { a, b, snapped: false };
}

/**
 * A double door is TWO doors on the same edge: half the width each, the first
 * hinged at its start and the second at its end, abutting at the middle of the
 * original opening — the `vPair` / `hPair` rule the traced floors use. No flag
 * in the data; the dashboard needs none.
 */
export function splitDoor<D extends { offset: number; width: number; hinge?: string }>(door: D): [D, D] {
  const half = r6(door.width / 2);
  return [
    { ...door, width: half, hinge: 'start' },
    { ...door, offset: r6(door.offset + half), width: half, hinge: 'end' },
  ];
}
```

In `packages/shared/src/index.ts`, add `segmentOnEdge, splitDoor, SEGMENT_SNAP_TOL,` to the `export { … } from './types/floorplan-geometry.js';` list at line 136 (open the list and append the three names before the closing brace).

- [ ] **Step 4: Run the tests to verify they pass, then rebuild shared**

Run: `cd packages/shared && npx vitest run src/types/__tests__/floorplan-geometry-2d.test.ts && npm run build -w @digilog/shared`
Expected: PASS (6 tests); build exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/floorplan-geometry.ts packages/shared/src/index.ts packages/shared/src/types/__tests__/floorplan-geometry-2d.test.ts
git commit -m "feat(shared): segmentOnEdge and splitDoor for the Layout Designer's 2D tools"
```

---

### Task 2: API — `annotations` validated and writable on plan create / update

**Files:**
- Modify: `apps/api/src/modules/floorplans/validation.ts:186-197` (add `annotationsSchema`, add it to `floorplanSchema`)
- Modify: `apps/api/src/modules/floorplans/routes.ts:276-312` (POST audit `afterValue`), `:316-360` (PUT audit before/after)
- Test: `apps/api/src/e2e/floorplan-annotations-write.e2e.test.ts` (new)

**Interfaces:**
- Produces: `annotationsSchema` (zod), `type FloorplanAnnotations = z.infer<typeof annotationsSchema>`, `annotationsSummary(a: unknown): Record<string, unknown> | null` (exported from `validation.ts`).
- Consumes: nothing from Task 1.

- [ ] **Step 1: Write the failing e2e**

```ts
// apps/api/src/e2e/floorplan-annotations-write.e2e.test.ts
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
  ])('refuses %s with a 400 naming the field', async (_label, annotations) => {
    const id = (await create(`ann-${s}-d-${_label.replace(/\W/g, '')}`)).json().id;
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/e2e/floorplan-annotations-write.e2e.test.ts`
Expected: FAIL — the first case's `a` is `null` (the key is stripped by the zod schema today).

- [ ] **Step 3: Add the schema and the summary**

In `apps/api/src/modules/floorplans/validation.ts`, ABOVE `floorplanSchema`:

```ts
// ─── The 2D layer, written by the Layout Designer (2026-10-05) ────────────────
// Until then `annotations` was written only by the trace scripts through
// Prisma; this schema is what lets the designer author the same shape through
// the plan routes. Plan units 0..1; counts bounded so a runaway client cannot
// store megabytes on a row the dashboard reads on every load.
const unit = z.number().min(0).max(1);
const boxSchema = z.object({
  x: unit, y: unit, w: z.number().positive().max(1), h: z.number().positive().max(1),
}).strict().refine((b) => b.x + b.w <= 1 + 1e-9 && b.y + b.h <= 1 + 1e-9, { message: 'The box leaves the plan.' });
const segmentSchema = z.object({ x1: unit, y1: unit, x2: unit, y2: unit }).strict()
  .refine((s) => s.x1 !== s.x2 || s.y1 !== s.y2, { message: 'A segment needs two different ends.' });
const labelSchema = z.object({ x: unit, y: unit, text: z.string().trim().min(1).max(60) }).strict();
// Drawn by the trace scripts only; validated as "an array of objects" so a
// traced plan's PUT from the designer carries them through unchanged.
const passthrough = z.array(z.record(z.unknown())).max(500);

export const annotationsSchema = z.object({
  style: z.enum(['standard', 'architectural']).optional(),
  columns: z.array(boxSchema).max(500).optional(),
  windows: z.array(boxSchema).max(500).optional(),
  equipment: z.array(boxSchema).max(500).optional(),
  walls: z.array(segmentSchema).max(500).optional(),
  labels: z.array(labelSchema).max(200).optional(),
  floor: z.object({
    group: z.string().trim().min(1).max(60), label: z.string().trim().min(1).max(60), order: z.number().int().min(0).max(99),
  }).strict().nullable().optional(),
  north: z.number().min(0).lt(360).nullable().optional(),
  hvac: passthrough.optional(), water: passthrough.optional(), airflow: passthrough.optional(),
}).strict();
export type FloorplanAnnotations = z.infer<typeof annotationsSchema>;

/**
 * What the audit row records for the layer: the style, a COUNT per array,
 * floor and north. The arrays themselves are hundreds of coordinates nobody
 * can diff on a §11 record; the counts say what changed and the row stays
 * readable.
 */
export function annotationsSummary(a: unknown): Record<string, unknown> | null {
  if (!a || typeof a !== 'object') return null;
  const o = a as Record<string, unknown>;
  const n = (k: string) => (Array.isArray(o[k]) ? (o[k] as unknown[]).length : 0);
  return {
    style: typeof o.style === 'string' ? o.style : 'standard',
    columns: n('columns'), windows: n('windows'), walls: n('walls'), equipment: n('equipment'), labels: n('labels'),
    floor: o.floor ?? null, north: typeof o.north === 'number' ? o.north : null,
  };
}
```

Then in `floorplanSchema` add, after `sortOrder`:

```ts
  // Omitted = the column is left untouched (the `doors` rule); given = replaced
  // whole. `null` is refused: a client that meant "untouched" must not clear it.
  annotations: annotationsSchema.optional(),
```

In `routes.ts`, import `annotationsSummary` from `./validation.js` beside the existing imports, then:
- POST (`FLOORPLAN_CREATED` `afterValue`): add `annotations: annotationsSummary(plan.annotations),`.
- PUT (`FLOORPLAN_UPDATED`): `beforeValue: { name: before.name, isActive: before.isActive, sortOrder: before.sortOrder, annotations: annotationsSummary(before.annotations) }` and the same with `after`. The `before` lookup must select `annotations` — check the `findUnique` above the PUT's parse and add `annotations: true` to its `select` if it has one.

The Prisma write needs no change: `{ ...parsed.data }` carries `annotations` as a JSON object when given and `undefined` (ignored by Prisma) when omitted.

- [ ] **Step 4: Run the e2e and the existing floorplan suites**

Run, one at a time:
`cd apps/api && npx vitest run src/e2e/floorplan-annotations-write.e2e.test.ts`
`npx vitest run src/e2e/floorplan-annotations.e2e.test.ts`
`npx vitest run src/e2e/floorplans.e2e.test.ts`
`npm run lint`
Expected: all PASS; lint exit 0.

- [ ] **Step 5: Mutation check**

Copy `validation.ts` to `$TMP/validation.bak`. Change `annotations: annotationsSchema.optional(),` to `annotations: annotationsSchema.nullable().optional(),` — run the e2e: the `null` case must FAIL. Restore from the copy (`cp`), verify with `cmp`, re-run: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/floorplans/validation.ts apps/api/src/modules/floorplans/routes.ts apps/api/src/e2e/floorplan-annotations-write.e2e.test.ts
git commit -m "feat(floorplans): annotations validated and writable through the plan routes; audit rows carry a summary"
```

---

### Task 3: Designer state — types, tools and the reducer

**Files:**
- Modify: `apps/web/src/routes/config/layout-designer/types.ts`
- Modify: `apps/web/src/routes/config/layout-designer/tools.ts`
- Test: `apps/web/src/routes/config/layout-designer/__tests__/tools.test.ts` (append a describe)

**Interfaces:**
- Produces (types.ts): `DesignerAnnotations`, `StructureLayer`, `StructureBox`, `StructureSegment`, `StructureLabel`, `EMPTY_ANNOTATIONS`, `normaliseAnnotations(a: unknown): DesignerAnnotations`, `WINDOW_DEPTH = 0.008`, `SCRIPT_DRAWN_PLANS`, `isArchitectural(plan)`, `DesignerPlan.annotations?: DesignerAnnotations | null`.
- Produces (tools.ts): `Tool` extended with `'column' | 'equipment' | 'window' | 'wall' | 'label'`; `Selection` extended with `{ kind: 'structure'; layer: StructureLayer; index: number }`; `isBoxTool(t)`, `isSegmentTool(t)`, `isStructureTool(t)`, `layerOfTool(t): StructureLayer | null`.

- [ ] **Step 1: Write the failing tests**

Append to `tools.test.ts`:

```ts
import { isBoxTool, isSegmentTool, isStructureTool, layerOfTool } from '../tools';
import { normaliseAnnotations, EMPTY_ANNOTATIONS, isArchitectural } from '../types';

describe('2D structure tools (2026-10-05)', () => {
  it('classifies the five structure tools', () => {
    expect(['column', 'equipment'].every(isBoxTool)).toBe(true);
    expect(['window', 'wall'].every(isSegmentTool)).toBe(true);
    expect(['column', 'equipment', 'window', 'wall', 'label'].every(isStructureTool)).toBe(true);
    expect(['select', 'room', 'corridor', 'door', 'link'].some(isStructureTool)).toBe(false);
    expect(layerOfTool('column')).toBe('columns');
    expect(layerOfTool('equipment')).toBe('equipment');
    expect(layerOfTool('window')).toBe('windows');
    expect(layerOfTool('wall')).toBe('walls');
    expect(layerOfTool('label')).toBe('labels');
    expect(layerOfTool('room')).toBeNull();
  });

  it('a structure selection survives the reducer like any other', () => {
    const s = reduce(initialState, { type: 'select', selection: { kind: 'structure', layer: 'columns', index: 2 } });
    expect(s.selection).toEqual({ kind: 'structure', layer: 'columns', index: 2 });
    expect(reduce(s, { type: 'setTool', tool: 'window' }).selection).toBeNull();
  });

  it('normaliseAnnotations fills every layer and keeps the unknown ones', () => {
    expect(normaliseAnnotations(null)).toEqual(EMPTY_ANNOTATIONS);
    const a = normaliseAnnotations({ style: 'architectural', columns: [{ x: 0.1, y: 0.1, w: 0.02, h: 0.02 }], hvac: [{ x: 1 }] });
    expect(a.style).toBe('architectural');
    expect(a.columns).toHaveLength(1);
    expect(a.windows).toEqual([]);
    expect(a.labels).toEqual([]);
    expect(a.floor).toBeNull();
    expect(a.north).toBeNull();
    expect((a as { hvac?: unknown }).hvac).toEqual([{ x: 1 }]);
  });

  it('isArchitectural reads the style', () => {
    expect(isArchitectural({ annotations: { style: 'architectural' } })).toBe(true);
    expect(isArchitectural({ annotations: null })).toBe(false);
    expect(isArchitectural({})).toBe(false);
  });
});
```

(`reduce` and `initialState` are already imported at the top of `tools.test.ts`.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run src/routes/config/layout-designer/__tests__/tools.test.ts`
Expected: FAIL — the new exports do not exist.

- [ ] **Step 3: Implement**

In `types.ts`, after `DesignerPlan` (and add `annotations?: DesignerAnnotations | null;` to `DesignerPlan`):

```ts
/** The 2D layer of a plan as the designer holds it: every array present. */
export interface StructureBox { x: number; y: number; w: number; h: number }
export interface StructureSegment { x1: number; y1: number; x2: number; y2: number }
export interface StructureLabel { x: number; y: number; text: string }
export type StructureLayer = 'columns' | 'windows' | 'walls' | 'equipment' | 'labels';
export interface DesignerAnnotations {
  style: 'standard' | 'architectural';
  columns: StructureBox[];
  windows: StructureBox[];
  equipment: StructureBox[];
  walls: StructureSegment[];
  labels: StructureLabel[];
  floor: { group: string; label: string; order: number } | null;
  north: number | null;
  /** The trace scripts' own layers, carried through untouched. */
  hvac?: unknown[]; water?: unknown[]; airflow?: unknown[];
}
export const EMPTY_ANNOTATIONS: DesignerAnnotations = {
  style: 'standard', columns: [], windows: [], equipment: [], walls: [], labels: [], floor: null, north: null,
};

/** A plan's stored `annotations` (any shape the API returns) as the designer's full object. */
export function normaliseAnnotations(a: unknown): DesignerAnnotations {
  if (!a || typeof a !== 'object') return { ...EMPTY_ANNOTATIONS };
  const o = a as Record<string, unknown>;
  const arr = <T,>(k: string): T[] => (Array.isArray(o[k]) ? (o[k] as T[]) : []);
  const floor = o.floor && typeof o.floor === 'object' ? (o.floor as DesignerAnnotations['floor']) : null;
  return {
    style: o.style === 'architectural' ? 'architectural' : 'standard',
    columns: arr('columns'), windows: arr('windows'), equipment: arr('equipment'), walls: arr('walls'), labels: arr('labels'),
    floor, north: typeof o.north === 'number' ? o.north : null,
    ...(Array.isArray(o.hvac) ? { hvac: o.hvac } : {}),
    ...(Array.isArray(o.water) ? { water: o.water } : {}),
    ...(Array.isArray(o.airflow) ? { airflow: o.airflow } : {}),
  };
}

export function isArchitectural(plan: { annotations?: unknown } | null | undefined): boolean {
  const a = plan?.annotations;
  return !!a && typeof a === 'object' && (a as { style?: unknown }).style === 'architectural';
}

/** A window drawn along a wall is stored as a thin box this deep, centred on the wall line. */
export const WINDOW_DEPTH = 0.008;

/**
 * Plans drawn by a script (`draw-architectural-floor.ts`, `draw-qc-layout-2.ts`):
 * editable here, but the script's `*-layout.ts` is their source of truth and a
 * re-run overwrites what the designer changed. The Plan panel says so.
 */
export const SCRIPT_DRAWN_PLANS = [
  'CWH — QC', 'CWH — QC Microbiology', 'CWH — QC 3', 'CWH — Module-E',
  'CWH — Module-F — Ground Floor', 'CWH — Module-F — First Floor',
];
```

In `tools.ts`:

```ts
export type Tool = 'select' | 'room' | 'corridor' | 'door' | 'link' | 'column' | 'equipment' | 'window' | 'wall' | 'label';

export type Selection =
  | { kind: 'room'; roomId: string }
  | { kind: 'corner'; roomId: string; index: number }
  | { kind: 'door'; roomId: string; index: number }
  | { kind: 'link'; linkId: string }
  | { kind: 'structure'; layer: StructureLayer; index: number }
  | null;

/** The 2D structure tools (2026-10-05): a box is dragged, a segment is two clicks, a label is one. */
export const isBoxTool = (t: Tool): boolean => t === 'column' || t === 'equipment';
export const isSegmentTool = (t: Tool): boolean => t === 'window' || t === 'wall';
export const isStructureTool = (t: Tool): boolean => isBoxTool(t) || isSegmentTool(t) || t === 'label';
export function layerOfTool(t: Tool): StructureLayer | null {
  switch (t) {
    case 'column': return 'columns';
    case 'equipment': return 'equipment';
    case 'window': return 'windows';
    case 'wall': return 'walls';
    case 'label': return 'labels';
    default: return null;
  }
}
```

with `import type { StructureLayer } from './types';` at the top. The reducer body is unchanged: `addCorner` is reused by the segment tools for their two points (Task 5).

- [ ] **Step 4: Run the tests and the typecheck**

Run: `cd apps/web && npx vitest run src/routes/config/layout-designer/__tests__/tools.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS; tsc exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/config/layout-designer/types.ts apps/web/src/routes/config/layout-designer/tools.ts apps/web/src/routes/config/layout-designer/__tests__/tools.test.ts
git commit -m "feat(designer): 2D structure tools, structure selection and the annotations shape"
```

---

### Task 4: Plan panel — style, floor, north; saving the whole layer; a new plan is 2D

**Files:**
- Create: `apps/web/src/routes/config/layout-designer/plan-panel.tsx`
- Modify: `apps/web/src/routes/config/layout-designer/index.tsx` (state, `saveAnnotations`, `createPlan`, panel mount, toolbar group)
- Test: `apps/web/src/routes/config/layout-designer/__tests__/plan-panel.test.tsx` (new)

**Interfaces:**
- Produces (plan-panel.tsx): `PlanPropertiesPanel({ plan, annotations, saving, onSave, scriptDrawn })` where `onSave(next: DesignerAnnotations)`.
- Produces (index.tsx): `const annotations = normaliseAnnotations(plan?.annotations)`; `saveAnnotations(next: DesignerAnnotations, done: { title: string; message?: string } | null)`; `TOOLS` split into `BASE_TOOLS` and `STRUCTURE_TOOLS`.
- Consumes: Task 3's types and tool helpers.

- [ ] **Step 1: Write the failing page test**

```tsx
// apps/web/src/routes/config/layout-designer/__tests__/plan-panel.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The Plan panel (Layout Designer 2D, 2026-10-05): style, floor and north,
 * saved as ONE PUT of the plan's whole `annotations`; a new plan is created
 * in the 2D style; the structure tools show only for a 2D plan; the
 * script-drawn plans say so.
 */
const PLAN = { id: 'p1', name: 'Blank', imagePath: null, imageWidth: 1600, imageHeight: 1200, isActive: true, sortOrder: 0, rooms: [] as unknown[], links: [] as unknown[], annotations: null as unknown };
const PLANS = { current: { data: [PLAN] } as { data: typeof PLAN[] } };
const DETAIL = { current: { ...PLAN } };
const mutate = vi.fn();
vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (key === '/api/floorplans') return { data: PLANS.current, mutate };
    if (key && key.startsWith('/api/floorplans/')) return { data: DETAIL.current, mutate };
    if (key && key.startsWith('/api/instruments')) return { data: { data: [] }, mutate };
    return { data: undefined, mutate };
  },
}));
const post = vi.fn();
const put = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiClient: {
    post: (...a: unknown[]) => post(...a), put: (...a: unknown[]) => put(...a), delete: vi.fn(),
    postWithReauth: (...a: unknown[]) => post(...a), putWithReauth: (...a: unknown[]) => put(...a), deleteWithReauth: vi.fn(),
    get: vi.fn(), postFormData: vi.fn(),
  },
}));
vi.mock('@/lib/api-base', () => ({ getApiBase: () => '' }));
const toast = { success: vi.fn(), error: vi.fn(), successToast: vi.fn(), errorToast: vi.fn(), warning: vi.fn(), info: vi.fn() };
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/hooks/use-reauth', () => ({
  useReauth: () => ({
    execute: async (_a: string, cb: (pw?: string) => Promise<void>, opts?: { onSuccess?: () => void; onError?: (e: unknown) => void }) => {
      try { await cb(undefined); opts?.onSuccess?.(); } catch (e) { opts?.onError?.(e); }
    },
    needsReauth: () => false, executeWithResult: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), setPassword: vi.fn(),
    isOpen: false, password: '', error: '', isVerifying: false,
  }),
}));
vi.mock('@/components/reauth-dialog', () => ({ ReauthDialog: () => null }));

const { LayoutDesignerPage } = await import('../index');
const renderPage = () => render(<MemoryRouter><LayoutDesignerPage /></MemoryRouter>);

beforeEach(() => {
  PLANS.current = { data: [{ ...PLAN, annotations: null }] };
  DETAIL.current = { ...PLAN, annotations: null };
  post.mockReset().mockResolvedValue({ id: 'new' });
  put.mockReset().mockResolvedValue({});
  mutate.mockReset();
});

describe('Plan panel', () => {
  it('a standard plan shows Style = Standard and NO structure tools', () => {
    renderPage();
    expect((screen.getByLabelText('Style') as HTMLSelectElement).value).toBe('standard');
    expect(screen.queryByRole('button', { name: 'Column' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Window' })).toBeNull();
  });

  it('switching to 2D PUTs the whole annotations object with the new style and reveals the tools', async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText('Style'), { target: { value: 'architectural' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save plan' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/api/floorplans/p1', { annotations: expect.objectContaining({ style: 'architectural', columns: [], windows: [], walls: [], equipment: [], labels: [], floor: null, north: null }) }));
    PLANS.current = { data: [{ ...PLAN, annotations: { style: 'architectural' } }] };
    renderPage();
    expect(screen.getAllByRole('button', { name: 'Column' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Label' }).length).toBeGreaterThan(0);
  });

  it('floor and north save with the style; switching BACK to Standard keeps the structure', async () => {
    PLANS.current = { data: [{ ...PLAN, annotations: { style: 'architectural', columns: [{ x: 0.1, y: 0.1, w: 0.02, h: 0.02 }] } }] };
    renderPage();
    fireEvent.change(screen.getByLabelText('Floor group'), { target: { value: 'CWH — Module-X' } });
    fireEvent.change(screen.getByLabelText('Floor label'), { target: { value: 'First Floor' } });
    fireEvent.change(screen.getByLabelText('Floor order'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('North (degrees)'), { target: { value: '90' } });
    fireEvent.change(screen.getByLabelText('Style'), { target: { value: 'standard' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save plan' }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    const [, body] = put.mock.calls[0] as [string, { annotations: Record<string, unknown> }];
    expect(body.annotations.style).toBe('standard');
    expect(body.annotations.floor).toEqual({ group: 'CWH — Module-X', label: 'First Floor', order: 1 });
    expect(body.annotations.north).toBe(90);
    expect(body.annotations.columns).toEqual([{ x: 0.1, y: 0.1, w: 0.02, h: 0.02 }]);
  });

  it('a NEW plan is created in the 2D style', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'New plan' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Fresh' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create plan' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/floorplans', expect.objectContaining({ name: 'Fresh', annotations: { style: 'architectural' } })));
  });

  it('a script-drawn plan says a re-run overwrites designer edits', () => {
    PLANS.current = { data: [{ ...PLAN, name: 'CWH — QC', annotations: { style: 'architectural' } }] };
    renderPage();
    expect(screen.getByText(/drawn by a script/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run src/routes/config/layout-designer/__tests__/plan-panel.test.tsx`
Expected: FAIL — no `Style` field.

- [ ] **Step 3: Create the panel**

```tsx
// apps/web/src/routes/config/layout-designer/plan-panel.tsx
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormSection } from '@/components/ui/form-section';
import type { DesignerAnnotations } from './types';

/**
 * The PLAN's own properties (Layout Designer 2D, 2026-10-05): style, floor,
 * north. Shown when nothing on the canvas is selected. Saved as ONE PUT of
 * the whole `annotations` object — the structure arrays ride along
 * untouched, which is what lets a switch back to Standard keep them.
 */
export function PlanPropertiesPanel({ planName, annotations, saving, scriptDrawn, onSave }: {
  planName: string;
  annotations: DesignerAnnotations;
  saving: boolean;
  scriptDrawn: boolean;
  onSave: (next: DesignerAnnotations) => void;
}) {
  const [style, setStyle] = useState(annotations.style);
  const [group, setGroup] = useState(annotations.floor?.group ?? '');
  const [label, setLabel] = useState(annotations.floor?.label ?? '');
  const [order, setOrder] = useState(annotations.floor ? String(annotations.floor.order) : '0');
  const [north, setNorth] = useState(annotations.north == null ? '' : String(annotations.north));
  useEffect(() => {
    setStyle(annotations.style);
    setGroup(annotations.floor?.group ?? ''); setLabel(annotations.floor?.label ?? '');
    setOrder(annotations.floor ? String(annotations.floor.order) : '0');
    setNorth(annotations.north == null ? '' : String(annotations.north));
  }, [annotations]);

  const save = () => {
    const g = group.trim(), l = label.trim();
    const n = north.trim() === '' ? null : Number(north);
    onSave({
      ...annotations,
      style,
      floor: g || l ? { group: g || l, label: l || g, order: Math.max(0, Math.min(99, Math.round(Number(order) || 0))) } : null,
      north: n != null && Number.isFinite(n) ? ((n % 360) + 360) % 360 : null,
    });
  };

  return (
    <FormSection title={`Plan ${planName}`} columns={1}>
      {scriptDrawn && (
        <p className="text-xs text-amber-700">This plan is drawn by a script; re-running it overwrites edits made here.</p>
      )}
      <div className="grid gap-3 sm:grid-cols-5">
        <div>
          <label htmlFor="ld-style" className="mb-1 block text-xs font-medium text-slate-600">Style</label>
          <select id="ld-style" value={style} onChange={(e) => setStyle(e.target.value as DesignerAnnotations['style'])} className="ctl w-full">
            <option value="standard">Standard</option>
            <option value="architectural">2D architectural</option>
          </select>
        </div>
        <div>
          <label htmlFor="ld-floor-group" className="mb-1 block text-xs font-medium text-slate-600">Floor group</label>
          <Input id="ld-floor-group" value={group} onChange={(e) => setGroup(e.target.value)} placeholder="Building, when it has several floors" />
        </div>
        <div>
          <label htmlFor="ld-floor-label" className="mb-1 block text-xs font-medium text-slate-600">Floor label</label>
          <Input id="ld-floor-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Ground Floor" />
        </div>
        <div>
          <label htmlFor="ld-floor-order" className="mb-1 block text-xs font-medium text-slate-600">Floor order</label>
          <Input id="ld-floor-order" type="number" min={0} max={99} value={order} onChange={(e) => setOrder(e.target.value)} />
        </div>
        <div>
          <label htmlFor="ld-north" className="mb-1 block text-xs font-medium text-slate-600">North (degrees)</label>
          <Input id="ld-north" type="number" min={0} max={359} value={north} onChange={(e) => setNorth(e.target.value)} placeholder="blank = no compass" />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save plan'}</Button>
      </div>
    </FormSection>
  );
}
```

- [ ] **Step 4: Wire the page**

In `index.tsx`:

1. Imports: `import { PlanPropertiesPanel } from './plan-panel';` and extend the types import: `import { CANVAS_PRESETS, normaliseAnnotations, isArchitectural, SCRIPT_DRAWN_PLANS, type DesignerAnnotations, type DesignerPlan, type DesignerRoom } from './types';` and the tools import: `import { reduce, initialState, closedPolygon, isStructureTool, type Tool } from './tools';`.

2. Replace the `TOOLS` constant with two:

```tsx
const BASE_TOOLS: { id: Tool; label: string; hint: string }[] = [
  { id: 'select', label: 'Select', hint: 'Click a room to select it; drag to move; drag a corner to reshape; double-click a wall to add a corner' },
  { id: 'room', label: 'Draw room', hint: 'Click corner by corner; Enter or click the first corner to close; Escape to discard; Shift for straight walls' },
  { id: 'corridor', label: 'Draw corridor', hint: 'As Draw room, graded Corridor' },
  { id: 'door', label: 'Door', hint: 'Click a wall of a room to place a door' },
  { id: 'link', label: 'Link', hint: 'Click one room, then another: an opening if they share a wall, else a connector' },
];
/** The 2D layer's tools (2026-10-05) — shown only on a 2D plan; the standard drawing shows none of what they draw. */
const STRUCTURE_TOOLS: { id: Tool; label: string; hint: string }[] = [
  { id: 'column', label: 'Column', hint: 'Drag a box: a structural column, hatched on the floor' },
  { id: 'equipment', label: 'Equipment', hint: 'Drag a box: fixed plant, outlined on the floor' },
  { id: 'window', label: 'Window', hint: 'Click two points along a wall: a window set into it' },
  { id: 'wall', label: 'Wall stub', hint: 'Click two points: a partition the rooms do not describe' },
  { id: 'label', label: 'Label', hint: 'Click where a text label goes, then type it in the panel' },
];
```

3. After `const selectedLink = …` add:

```tsx
  const annotations = useMemo(() => normaliseAnnotations(plan?.annotations), [plan]);
  const arch = isArchitectural(plan);
  const tools = arch ? [...BASE_TOOLS, ...STRUCTURE_TOOLS] : BASE_TOOLS;
  const selectedStructure = state.selection?.kind === 'structure' ? state.selection : null;
```

and, after the `run` helper:

```tsx
  /** The ONE write of the 2D layer: the whole object, replaced (the `doors` rule). */
  const saveAnnotations = (next: DesignerAnnotations, done: { title: string; message?: string } | null, onDone?: () => void) => {
    if (!plan) return;
    run('UPDATE_FLOORPLAN', async (pw) => { await put(`/api/floorplans/${plan.id}`, { annotations: next }, pw); }, done, onDone);
  };
```

4. `createPlan`: the body becomes `{ name: …, imagePath: null, imageWidth: preset.width, imageHeight: preset.height, annotations: { style: 'architectural' } }`, and the toast message `…blank ${preset.label.toLowerCase()} canvas in the 2D style. Draw rooms on it.`

5. Toolbar: replace `{TOOLS.map((t) => (` with `{tools.map((t) => (`; in the status line replace `TOOLS.find(` with `tools.find(`. If the current tool is a structure tool and the plan is not 2D (a plan switch), reset: add inside the plan-select `onChange` nothing new — `setTool('select')` is already dispatched there.

6. Mount the panel: before `{plan && pending && (` add

```tsx
      {plan && !pending && !selectedRoom && !selectedLink && !selectedStructure && (
        <PlanPropertiesPanel
          planName={plan.name} annotations={annotations} saving={saving}
          scriptDrawn={SCRIPT_DRAWN_PLANS.includes(plan.name)}
          onSave={(next) => saveAnnotations(next, { title: 'Plan saved', message: `${plan.name}: ${next.style === 'architectural' ? '2D architectural' : 'standard'} style.` })}
        />
      )}
```

(`selectedStructure` is used by Task 5's structure panel; declaring it now keeps the mount rule in one place.)

- [ ] **Step 5: Run the test file, the existing designer page test, and tsc**

Run, one at a time:
`cd apps/web && npx vitest run src/routes/config/layout-designer/__tests__/plan-panel.test.tsx`
`npx vitest run src/routes/config/layout-designer/__tests__/designer-page.test.tsx`
`npx tsc --noEmit -p tsconfig.json`
Expected: PASS, PASS, exit 0.

- [ ] **Step 6: Mutation check (tools hidden in standard)**

Copy `index.tsx` to `$TMP/ld-index.bak`; change `const tools = arch ? […] : BASE_TOOLS;` to `const tools = [...BASE_TOOLS, ...STRUCTURE_TOOLS];` — the first plan-panel case must FAIL. Restore from the copy, `cmp`, re-run: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/routes/config/layout-designer/plan-panel.tsx apps/web/src/routes/config/layout-designer/index.tsx apps/web/src/routes/config/layout-designer/__tests__/plan-panel.test.tsx
git commit -m "feat(designer): Plan panel — style, floor, north; new plans are 2D; structure tools only on a 2D plan"
```

---

### Task 5: Canvas — drawing, placing, selecting, moving and deleting structure; the 2D look

**Files:**
- Modify: `apps/web/src/routes/config/layout-designer/canvas.tsx`
- Create: `apps/web/src/routes/config/layout-designer/structure-panel.tsx`
- Modify: `apps/web/src/routes/config/layout-designer/index.tsx` (structure handlers, panel mount, `deleteSelection`, `selectionLabel`)
- Test: `apps/web/src/routes/config/layout-designer/__tests__/structure-tools.test.tsx` (new)

**Interfaces:**
- Produces (canvas props): `onAddStructure(layer: StructureLayer, element: StructureBox | StructureSegment | StructureLabel): void`, `onMoveStructure(layer: StructureLayer, index: number, element: StructureBox | StructureSegment | StructureLabel): void`, `annotations: DesignerAnnotations`.
- Produces (structure-panel.tsx): `StructurePropertiesPanel({ layer, index, element, saving, onChange, onDelete, onCancel })`.
- Produces (index.tsx): `addStructure`, `updateStructure`, `removeStructure`.
- Consumes: Task 1 `segmentOnEdge`; Task 3 types / tool helpers; Task 4 `saveAnnotations`, `annotations`, `arch`.

- [ ] **Step 1: Write the failing tests**

Use the same mock block as `plan-panel.test.tsx` (copy it verbatim — the engineer may read this task alone), plus the `PointerEvent` polyfill, `stubCanvas` and `clickAt` helpers from `designer-page.test.tsx` (copy them verbatim too). `PLANS.current` for every case is a 2D plan with one rectangle room:

```tsx
const rect = (id: string, code: string, x: number, y: number, w: number, h: number) => ({
  id, code, label: null, grade: null, x, y, w, h, tempMin: null, tempMax: null, rhMin: null, rhMax: null, doors: null, points: null,
});
const twoD = (annotations: Record<string, unknown> = {}) => ({
  ...PLAN, annotations: { style: 'architectural', ...annotations }, rooms: [rect('A', 'A', 0.2, 0.2, 0.4, 0.3)],
});
const lastPut = () => put.mock.calls[put.mock.calls.length - 1] as [string, { annotations: Record<string, unknown[]> }];

describe('structure tools on a 2D plan', () => {
  it('Column: a drag stores a snapped box through one PUT of the whole layer', async () => {
    PLANS.current = { data: [twoD()] };
    renderPage();
    const svg = stubCanvas();
    fireEvent.click(screen.getByRole('button', { name: 'Column' }));
    clickAt(svg, 100, 100);                                             // 0.10, 0.133
    fireEvent.pointerMove(svg, { clientX: 140, clientY: 130, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 140, clientY: 130, pointerId: 1 });
    await waitFor(() => expect(put).toHaveBeenCalled());
    const [url, body] = lastPut();
    expect(url).toBe('/api/floorplans/p1');
    expect(body.annotations.columns).toHaveLength(1);
    const c = body.annotations.columns[0] as { x: number; y: number; w: number; h: number };
    expect(c.x).toBeCloseTo(0.1, 2); expect(c.w).toBeCloseTo(0.04, 2); expect(c.h).toBeCloseTo(0.04, 2);
  });

  it('Equipment: the same gesture stores into the equipment layer', async () => {
    PLANS.current = { data: [twoD()] };
    renderPage();
    const svg = stubCanvas();
    fireEvent.click(screen.getByRole('button', { name: 'Equipment' }));
    clickAt(svg, 300, 300);
    fireEvent.pointerMove(svg, { clientX: 360, clientY: 330, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 360, clientY: 330, pointerId: 1 });
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(lastPut()[1].annotations.equipment).toHaveLength(1);
    expect(lastPut()[1].annotations.columns).toEqual([]);
  });

  it('Window: two clicks along the room\'s top wall store a thin box ON the wall', async () => {
    PLANS.current = { data: [twoD()] };
    renderPage();
    const svg = stubCanvas();
    fireEvent.click(screen.getByRole('button', { name: 'Window' }));
    clickAt(svg, 300, 152);   // y 0.2027, beside the top wall at y 0.2
    clickAt(svg, 400, 148);   // y 0.1973
    await waitFor(() => expect(put).toHaveBeenCalled());
    const w = lastPut()[1].annotations.windows[0] as { x: number; y: number; w: number; h: number };
    expect(w.x).toBeCloseTo(0.3, 3);
    expect(w.w).toBeCloseTo(0.1, 3);
    expect(w.y).toBeCloseTo(0.2 - 0.004, 3);
    expect(w.h).toBeCloseTo(0.008, 3);
  });

  it('Wall stub: two clicks across a room store a free segment', async () => {
    PLANS.current = { data: [twoD()] };
    renderPage();
    const svg = stubCanvas();
    fireEvent.click(screen.getByRole('button', { name: 'Wall stub' }));
    clickAt(svg, 300, 250);
    clickAt(svg, 300, 330);
    await waitFor(() => expect(put).toHaveBeenCalled());
    const s = lastPut()[1].annotations.walls[0] as { x1: number; y1: number; x2: number; y2: number };
    expect(s.x1).toBeCloseTo(0.3, 2); expect(s.x2).toBeCloseTo(0.3, 2);
    expect(s.y2 - s.y1).toBeCloseTo(80 / 750, 2);
  });

  it('Label: one click stores a label and the panel edits its text', async () => {
    PLANS.current = { data: [twoD()] };
    renderPage();
    const svg = stubCanvas();
    fireEvent.click(screen.getByRole('button', { name: 'Label' }));
    clickAt(svg, 500, 400);
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect((lastPut()[1].annotations.labels[0] as { text: string }).text).toBe('Label');
  });

  it('selecting a structure element shows its numbers; Delete removes just it, the room stays', async () => {
    PLANS.current = { data: [twoD({ columns: [{ x: 0.1, y: 0.1, w: 0.02, h: 0.02 }] })] };
    renderPage();
    stubCanvas();
    // Select the room first, then the column: the Delete key must take the column.
    clickAt(screen.getByTestId('room-A'), 300, 250);
    fireEvent.pointerUp(screen.getByTestId('designer-canvas'));
    clickAt(screen.getByTestId('structure-columns-0'), 110, 90);
    fireEvent.pointerUp(screen.getByTestId('designer-canvas'));
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('0.1');
    fireEvent.keyDown(window, { key: 'Delete' });
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(lastPut()[1].annotations.columns).toEqual([]);
    expect(put.mock.calls.every(([u]) => u === '/api/floorplans/p1')).toBe(true); // never the room endpoint
  });

  it('editing a number in the panel saves the element in place', async () => {
    PLANS.current = { data: [twoD({ labels: [{ x: 0.5, y: 0.5, text: 'HPLC' }] })] };
    renderPage();
    stubCanvas();
    clickAt(screen.getByTestId('structure-labels-0'), 500, 375);
    fireEvent.pointerUp(screen.getByTestId('designer-canvas'));
    fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'GC ROOM' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save element' }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(lastPut()[1].annotations.labels).toEqual([{ x: 0.5, y: 0.5, text: 'GC ROOM' }]);
  });

  it('a 2D plan draws the structure layer in the designer', () => {
    PLANS.current = { data: [twoD({ columns: [{ x: 0.1, y: 0.1, w: 0.02, h: 0.02 }], windows: [{ x: 0.3, y: 0.196, w: 0.1, h: 0.008 }], walls: [{ x1: 0.5, y1: 0.5, x2: 0.5, y2: 0.6 }], equipment: [{ x: 0.3, y: 0.3, w: 0.05, h: 0.03 }], labels: [{ x: 0.5, y: 0.5, text: 'HPLC' }] })] };
    renderPage();
    const layer = screen.getByTestId('ld-structure');
    expect(layer.querySelectorAll('[data-structure="column"]')).toHaveLength(1);
    expect(layer.querySelectorAll('[data-structure="window"]')).toHaveLength(1);
    expect(layer.querySelectorAll('[data-structure="wall"]')).toHaveLength(1);
    expect(layer.querySelectorAll('[data-structure="equipment"]')).toHaveLength(1);
    expect(screen.getByText('HPLC')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run src/routes/config/layout-designer/__tests__/structure-tools.test.tsx`
Expected: FAIL — no `Column` button / no structure layer.

- [ ] **Step 3: The structure panel**

```tsx
// apps/web/src/routes/config/layout-designer/structure-panel.tsx
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormSection } from '@/components/ui/form-section';
import type { StructureBox, StructureLabel, StructureLayer, StructureSegment } from './types';

export type StructureElement = StructureBox | StructureSegment | StructureLabel;

const TITLE: Record<StructureLayer, string> = { columns: 'Column', windows: 'Window', walls: 'Wall stub', equipment: 'Equipment', labels: 'Label' };

/**
 * The selected structure element's numbers (Layout Designer 2D, 2026-10-05),
 * editable in place: a box's x / y / w / h, a segment's two ends, a label's
 * position and text. Plan units, shown to four places. Save replaces the one
 * element; the page writes the whole layer.
 */
export function StructurePropertiesPanel({ layer, index, element, saving, onChange, onDelete, onCancel }: {
  layer: StructureLayer; index: number; element: StructureElement; saving: boolean;
  onChange: (next: StructureElement) => void; onDelete: () => void; onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  useEffect(() => {
    const d: Record<string, string> = {};
    for (const [k, v] of Object.entries(element)) d[k] = typeof v === 'number' ? String(Math.round(v * 1e4) / 1e4) : String(v);
    setDraft(d);
  }, [element]);
  const fields = layer === 'walls' ? ['x1', 'y1', 'x2', 'y2'] : layer === 'labels' ? ['x', 'y', 'text'] : ['x', 'y', 'w', 'h'];
  const label = (k: string) => (k === 'text' ? 'Text' : k.toUpperCase());
  const save = () => {
    const next: Record<string, number | string> = {};
    for (const k of fields) next[k] = k === 'text' ? (draft[k] ?? '').trim() : Math.min(1, Math.max(0, Number(draft[k]) || 0));
    onChange(next as unknown as StructureElement);
  };
  return (
    <FormSection title={`${TITLE[layer]} ${index + 1}`} columns={1}>
      <div className="grid gap-3 sm:grid-cols-4">
        {fields.map((k) => (
          <div key={k}>
            <label htmlFor={`ld-st-${k}`} className="mb-1 block text-xs font-medium text-slate-600">{label(k)}</label>
            <Input id={`ld-st-${k}`} type={k === 'text' ? 'text' : 'number'} step={k === 'text' ? undefined : 0.001} maxLength={k === 'text' ? 60 : undefined}
              value={draft[k] ?? ''} onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))} />
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save element'}</Button>
        <Button variant="outline" onClick={onDelete} disabled={saving}>Delete element</Button>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>
      </div>
    </FormSection>
  );
}
```

- [ ] **Step 4: The canvas**

In `canvas.tsx`:

1. Imports: add `segmentOnEdge` to the `@digilog/shared` import; `import { isBoxTool, isSegmentTool, layerOfTool, type DesignerAction, type DesignerState } from './tools';`; add `WINDOW_DEPTH, type DesignerAnnotations, type StructureLayer, type StructureBox, type StructureSegment, type StructureLabel` to the `./types` import.

2. `CanvasProps` gains:

```ts
  annotations: DesignerAnnotations;
  arch: boolean;
  onAddStructure: (layer: StructureLayer, element: StructureBox | StructureSegment | StructureLabel) => void;
  onMoveStructure: (layer: StructureLayer, index: number, element: StructureBox | StructureSegment | StructureLabel) => void;
```

3. A second local drag state beside `drag`:

```ts
  /** A box being dragged out by a box tool, or a structure element being moved. */
  const [sdrag, setSdrag] = useState<
    | { kind: 'box'; layer: 'columns' | 'equipment'; from: Point; to: Point }
    | { kind: 'move'; layer: StructureLayer; index: number; origin: Point; start: StructureBox | StructureSegment | StructureLabel; preview: StructureBox | StructureSegment | StructureLabel; moved: boolean }
    | null
  >(null);
  const boxTool = isBoxTool(state.tool), segmentTool = isSegmentTool(state.tool);
```

4. `onBackgroundDown`, before the `drawingTool` branch:

```ts
    if (boxTool) {
      const p = snapPoint(raw, [], { grid: showGrid });
      setSdrag({ kind: 'box', layer: state.tool === 'column' ? 'columns' : 'equipment', from: p, to: p });
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      return;
    }
    if (segmentTool) {
      const d = state.drawing ?? [];
      if (d.length === 0) { dispatch({ type: 'addCorner', point: raw }); return; }
      const snapped = segmentOnEdge(d[0], raw, plan.rooms.map(roomPolygon));
      const a = snapped.a, b = snapped.b;
      if (state.tool === 'window') {
        // A window is stored as the thin box the traces store: along the
        // segment, WINDOW_DEPTH deep, centred on the wall line.
        const horizontal = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
        const box = horizontal
          ? { x: r6(Math.min(a.x, b.x)), y: r6(a.y - WINDOW_DEPTH / 2), w: r6(Math.abs(b.x - a.x)), h: WINDOW_DEPTH }
          : { x: r6(a.x - WINDOW_DEPTH / 2), y: r6(Math.min(a.y, b.y)), w: WINDOW_DEPTH, h: r6(Math.abs(b.y - a.y)) };
        if (box.w <= 0 || box.h <= 0) { dispatch({ type: 'flash', message: 'A window needs two different points.' }); return; }
        onAddStructure('windows', box);
      } else {
        if (a.x === b.x && a.y === b.y) { dispatch({ type: 'flash', message: 'A wall stub needs two different points.' }); return; }
        onAddStructure('walls', { x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      }
      dispatch({ type: 'cancel' });
      return;
    }
    if (state.tool === 'label') {
      onAddStructure('labels', { x: r6(raw.x), y: r6(raw.y), text: 'Label' });
      return;
    }
```

5. `onMove`: at the top, after `const raw = toPlan(e);`:

```ts
    if (sdrag?.kind === 'box') { setSdrag({ ...sdrag, to: snapPoint(raw, [], { grid: showGrid }) }); return; }
    if (sdrag?.kind === 'move') {
      const dx = raw.x - sdrag.origin.x, dy = raw.y - sdrag.origin.y;
      const s = sdrag.start as Record<string, number | string>;
      const preview: Record<string, number | string> = { ...s };
      for (const k of ['x', 'x1', 'x2']) if (typeof s[k] === 'number') preview[k] = r6(Math.min(1, Math.max(0, (s[k] as number) + dx)));
      for (const k of ['y', 'y1', 'y2']) if (typeof s[k] === 'number') preview[k] = r6(Math.min(1, Math.max(0, (s[k] as number) + dy)));
      setSdrag({ ...sdrag, preview: preview as typeof sdrag.preview, moved: Math.abs(dx) > 1e-6 || Math.abs(dy) > 1e-6 });
      return;
    }
    if (segmentTool && state.drawing?.length) setHover(raw);
```

6. `onUp`: at the top:

```ts
    if (sdrag?.kind === 'box') {
      const d = sdrag; setSdrag(null);
      const x = Math.min(d.from.x, d.to.x), y = Math.min(d.from.y, d.to.y);
      const w = r6(Math.abs(d.to.x - d.from.x)), h = r6(Math.abs(d.to.y - d.from.y));
      if (w < GRID / 2 || h < GRID / 2) { dispatch({ type: 'flash', message: 'Drag out a box to place it.' }); return; }
      onAddStructure(d.layer, { x: r6(x), y: r6(y), w, h });
      return;
    }
    if (sdrag?.kind === 'move') {
      const d = sdrag; setSdrag(null);
      if (d.moved) onMoveStructure(d.layer, d.index, d.preview);
      return;
    }
```

4b. In `onRoomDown`, right after `if (drawingTool) return;`, add
`if (boxTool || segmentTool || state.tool === 'label') return;` — a structure
tool's click that lands INSIDE a room must bubble to the svg's
`onBackgroundDown` (the window test clicks just inside the top wall), exactly
as the drawing tools already do; without it the select branch would run.

7. A structure-element pointer-down handler:

```ts
  const onStructureDown = (e: ReactPointerEvent<SVGElement>, layer: StructureLayer, index: number, el: StructureBox | StructureSegment | StructureLabel) => {
    if (e.button !== 0 || state.tool !== 'select') return;
    e.stopPropagation();
    dispatch({ type: 'select', selection: { kind: 'structure', layer, index } });
    setSdrag({ kind: 'move', layer, index, origin: toPlan(e), start: el, preview: el, moved: false });
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };
```

8. The 2D look for rooms: where walls are drawn (`{walls.map((s, i) => (<line … stroke={isSelected ? '#2563eb' : '#1f2937'} strokeWidth={2.5} />))}`), wrap: when `arch`, draw each wall twice — `stroke="#1e293b" strokeWidth={7} strokeLinecap="square"` then `stroke="#e2e8f0" strokeWidth={2.2} strokeLinecap="square"` (selected: `#2563eb` outer) — the dashboard's navy-with-light-core; otherwise exactly as now. For doors, when `arch` draw the arc `strokeDasharray="4 3"` with `strokeWidth={1.3}` and the leaf `strokeWidth={2.5}`; `polygonDoorPlacements` already honours `hinge` and `swing`.

9. The structure layer, rendered after the rooms and links and before `pending` (a `<g data-testid="ld-structure">`), with the preview of a box being dragged:

```tsx
      <g data-testid="ld-structure">
        {annotations.walls.map((s, i) => {
          const el = sdrag?.kind === 'move' && sdrag.layer === 'walls' && sdrag.index === i ? (sdrag.preview as StructureSegment) : s;
          const sel = state.selection?.kind === 'structure' && state.selection.layer === 'walls' && state.selection.index === i;
          return (
            <g key={`sw${i}`} data-testid={`structure-walls-${i}`} data-structure="wall" onPointerDown={(e) => onStructureDown(e, 'walls', i, s)} style={{ cursor: state.tool === 'select' ? 'move' : undefined }}>
              <line x1={el.x1 * VB_W} y1={el.y1 * vbH} x2={el.x2 * VB_W} y2={el.y2 * vbH} stroke="transparent" strokeWidth={12} />
              <line x1={el.x1 * VB_W} y1={el.y1 * vbH} x2={el.x2 * VB_W} y2={el.y2 * vbH} stroke={sel ? '#2563eb' : '#1e293b'} strokeWidth={arch ? 7 : 2.5} strokeLinecap="butt" pointerEvents="none" />
              {arch && <line x1={el.x1 * VB_W} y1={el.y1 * vbH} x2={el.x2 * VB_W} y2={el.y2 * vbH} stroke="#e2e8f0" strokeWidth={2.2} strokeLinecap="butt" pointerEvents="none" />}
            </g>
          );
        })}
        {(['windows', 'columns', 'equipment'] as const).map((layer) => annotations[layer].map((b, i) => {
          const el = sdrag?.kind === 'move' && sdrag.layer === layer && sdrag.index === i ? (sdrag.preview as StructureBox) : b;
          const sel = state.selection?.kind === 'structure' && state.selection.layer === layer && state.selection.index === i;
          const look = layer === 'windows' ? { fill: '#e0f2fe', stroke: '#0369a1' } : layer === 'columns' ? { fill: '#cbd5e1', stroke: '#1e293b' } : { fill: '#ffffff', stroke: '#1e293b' };
          return (
            <rect key={`${layer}${i}`} data-testid={`structure-${layer}-${i}`} data-structure={layer === 'windows' ? 'window' : layer === 'columns' ? 'column' : 'equipment'}
              x={el.x * VB_W} y={el.y * vbH} width={el.w * VB_W} height={el.h * vbH}
              fill={look.fill} stroke={sel ? '#2563eb' : look.stroke} strokeWidth={sel ? 2.4 : 1.5}
              onPointerDown={(e) => onStructureDown(e, layer, i, b)} style={{ cursor: state.tool === 'select' ? 'move' : undefined }} />
          );
        }))}
        {annotations.labels.map((l, i) => {
          const el = sdrag?.kind === 'move' && sdrag.layer === 'labels' && sdrag.index === i ? (sdrag.preview as StructureLabel) : l;
          const sel = state.selection?.kind === 'structure' && state.selection.layer === 'labels' && state.selection.index === i;
          return (
            <text key={`lb${i}`} data-testid={`structure-labels-${i}`} data-structure="label" x={el.x * VB_W} y={el.y * vbH} textAnchor="middle" fontSize={8} fill={sel ? '#2563eb' : '#334155'} letterSpacing="0.04em"
              onPointerDown={(e) => onStructureDown(e, 'labels', i, l)} style={{ cursor: state.tool === 'select' ? 'move' : undefined }}>{el.text}</text>
          );
        })}
        {sdrag?.kind === 'box' && (
          <rect x={Math.min(sdrag.from.x, sdrag.to.x) * VB_W} y={Math.min(sdrag.from.y, sdrag.to.y) * vbH}
            width={Math.abs(sdrag.to.x - sdrag.from.x) * VB_W} height={Math.abs(sdrag.to.y - sdrag.from.y) * vbH}
            fill="#bfdbfe" fillOpacity={0.5} stroke="#2563eb" strokeWidth={1.5} strokeDasharray="4 3" pointerEvents="none" />
        )}
        {segmentTool && state.drawing?.length === 1 && hover && (
          <line x1={state.drawing[0].x * VB_W} y1={state.drawing[0].y * vbH} x2={hover.x * VB_W} y2={hover.y * vbH} stroke="#2563eb" strokeWidth={1.5} strokeDasharray="4 3" pointerEvents="none" />
        )}
      </g>
```

10. The cursor: extend the `style.cursor` expression with `boxTool || segmentTool || state.tool === 'label' ? 'crosshair' : …`. The `aria-label` is unchanged.

- [ ] **Step 5: Wire the page**

In `index.tsx`:

1. Imports: `import { StructurePropertiesPanel, type StructureElement } from './structure-panel';` and `type StructureLayer` from `./types`.

2. After `saveAnnotations`:

```tsx
  const addStructure = (layer: StructureLayer, element: StructureElement) => {
    const next = { ...annotations, [layer]: [...annotations[layer], element] } as DesignerAnnotations;
    saveAnnotations(next, null, () => dispatch({ type: 'select', selection: { kind: 'structure', layer, index: annotations[layer].length } }));
  };
  const updateStructure = (layer: StructureLayer, index: number, element: StructureElement) => {
    const list = [...annotations[layer]] as StructureElement[];
    list[index] = element;
    saveAnnotations({ ...annotations, [layer]: list } as DesignerAnnotations, null);
  };
  const removeStructure = (layer: StructureLayer, index: number) => {
    const list = (annotations[layer] as StructureElement[]).filter((_, i) => i !== index);
    saveAnnotations({ ...annotations, [layer]: list } as DesignerAnnotations, { title: 'Element removed' }, () => dispatch({ type: 'select', selection: null }));
  };
```

3. `deleteSelection`: as its FIRST branch add `if (state.selection.kind === 'structure') { removeStructure(state.selection.layer, state.selection.index); return; }` (so the Delete key takes the element, never the room).

4. `selectionLabel`: add the branch `: state.selection.kind === 'structure' ? \`${state.selection.layer.replace(/s$/, '')} ${state.selection.index + 1}\``.

5. Canvas props: add `annotations={annotations} arch={arch} onAddStructure={addStructure} onMoveStructure={updateStructure}`.

6. Mount the panel after the link panel:

```tsx
      {plan && selectedStructure && annotations[selectedStructure.layer][selectedStructure.index] && (
        <StructurePropertiesPanel
          layer={selectedStructure.layer} index={selectedStructure.index}
          element={annotations[selectedStructure.layer][selectedStructure.index] as StructureElement}
          saving={saving}
          onChange={(el) => updateStructure(selectedStructure.layer, selectedStructure.index, el)}
          onDelete={() => removeStructure(selectedStructure.layer, selectedStructure.index)}
          onCancel={() => dispatch({ type: 'select', selection: null })}
        />
      )}
```

7. The Escape handler already dispatches `cancel`, which clears a half-drawn segment.

- [ ] **Step 6: Run the tests and tsc**

Run, one at a time:
`cd apps/web && npx vitest run src/routes/config/layout-designer/__tests__/structure-tools.test.tsx`
`npx vitest run src/routes/config/layout-designer/__tests__/plan-panel.test.tsx`
`npx vitest run src/routes/config/layout-designer/__tests__/designer-page.test.tsx`
`npx tsc --noEmit -p tsconfig.json`
Expected: all PASS; tsc exit 0.

- [ ] **Step 7: Mutation check**

Copy `index.tsx` to a backup; remove the `structure` branch from `deleteSelection` — the "Delete removes just it" case must FAIL (the room endpoint is called instead). Restore from the copy, `cmp`, re-run: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/routes/config/layout-designer/canvas.tsx apps/web/src/routes/config/layout-designer/structure-panel.tsx apps/web/src/routes/config/layout-designer/index.tsx apps/web/src/routes/config/layout-designer/__tests__/structure-tools.test.tsx
git commit -m "feat(designer): column, equipment, window, wall-stub and label tools; structure selection, move, edit and delete; the 2D look on the canvas"
```

---

### Task 6: Doors in 2D — hinge, swing, width and the double leaf

**Files:**
- Modify: `apps/web/src/routes/config/layout-designer/properties-panel.tsx:70-95` (the door rows)
- Test: `apps/web/src/routes/config/layout-designer/__tests__/door-controls.test.tsx` (new)

**Interfaces:**
- Consumes: Task 1 `splitDoor` from `@digilog/shared`.
- The room PUT body is unchanged in shape: `doors[]` entries carry `hinge` / `swing` / `width`.

- [ ] **Step 1: Write the failing test**

Same mock block, polyfill and helpers as Task 4 (copy verbatim). A 2D plan with one room carrying one door:

```tsx
const withDoor = { ...PLAN, annotations: { style: 'architectural' }, rooms: [{ ...rect('A', 'A', 0.2, 0.2, 0.4, 0.3), doors: [{ edge: 0, offset: 0.4, width: 0.2, kind: 'ENTRY' }] }] };
const roomBody = () => (put.mock.calls.find(([u]) => u === '/api/floorplans/p1/rooms/A') as [string, { doors: Record<string, unknown>[] }])[1];

describe('door controls', () => {
  beforeEach(() => { PLANS.current = { data: [withDoor] }; DETAIL.current = { ...withDoor }; });

  const selectRoom = () => {
    stubCanvas();
    clickAt(screen.getByTestId('room-A'), 300, 250);
    fireEvent.pointerUp(screen.getByTestId('designer-canvas'));
  };

  it('Hinge, Swing and Width are saved on the door', async () => {
    renderPage(); selectRoom();
    fireEvent.change(screen.getByLabelText('Door 1 hinge'), { target: { value: 'end' } });
    fireEvent.change(screen.getByLabelText('Door 1 swing'), { target: { value: 'out' } });
    fireEvent.change(screen.getByLabelText('Door 1 width'), { target: { value: '0.1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save room' }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(roomBody().doors[0]).toMatchObject({ edge: 0, offset: 0.4, width: 0.1, kind: 'ENTRY', hinge: 'end', swing: 'out' });
  });

  it('"None" hinge is a leafless opening', async () => {
    renderPage(); selectRoom();
    fireEvent.change(screen.getByLabelText('Door 1 hinge'), { target: { value: 'none' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save room' }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(roomBody().doors[0].hinge).toBe('none');
  });

  it('Double leaf replaces the door by two half-width doors with mirrored hinges', async () => {
    renderPage(); selectRoom();
    fireEvent.click(screen.getByRole('button', { name: 'Door 1 double leaf' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save room' }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(roomBody().doors).toEqual([
      { edge: 0, offset: 0.4, width: 0.1, kind: 'ENTRY', hinge: 'start' },
      { edge: 0, offset: 0.5, width: 0.1, kind: 'ENTRY', hinge: 'end' },
    ]);
  });

  it('Double leaf is refused when the room already carries six doors', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ edge: 0, offset: i * 0.15, width: 0.1, kind: 'ENTRY' }));
    PLANS.current = { data: [{ ...withDoor, rooms: [{ ...withDoor.rooms[0], doors: six }] }] };
    renderPage(); selectRoom();
    expect(screen.getByRole('button', { name: 'Door 1 double leaf' })).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run src/routes/config/layout-designer/__tests__/door-controls.test.tsx`
Expected: FAIL — no `Door 1 hinge` field.

- [ ] **Step 3: Extend the door row**

In `properties-panel.tsx`, import `splitDoor` from `@digilog/shared` and `MAX_DOORS` from `./types`, then replace the `<li>` body of the door row with:

```tsx
              <li key={i} className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                <span className="w-16 font-medium">{d.wall ?? `edge ${d.edge}`}</span>
                <select value={d.kind} aria-label={`Door ${i + 1} kind`} className="ctl ctl-sm"
                  onChange={(e) => { const kind = e.target.value as DoorKind; setForm((f) => ({ ...f, doors: f.doors.map((door, ix) => (ix === i ? { ...door, kind } : door)) })); }}>
                  <option value="ENTRY">Entry</option>
                  <option value="EXIT">Exit</option>
                  <option value="PASSAGE">Passage</option>
                </select>
                {/* 2D (2026-10-05): which end the leaf hangs on ('none' = a leafless
                    opening — a sliding door or an open bay), which side it swings
                    to, and how wide it is, as a fraction of its wall. */}
                <select value={d.hinge ?? 'start'} aria-label={`Door ${i + 1} hinge`} className="ctl ctl-sm"
                  onChange={(e) => { const hinge = e.target.value as 'start' | 'end' | 'none'; setForm((f) => ({ ...f, doors: f.doors.map((door, ix) => (ix === i ? { ...door, hinge } : door)) })); }}>
                  <option value="start">Hinge: start</option>
                  <option value="end">Hinge: end</option>
                  <option value="none">No leaf (opening)</option>
                </select>
                <select value={d.swing ?? 'in'} aria-label={`Door ${i + 1} swing`} className="ctl ctl-sm"
                  onChange={(e) => { const swing = e.target.value as 'in' | 'out'; setForm((f) => ({ ...f, doors: f.doors.map((door, ix) => (ix === i ? { ...door, swing } : door)) })); }}>
                  <option value="in">Swings in</option>
                  <option value="out">Swings out</option>
                </select>
                <input type="number" step={0.01} min={0.02} max={0.5} value={d.width} aria-label={`Door ${i + 1} width`} className="ctl ctl-sm w-20"
                  onChange={(e) => { const width = Math.min(0.5, Math.max(0.02, Number(e.target.value) || 0.02)); setForm((f) => ({ ...f, doors: f.doors.map((door, ix) => (ix === i ? { ...door, width } : door)) })); }} />
                <Button variant="ghost" size="sm" type="button" aria-label={`Door ${i + 1} double leaf`} disabled={form.doors.length >= MAX_DOORS}
                  onClick={() => setForm((f) => { const [a, b] = splitDoor(f.doors[i]); return { ...f, doors: [...f.doors.slice(0, i), a, b, ...f.doors.slice(i + 1)] }; })}>
                  Double leaf
                </Button>
                <Button variant="ghost" size="sm" type="button" onClick={() => setForm((f) => ({ ...f, doors: f.doors.filter((_, ix) => ix !== i) }))}>Remove</Button>
              </li>
```

(`RoomDoor` in `room-geometry.ts` already declares `hinge?` and `swing?`; `splitDoor`'s generic keeps the `RoomDoor` type.)

- [ ] **Step 4: Run the tests and tsc**

Run, one at a time:
`cd apps/web && npx vitest run src/routes/config/layout-designer/__tests__/door-controls.test.tsx`
`npx vitest run src/routes/config/layout-designer/__tests__/designer-page.test.tsx`
`npx tsc --noEmit -p tsconfig.json`
Expected: PASS, PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/config/layout-designer/properties-panel.tsx apps/web/src/routes/config/layout-designer/__tests__/door-controls.test.tsx
git commit -m "feat(designer): door hinge, swing, width and double leaf"
```

---

### Task 7: The dashboard renders a designer-made 2D plan through the traced floors' path

**Files:**
- Test: `apps/web/src/routes/dashboard/__tests__/floorplan-designer-2d.test.tsx` (new)

**Interfaces:**
- Consumes: nothing new — this proves §7 of the spec (no dashboard change).

- [ ] **Step 1: Write the test**

Copy the mock block from `floorplan-arch.test.tsx` lines 1-45 verbatim (the `room`, `row`, `vi.mock('swr')`, `vi.mock('../use-telemetry')` parts and the `FloorplanView` import / `mount`), then:

```tsx
/**
 * A plan built the way the Layout Designer builds one (2026-10-05): polygon
 * rooms, hinged doors, and `annotations` as the designer writes them. It must
 * take the SAME 2D path as a traced floor — the designer adds no renderer.
 */
describe('a designer-made 2D plan', () => {
  it('draws the 2D layer, the structure, the plant outlines and a hinged door leaf', () => {
    PLAN = {
      id: 'p', name: 'Designer plan', imagePath: null, imageWidth: 1600, imageHeight: 1200, isActive: true, sortOrder: 0, links: [],
      annotations: {
        style: 'architectural',
        columns: [{ x: 0.1, y: 0.1, w: 0.02, h: 0.02 }], windows: [{ x: 0.3, y: 0.196, w: 0.1, h: 0.008 }],
        walls: [{ x1: 0.5, y1: 0.5, x2: 0.5, y2: 0.6 }], equipment: [{ x: 0.3, y: 0.3, w: 0.05, h: 0.03 }],
        labels: [{ x: 0.5, y: 0.5, text: 'HPLC' }], floor: null, north: 90,
      },
      rooms: [{ ...room('lab', 'R-LAB', 'LAB', 0.2), points: [{ x: 0.2, y: 0.2 }, { x: 0.6, y: 0.2 }, { x: 0.6, y: 0.5 }, { x: 0.2, y: 0.5 }],
        doors: [{ edge: 0, offset: 0.4, width: 0.1, kind: 'ENTRY', hinge: 'end', swing: 'in' }] }],
    } as unknown as typeof PLAN;
    ROWS = [row({})];
    mount();
    expect(screen.getByTestId('fp-arch')).toBeInTheDocument();
    const structure = screen.getByTestId('fp-structure');
    expect(structure.querySelectorAll('[data-structure="column"]')).toHaveLength(1);
    expect(structure.querySelectorAll('[data-structure="window"]')).toHaveLength(1);
    expect(structure.querySelectorAll('[data-structure="stub-core"]')).toHaveLength(1);
    expect(screen.getByTestId('fp-plant').querySelectorAll('rect')).toHaveLength(1);
    expect(screen.getByText('HPLC')).toBeInTheDocument();
    expect(screen.getByTestId('fp-card')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it**

Run: `cd apps/web && npx vitest run src/routes/dashboard/__tests__/floorplan-designer-2d.test.tsx`
Expected: PASS on the first run — the dashboard already draws this shape. If it FAILS, the designer is writing a shape the dashboard does not read: fix the WRITER (Tasks 4–5), never the dashboard.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/routes/dashboard/__tests__/floorplan-designer-2d.test.tsx
git commit -m "test(dashboard): a designer-made 2D plan renders through the traced floors' path"
```

---

### Task 8: Docs, CHANGELOG and the full gate

**Files:**
- Modify: `CLAUDE.md` (a bullet under the LAYOUT DESIGNER note), `apps/web/CLAUDE.md` (the Layout Designer section), `packages/shared/CLAUDE.md` (the two geometry helpers), `CHANGELOG.md`.

- [ ] **Step 1: Root `CLAUDE.md`** — under the LAYOUT DESIGNER bullet add:

```
  - **The designer AUTHORS the 2D architectural style (2026-10-05, operator:
    "layout designer feature is should able to create 2d design model"; chose
    full 2D authoring of three).** A plan has a STYLE (Plan panel: Standard /
    2D; a NEW plan is 2D), floor group / label / order and north; five
    structure tools (Column, Equipment, Window, Wall stub, Label) write
    `annotations.{columns,equipment,windows,walls,labels}` — the SAME shape
    the trace scripts write, so the dashboard changed NOTHING; doors gain
    hinge / swing / width and a Double leaf action (two half-width doors with
    mirrored hinges, `splitDoor` in `@digilog/shared`; no flag). The API's
    `floorplanSchema` gained `annotationsSchema` (bounded; omitted = untouched,
    given = replaced whole, `null` refused) and the plan audit rows carry a
    COUNT summary. `segmentOnEdge` snaps a window / stub drawn along a wall
    onto it. The five script-drawn plans stay script-owned (the panel says so).
    Spec `docs/superpowers/specs/2026-10-05-layout-designer-2d-design.md`. No
    count moved.
```

- [ ] **Step 2: `apps/web/CLAUDE.md`** — in the Layout Designer section add the three new files (`plan-panel.tsx`, `structure-panel.tsx`, the tests), the rule "the structure tools show only on a 2D plan", and "every structure edit PUTs the whole `annotations` object".

- [ ] **Step 3: `packages/shared/CLAUDE.md`** — add `segmentOnEdge` and `splitDoor` to the floorplan-geometry row.

- [ ] **Step 4: CHANGELOG** — a `## [Unreleased] - Layout Designer: the 2D design model is authored in the designer (2026-10-05)` entry quoting the operator, the three options and the choice, and one bullet per task above (API schema, plan panel, tools, doors, no dashboard change, script-drawn plans).

- [ ] **Step 5: The gate** — run, each alone by exit code: every file under `apps/web/src/routes/config/layout-designer/__tests__/`, `apps/web/src/routes/dashboard/__tests__/floorplan-arch.test.tsx`, `floorplan-designer-2d.test.tsx`, `floorplan-polygon-render.test.ts`; `apps/api` `floorplan-*.e2e.test.ts` and `floorplans.e2e.test.ts`; `packages/shared` full run; `npm run lint` (api); `npx tsc --noEmit` (web). Then re-derive the live counts (the block in root `CLAUDE.md`) and confirm none moved.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md apps/web/CLAUDE.md packages/shared/CLAUDE.md CHANGELOG.md
git commit -m "docs: Layout Designer 2D design model"
```
