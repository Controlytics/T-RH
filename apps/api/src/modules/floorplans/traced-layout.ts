/**
 * The shape every TRACED floor shares.
 *
 * A traced floor is one authored as literal measured pixel coordinates off an
 * architectural drawing in `Layouts/CWH/`, instead of being invented by
 * `draw-cwh-floorplan.ts`'s guillotine split. `qc-layout.ts` (2026-08-31,
 * re-traced 2026-09-21) was the first and carries its own copies of these
 * types with the long header on how a drawing is measured; `qc3-layout.ts`
 * (2026-09-21) uses these. Each floor is its own file on purpose — one
 * drawing, read against one image.
 *
 * These are the RECTANGLE traces. A floor drawn in the 2D architectural style
 * is a polygon trace on `architectural-layout.ts` instead: QC
 * (`qc-layout-2.ts`) and, since 2026-10-01, Microbiology
 * (`microbiology-layout.ts`, which used these types until then).
 */
import type { Grade, Door, RoomMeta, PlanAnnotations } from './qc-layout.js';

export type { Grade, Door, RoomMeta, PlanAnnotations };

/** The building's outer wall in the drawing's own pixels. */
export interface Building { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }

export interface TracedRoom {
  /** Room number from the drawing, e.g. `CWH-I/245`. Becomes `code`. */
  code: string;
  /** The room's name as drawn. Becomes `label`. */
  label: string | null;
  /** Pixel rectangle in the PNG: left, top, right, bottom. */
  px: [number, number, number, number];
  grade?: Grade;
  doors?: Door[];
  meta?: RoomMeta;
  /** Instrument code sited in this room, per the instrument's `Location` attribute. */
  instrument?: string;
}

export interface TracedLayout {
  /** The functional-location AREA name this plan is drawn for, exactly as stored. */
  area: string;
  /** The source image, relative to the repo root. */
  source: string;
  building: Building;
  rooms: TracedRoom[];
  /** Everything that is not a room. `null` = the plan draws no symbol legend. */
  annotations: PlanAnnotations | null;
}

/** The plan's stored canvas: only the RATIO matters (it sets the viewBox height). */
export function canvasOf(b: Building): { width: number; height: number } {
  return { width: b.x1 - b.x0, height: b.y1 - b.y0 };
}

/** Drawing pixels -> the 0..1 proportions the schema stores. */
export function normRect(b: Building, px: [number, number, number, number]): { x: number; y: number; w: number; h: number } {
  const [x0, y0, x1, y1] = px;
  const { width: W, height: H } = canvasOf(b);
  return { x: (x0 - b.x0) / W, y: (y0 - b.y0) / H, w: (x1 - x0) / W, h: (y1 - y0) / H };
}

/** Annotation pixels -> the 0..1 proportions stored on `floorplans.annotations`. */
export function normPlanAnnotations(b: Building, a: PlanAnnotations) {
  const { width: W, height: H } = canvasOf(b);
  const nx = (v: number) => (v - b.x0) / W;
  const ny = (v: number) => (v - b.y0) / H;
  const box = ([x0, y0, x1, y1]: [number, number, number, number]) =>
    ({ x: nx(x0), y: ny(y0), w: (x1 - x0) / W, h: (y1 - y0) / H });
  return {
    equipment: a.equipment.map(box),
    hvac: a.hvac.map(box),
    water: a.water.map(([x, y]) => ({ x: nx(x), y: ny(y) })),
    airflow: a.airflow.map((r) => ({ y: ny(r.y), x0: nx(r.x0), x1: nx(r.x1) })),
    labels: a.labels.map((l) => ({ x: nx(l.x), y: ny(l.y), text: l.text })),
  };
}
