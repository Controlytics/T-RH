/**
 * Draw the CWH floors from the instrument registry.
 *
 *   • ONE PLAN PER AREA — 7 plans, each holding one room per Location in that
 *     area, with that area's instruments placed in them. This is where the live
 *     readings appear.
 *   • ONE OVERVIEW PLAN — the pre-existing "CWH - 3rd Floor", redrawn as 7
 *     rooms, one per area, sized by how many locations each holds.
 *
 * ─── WHY THE OVERVIEW CARRIES NO READINGS ────────────────────────────────
 * `Instrument.roomId` is a single nullable reference: an instrument sits in ONE
 * room, on ONE plan. So the same instrument cannot be placed on both its area
 * plan and an overview plan — whichever it is not on renders as geometry with
 * no chips. The operator chose (2026-08-24) to put the instruments on the AREA
 * plans, because that is the density that is actually readable; the overview is
 * a map of the block, not a second dashboard. Anything else needs a join table
 * and a migration, not a script.
 *
 * ─── LAYOUT ──────────────────────────────────────────────────────────────
 * A squarified-ish treemap by recursive binary split. Recursive splitting is
 * used rather than a grid because it TESSELLATES EXACTLY — every child
 * rectangle is carved out of its parent, so two neighbours physically cannot
 * disagree about the wall between them and no hairline gaps can open up. It
 * also produces irregular room sizes, which is what makes a plan read as a
 * building rather than a spreadsheet.
 *
 * Grade (the zone colour) is assigned per area, so each plan reads as one zone
 * class. See docs/superpowers/specs/2026-08-24-graphical-view-visual-design.md.
 *
 * Every write is audited, in the same transaction as the change. Re-runnable:
 * plans are matched by name and their rooms replaced wholesale.
 *
 * Usage:
 *   npx tsx apps/api/scripts/draw-cwh-floorplan.ts            # dry run
 *   npx tsx apps/api/scripts/draw-cwh-floorplan.ts --apply
 */
import { prisma } from '../src/lib/prisma.js';
import { auditLog } from '../src/lib/audit.js';
import {
  REDRAW_ROOM_SELECT, REDRAW_LINK_SELECT, REDRAW_TX_OPTIONS, assertUniqueRoomCodes, carriedLimits, describeLimits,
  linkCode, replacePlanRooms, type RedrawRoom,
} from '../src/modules/floorplans/redraw.js';
import { loadLimitConfig, limitsFor, enabledBoundsFor } from '../src/modules/alarms/load-limits.js';
import type { InstrumentLimits } from '../src/modules/alarms/limit-decide.js';
import { Prisma } from '@prisma/client';

/**
 * Deterministic [0,1) from a string. Layout randomness comes from the room's
 * own name, never `Math.random()`: a plan that reshuffles on every run is
 * useless as a reference, and the operator has to be able to re-run this
 * without the floor moving under them.
 */
function hash01(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 10000) / 10000;
}

const APPLY = process.argv.includes('--apply');
/**
 * Redraw ONE area instead of the whole block: `--only QC`.
 *
 * Without this the script deletes and recreates every room on all eight plans
 * to change one of them. The generator is deterministic, so the other floors
 * would come back the same shape — but each room is a §11 record with its own
 * delete and create audit rows, and re-signing a hundred rooms nobody touched
 * makes the audit trail describe work that did not happen. The overview plan is
 * skipped with the same flag, since it holds no instruments and its geometry
 * depends only on the area list.
 */
const ONLY = (() => {
  const i = process.argv.indexOf('--only');
  return i >= 0 ? process.argv[i + 1] ?? null : null;
})();
const ACTOR = 'superadmin';
const OVERVIEW_PLAN = 'CWH - 3rd Floor';
const REASON = 'Floors drawn from the instrument registry by scripts/draw-cwh-floorplan.ts. '
  + 'No e-signature was captured: a script cannot prompt for re-authentication as the HTTP route does.';

type Grade = 'A' | 'B' | 'C' | 'D' | 'CIRCULATION' | 'UTILITY';
type Door = { wall: 'top' | 'right' | 'bottom' | 'left'; offset: number; width: number; kind: 'ENTRY' | 'EXIT' | 'PASSAGE' };
interface Rect { x: number; y: number; w: number; h: number }

function gradeForArea(area: string): Grade {
  const a = area.toLowerCase();
  if (a.startsWith('module-')) return 'B';
  if (a.startsWith('qc') || a === 'stability') return 'C';
  if (a.includes('ware house')) return 'D';
  return 'UTILITY';
}

function partition<T>(rect: Rect, items: T[], weight: (t: T) => number): { item: T; rect: Rect }[] {
  if (items.length === 0) return [];
  if (items.length === 1) return [{ item: items[0], rect }];
  const total = items.reduce((n, t) => n + weight(t), 0);
  let acc = 0, cut = 0;
  for (; cut < items.length - 1; cut++) {
    acc += weight(items[cut]);
    if (acc >= total / 2) { cut++; break; }
  }
  const left = items.slice(0, cut), right = items.slice(cut);
  const frac = total === 0 ? 0.5 : left.reduce((n, t) => n + weight(t), 0) / total;
  if (rect.w >= rect.h) {
    const wLeft = rect.w * frac;
    return [
      ...partition({ ...rect, w: wLeft }, left, weight),
      ...partition({ x: rect.x + wLeft, y: rect.y, w: rect.w - wLeft, h: rect.h }, right, weight),
    ];
  }
  const hTop = rect.h * frac;
  return [
    ...partition({ ...rect, h: hTop }, left, weight),
    ...partition({ x: rect.x, y: rect.y + hTop, w: rect.w, h: rect.h - hTop }, right, weight),
  ];
}

const inset = (r: Rect, by: number): Rect => ({
  x: r.x + by, y: r.y + by, w: Math.max(0.004, r.w - by * 2), h: Math.max(0.004, r.h - by * 2),
});

function doorFor(r: Rect): Door[] {
  return [{ wall: r.w >= r.h ? 'bottom' : 'right', offset: 0.38, width: 0.2, kind: 'ENTRY' }];
}

/**
 * The plan's canvas shape, from how many rooms it holds.
 *
 * Room coordinates are normalized 0..1 against the plan, and the dashboard
 * renders every plan at the same width — so a plan with 8 rooms drew them at
 * four times the size of a plan with 33. Making the canvas TALLER as the room
 * count grows keeps a room roughly the same size on screen whichever area you
 * are looking at, which is what makes the set read as one building rather than
 * as drawings at different zooms.
 *
 * Clamped so a very sparse area does not become a letterbox strip.
 */
function canvasFor(roomCount: number): { width: number; height: number } {
  const WIDTH = 1600;
  const ratio = Math.max(0.34, Math.min(1.30, roomCount / 24));
  return { width: WIDTH, height: Math.round(WIDTH * ratio) };
}

function stem(area: string): string {
  return area.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ')
    .map((w) => w.slice(0, 3).toUpperCase()).join('-').slice(0, 20);
}

/**
 * A room is identified by its REAL NAME, not a generated serial.
 *
 * Codes like "STA/01" carried no information: they were an artefact of the
 * generator, and on the drawing they took the prominent bold line while the
 * actual room name sat underneath in smaller type. The room code column is
 * VarChar(60), so a long location is truncated here and the untruncated name
 * stays on the label; a numeric suffix is added ONLY when truncation would
 * otherwise collide with another room on the same plan.
 */
function makeCode(name: string, _n: number, used: Set<string>): string {
  const base = name.replace(/\s+/g, ' ').trim().slice(0, 60) || 'ROOM';
  let code = base;
  let i = 2;
  while (used.has(code)) code = `${base.slice(0, 56)} (${i++})`;
  used.add(code);
  return code;
}

/**
 * A deterministic pseudo-random in [0,1) from a string, so re-running the
 * script reproduces the same floor. `Math.random()` would reshuffle every room
 * on every run, which makes a drawn plan useless as a reference.
 */
function jitter(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 1000) / 1000;
}

/**
 * Lay a plan out as a BUILDING rather than a treemap: a vertical service
 * corridor down the left, horizontal bands of rooms, and a corridor between
 * every pair of bands. Each room opens onto the corridor it touches.
 *
 * This is the structure of the reference drawing: rooms of varied width sharing
 * walls along a circulation spine. A treemap tiles the same area correctly but
 * reads as nested boxes, because nothing in it corresponds to how people move
 * through a floor.
 *
 * Room widths within a band vary deterministically (see `jitter`) so the plan
 * looks drawn rather than generated, while still summing EXACTLY to the band
 * width — the last room absorbs the rounding, so no hairline gap can open at
 * the right-hand wall.
 */
/**
 * Recursively cut a rectangle into `n` rooms by GUILLOTINE SPLITS.
 *
 * Every cut runs edge to edge, so the pieces tessellate by construction — no
 * cell grid, no leftovers, no mop-up pass. Crucially the split point is varied
 * from a hash rather than taken as k/n, which is what gives rooms genuinely
 * different sizes in BOTH dimensions: a wide short room beside a narrow tall
 * one, small rooms stacked where a big one sits opposite. An even split at k/n
 * is what produced the "same size boxes one after another".
 *
 * Cuts alternate onto whichever axis is longer, so nothing degenerates into a
 * sliver however lopsided the split fraction gets.
 */
function guillotine(rect: Rect, n: number, seed: string): Rect[] {
  if (n <= 1) return [rect];
  const j = hash01(`${seed}:${n}`);
  // How many rooms go on the first side. Biased away from a clean half so the
  // two halves differ in room count as well as in size.
  const k = Math.max(1, Math.min(n - 1, Math.round(n * (0.3 + j * 0.4))));
  // The AREA fraction is deliberately NOT k/n — nudging it up to 25% either way
  // is what makes a 3-room half sometimes larger than a 4-room half, which is
  // how a real plan looks.
  const skew = 0.75 + hash01(`${seed}:s:${n}`) * 0.5;
  const frac = Math.max(0.18, Math.min(0.82, (k / n) * skew));

  if (rect.w >= rect.h) {
    const wl = rect.w * frac;
    return [
      ...guillotine({ ...rect, w: wl }, k, `${seed}L`),
      ...guillotine({ x: rect.x + wl, y: rect.y, w: rect.w - wl, h: rect.h }, n - k, `${seed}R`),
    ];
  }
  const ht = rect.h * frac;
  return [
    ...guillotine({ ...rect, h: ht }, k, `${seed}T`),
    ...guillotine({ x: rect.x, y: rect.y + ht, w: rect.w, h: rect.h - ht }, n - k, `${seed}B`),
  ];
}

/**
 * Grade from the room's OWN environmental specification, not from its area.
 *
 * Colouring every room on a plan by its area meant a whole floor was one hue —
 * accurate but monotonous, and it wasted the one channel that could carry
 * information. The spreadsheet's limit columns hold real variety (temperature
 * bands 20-25, 18-27, 0-25, 0-27; humidity 0-30, 0-60, 0-70, and 16 rooms with
 * no humidity control at all), so hue now says how tightly a room is specified.
 * That is honest: a tighter spec IS a higher classification.
 *
 * The bounds are the ones the DASHBOARD resolves (2026-10-05): the administered
 * `alarm-limits` alias lists through `limitsFor` (`parseLimitKeys` / `resolveLimit`
 * in `@digilog/shared`), with a bound switched off by its Enable_* attribute
 * withheld, exactly as `telemetry-overview.ts` does. Until then this read four
 * literal keys (`High Temperature Limit`, ...) that were retired from every
 * profile on 2026-09-16, so a redraw would have graded every room 'D'.
 */
function gradeFromLimits(limits: InstrumentLimits): Grade {
  const tLo = limits.temperatureLow, tHi = limits.temperatureHigh;
  const hHi = limits.humidityHigh;

  // Both temperature bounds actually set — the tightest control on this floor.
  if (tLo !== null && tLo > 0 && tHi !== null && tHi > 0) return 'A';
  if (hHi !== null && hHi > 0 && hHi <= 60) return 'B';
  if (hHi !== null && hHi > 60) return 'C';
  return 'D';   // no humidity limit set at all
}

function buildingLayout(
  areaName: string,
  locs: [string, string[]][],
  _grade: Grade,
  used: Set<string>,
  gradeOf: (ids: string[]) => Grade,
  codeOf: (ids: string[]) => string | null,
): RoomSpec[] {
  const N = locs.length;
  const M = 0.012;
  const SPINE = Math.min(0.05, Math.max(0.028, 0.34 / Math.max(4, Math.sqrt(N) * 2)));
  const CORR = SPINE * 0.9;

  const left = M, right = 1 - M, top = M, bottom = 1 - M;
  const bodyX = left + SPINE, bodyR = right - SPINE;

  // One cross corridor per ~10 rooms, so a small floor is not mostly circulation.
  const bands = Math.max(1, Math.min(3, Math.round(N / 10)));
  const bandH = (bottom - top - CORR * (bands - 1)) / bands;

  const out: RoomSpec[] = [];
  let corridorN = 0;
  const corridorRows: Rect[] = [];

  out.push({
    code: makeCode('SERVICE CORRIDOR', 0, used), label: null,
    grade: 'CIRCULATION', rect: { x: left, y: top, w: SPINE, h: bottom - top }, instruments: [],
  });
  out.push({
    code: makeCode('SERVICE CORRIDOR', 0, used), label: null,
    grade: 'CIRCULATION', rect: { x: bodyR, y: top, w: SPINE, h: bottom - top }, instruments: [],
  });

  // Split the rooms across the bands, then guillotine each band.
  const perBand = Array.from({ length: bands }, (_, i) =>
    Math.floor(N / bands) + (i < N % bands ? 1 : 0));
  let idx = 0;
  for (let b = 0; b < bands; b++) {
    const y = top + b * (bandH + CORR);
    const region: Rect = { x: bodyX, y, w: bodyR - bodyX, h: bandH };
    const slice = locs.slice(idx, idx + perBand[b]);
    idx += perBand[b];
    if (!slice.length) continue;

    const rects = guillotine(region, slice.length, `${areaName}:${b}`);
    rects.forEach((rect, i) => {
      const [label, ids] = slice[i];
      // Door faces the nearest circulation: the corridor below when there is
      // one, the corridor above for the last band, else the spine it touches.
      const wall: Door['wall'] =
        Math.abs(rect.x - bodyX) < 1e-9 ? 'left'
          : Math.abs(rect.x + rect.w - bodyR) < 1e-9 ? 'right'
            : b < bands - 1 ? 'bottom' : 'top';
      out.push({
        // The room is identified by the INSTRUMENT in it. The operator wants a
        // box to carry the instrument ID and its two readings and nothing else:
        // on a monitoring wall the room name is context you already have from
        // the plan you opened, while the instrument ID is what you act on.
        // The location name is not lost — it stays on the instrument's own
        // `Location` attribute, which is where it came from.
        code: makeCode(codeOf(ids) ?? label, 0, used),
        label: null,
        grade: gradeOf(ids),
        rect,
        instruments: ids,
        door: [{ wall, offset: 0.34, width: 0.24, kind: 'ENTRY' }],
      });
    });

    if (b < bands - 1) {
      corridorRows.push({ x: bodyX, y: y + bandH, w: bodyR - bodyX, h: CORR });
    }
  }
  for (const rect of corridorRows) {
    out.push({
      code: makeCode('CORRIDOR', 0, used), label: null,
      grade: 'CIRCULATION', rect, instruments: [],
    });
  }
  return out;
}


interface RoomSpec { code: string; label: string | null; grade: Grade; rect: Rect; instruments: string[]; door?: Door[]; meta?: Record<string, string> }

/**
 * The floors we have a DRAWING of (`Layouts/CWH/`) are not this script's:
 * each is a polygon trace drawn in the 2D architectural style by its own
 * script, and this one leaves those areas alone. `buildingLayout()` invents a
 * plausible floor from a room count; a real plan and a synthesised one cannot
 * be blended, so a traced area is bypassed entirely rather than nudged.
 *
 * QC and QC Microbiology went that way on 2026-10-01, QC 3 later the same day.
 * From 2026-09-21 until then QC 3 and Microbiology were RECTANGLE traces drawn
 * here through a `TRACED` map (`traced-layout.ts`); that path went with the
 * last floor that used it. What is left here is generated: Stability,
 * Module-E, Module-F and Ware House, which have no drawing.
 */
const DRAWN_ELSEWHERE: Record<string, string> = {
  QC: 'scripts/draw-qc-layout-2.ts',
  'QC Microbiology': 'scripts/draw-architectural-floor.ts --area "QC Microbiology"',
  'QC 3': 'scripts/draw-architectural-floor.ts --area "QC 3"',
  'Module-E': 'scripts/draw-architectural-floor.ts --area "Module-E"',
  // Two floors, two plans; the generated plan was RENAMED to its ground floor.
  'Module-F': 'scripts/draw-architectural-floor.ts --area "Module-F"',
};

/** The database a plan is read from and written to: the plan's transaction under --apply, else the client. */
type Db = Prisma.TransactionClient;
const AUDIT = { userId: ACTOR, userRole: 'SUPER_ADMIN', ipAddress: '127.0.0.1', userAgent: 'scripts/draw-cwh-floorplan.ts', sessionId: null };

/**
 * Replace a plan's rooms wholesale, audited, and place its instruments —
 * through the shared `replacePlanRooms` (`src/modules/floorplans/redraw.ts`),
 * inside the caller's ONE transaction per plan. Each room's four LIMITS are
 * carried over BY CODE from the room it replaces (audit 2026-10-12: they were
 * dropped, so a redraw cleared every room's in-spec band), and the plan's room
 * links are deleted with an audit row each rather than by cascade. In a dry
 * run (`planId` null when the plan does not exist yet) it only lists the rooms
 * and the limits each would carry.
 */
async function drawPlan(db: Db, planId: string | null, planName: string, rooms: RoomSpec[]): Promise<number> {
  assertUniqueRoomCodes(rooms.map((r) => r.code), planName);
  const old = planId
    ? await db.floorplan.findUnique({ where: { id: planId }, select: { rooms: { select: REDRAW_ROOM_SELECT }, links: { select: REDRAW_LINK_SELECT } } })
    : null;
  const byCode = new Map((old?.rooms ?? []).map((r) => [r.code.toUpperCase(), r]));
  const specs: RedrawRoom[] = rooms.map((spec) => ({
    code: spec.code, label: spec.label,
    ...spec.rect,
    points: null,
    doors: spec.door ?? (spec.grade === 'CIRCULATION' ? [] : doorFor(spec.rect)),
    grade: spec.grade,
    // A generated room has no drawing to transcribe: no meta is SQL NULL.
    meta: spec.meta ?? null,
    limits: carriedLimits(byCode.get(spec.code.toUpperCase())),
    instrumentIds: spec.instruments,
  }));
  if (!APPLY) {
    for (const s of specs) console.log(`      ${s.code.padEnd(24)} limits=${describeLimits(s.limits)}${s.instrumentIds.length ? ` +${s.instrumentIds.length} instrument(s)` : ''}`);
    for (const l of old?.links ?? []) console.log(`      link ${l.kind} ${linkCode(l)} — deleted (its rooms are replaced)`);
    return specs.reduce((n, s) => n + s.instrumentIds.length, 0);
  }
  return replacePlanRooms(db, {
    planId: planId!, planName, oldRooms: old?.rooms ?? [], oldLinks: old?.links ?? [], rooms: specs,
    audit: { ...AUDIT, reason: REASON }, actor: ACTOR,
    why: `"${planName}" redrawn from the instrument registry`,
  });
}

async function main() {
  const instruments = await prisma.instrument.findMany({
    where: { isGateway: false },
    select: {
      id: true, code: true,
      functionalLocation: { select: { name: true } },
      attributes: { where: { key: 'Location' }, select: { value: true } },
    },
    orderBy: { code: 'asc' },
  });

  const areas = new Map<string, Map<string, string[]>>();
  const skipped: string[] = [];
  for (const i of instruments) {
    const area = i.functionalLocation?.name;
    const loc = i.attributes[0]?.value?.trim();
    if (!area || !loc) { skipped.push(i.code); continue; }
    let locs = areas.get(area);
    if (!locs) { locs = new Map(); areas.set(area, locs); }
    const list = locs.get(loc);
    if (list) list.push(i.id); else locs.set(loc, [i.id]);
  }

  // Every attribute of every instrument on the plan: the administered alias lists
  // decide which keys are the bounds, so the keys cannot be filtered here.
  const limitCfg = await loadLimitConfig();
  const attrRows = await prisma.instrumentAttribute.findMany({
    where: { instrumentId: { in: instruments.map((i) => i.id) } },
    select: { instrumentId: true, key: true, value: true },
  });
  const codeById = new Map<string, string>(instruments.map((i) => [i.id, i.code]));
  const attrsByInstrument = new Map<string, { key: string; value: string }[]>();
  for (const a of attrRows) {
    let list = attrsByInstrument.get(a.instrumentId);
    if (!list) { list = []; attrsByInstrument.set(a.instrumentId, list); }
    list.push({ key: a.key, value: a.value });
  }
  /** The four bounds as the dashboard sees them: resolved by alias, disabled = absent. */
  const resolvedLimits = (attrs: { key: string; value: string }[]): InstrumentLimits => {
    const { limits } = limitsFor(limitCfg.keys, attrs);
    const on = enabledBoundsFor(limitCfg.enableKeys, attrs);
    return {
      temperatureHigh: on.temperatureHigh ? limits.temperatureHigh : null,
      temperatureLow: on.temperatureLow ? limits.temperatureLow : null,
      humidityHigh: on.humidityHigh ? limits.humidityHigh : null,
      humidityLow: on.humidityLow ? limits.humidityLow : null,
    };
  };

  const areaList = [...areas.entries()]
    .map(([name, locs]) => ({ name, locs: [...locs.entries()] }))
    .sort((a, b) => b.locs.length - a.locs.length);

  const canvas: Rect = { x: 0.012, y: 0.012, w: 0.976, h: 0.976 };

  console.log(`MODE: ${APPLY ? 'APPLY (writes)' : 'DRY RUN (no writes)'}`);
  if (ONLY) {
    if (!areaList.some((a) => a.name === ONLY)) {
      throw new Error(`--only "${ONLY}" matches no area. Areas: ${areaList.map((a) => a.name).join(', ')}`);
    }
    console.log(`scope: --only "${ONLY}" (other area plans and the overview are left untouched)`);
  }
  console.log(`plans: ${areaList.length} area plans + 1 overview ("${OVERVIEW_PLAN}")`);
  for (const a of areaList) {
    console.log(`  ${a.name.padEnd(20)} rooms=${String(a.locs.length).padStart(2)}  grade=${gradeForArea(a.name)}`);
  }
  if (skipped.length) console.log(`skipped (no area or Location): ${skipped.join(', ')}`);
  // The dry run walks every plan too — read-only — so it can list each room
  // with the limits it will carry (audit 2026-10-12).

  const overview = await prisma.floorplan.findFirst({ where: { name: OVERVIEW_PLAN }, select: { id: true, imagePath: true, imageWidth: true, imageHeight: true } });
  // --apply needs it (its image is reused, its rooms redrawn); a dry run reports it missing and goes on.
  if (!overview && APPLY) throw new Error(`overview plan "${OVERVIEW_PLAN}" not found`);
  if (!overview) console.log(`overview plan "${OVERVIEW_PLAN}" not found — --apply will refuse`);

  // ── One plan per area ──────────────────────────────────────────────────
  let totalRooms = 0, totalPlaced = 0;
  for (let idx = 0; idx < areaList.length; idx++) {
    const area = areaList[idx];
    if (ONLY && area.name !== ONLY) continue;
    const planName = `CWH — ${area.name}`;
    // A floor traced from a drawing is drawn by its OWN script (polygons, the
    // 2D style) — redrawing it here would put a generated floor over it.
    if (DRAWN_ELSEWHERE[area.name]) {
      console.log(`  ${planName.padEnd(28)} skipped — drawn by ${DRAWN_ELSEWHERE[area.name]}`);
      continue;
    }
    const shape = canvasFor(area.locs.length);
    /**
     * The plan, found / created / reshaped, inside the plan's transaction.
     * The create and the reshape are audited (they were not before
     * 2026-10-12). In a dry run nothing is written and a plan that does not
     * exist yet is reported as `null`.
     */
    const planFor = async (db: Db): Promise<string | null> => {
      const plan = await db.floorplan.findFirst({ where: { name: planName }, select: { id: true, imageWidth: true, imageHeight: true } });
      if (!plan) {
        console.log(`${APPLY ? 'created' : 'would create'} plan "${planName}" ${shape.width}x${shape.height}`);
        if (!APPLY) return null;
        const data = {
          name: planName,
          // The dashboard DRAWS rooms and never renders this image; it is only a
          // tracing guide in the editor. Reusing the block's own scan is honest
          // — it is the same building — and avoids inventing a second asset.
          imagePath: overview!.imagePath,
          imageWidth: shape.width, imageHeight: shape.height,
          sortOrder: idx + 1,
        };
        const created = await db.floorplan.create({ data: { ...data, createdBy: ACTOR, updatedBy: ACTOR }, select: { id: true } });
        await auditLog({
          ...AUDIT, action: 'FLOORPLAN_CREATED', targetType: 'floorplan', targetId: created.id,
          afterValue: data, reason: REASON, signatureMeaning: `Floor plan "${planName}" created from the instrument registry`,
        }, db);
        return created.id;
      }
      if (plan.imageWidth !== shape.width || plan.imageHeight !== shape.height) {
        // An existing plan keeps its rooms but must adopt the corrected shape,
        // or it goes on rendering at the old zoom.
        console.log(`${APPLY ? 'reshaped' : 'would reshape'} "${planName}" -> ${shape.width}x${shape.height}`);
        if (APPLY) {
          await db.floorplan.update({
            where: { id: plan.id },
            data: { imageWidth: shape.width, imageHeight: shape.height, updatedBy: ACTOR },
          });
          await auditLog({
            ...AUDIT, action: 'FLOORPLAN_UPDATED', targetType: 'floorplan', targetId: plan.id,
            beforeValue: { imageWidth: plan.imageWidth, imageHeight: plan.imageHeight },
            afterValue: { imageWidth: shape.width, imageHeight: shape.height },
            reason: REASON, signatureMeaning: `Floor plan "${planName}" reshaped for the instrument registry`,
          }, db);
        }
      }
      return plan.id;
    };

    const grade = gradeForArea(area.name);
    const used = new Set<string>();
    const gradeOfInstrument = (id: string): Grade => {
      const attrs = attrsByInstrument.get(id);
      return attrs ? gradeFromLimits(resolvedLimits(attrs)) : grade;
    };
    // Grade per ROOM from its instrument's own limits, so a floor carries
    // variety that means something rather than one flat hue.
    const rooms = buildingLayout(
      area.name, area.locs, grade, used,
      (ids) => gradeOfInstrument(ids[0]),
      (ids) => {
        // Two instruments in one location: name the room for the first and
        // say there is another, rather than silently showing only one.
        const codes = ids.map((id) => codeById.get(id)).filter(Boolean) as string[];
        if (!codes.length) return null;
        return codes.length === 1 ? codes[0] : `${codes[0]} +${codes.length - 1}`;
      },
    );

    // ONE transaction per plan: either the whole floor is redrawn, or nothing.
    const draw = async (db: Db) => drawPlan(db, await planFor(db), planName, rooms);
    const placed = APPLY ? await prisma.$transaction(draw, REDRAW_TX_OPTIONS) : await draw(prisma);
    totalRooms += rooms.length; totalPlaced += placed;
    console.log(`  ${planName.padEnd(28)} rooms=${String(rooms.length).padStart(2)} placed=${placed}`);
  }

  // ── The overview: one room per area, no instruments ────────────────────
  //
  // Areas are sized by INSTRUMENT count, not room count, so an area with few
  // sensors does not occupy the same space as a dense one.
  //
  // They tessellate EXACTLY — no inset. Insetting each block used to leave a
  // channel of blank space between areas that nothing filled; on a floor plan
  // an unexplained void reads as a hole, not as circulation. Circulation is now
  // drawn explicitly as a perimeter ring, and the areas fill everything inside
  // it edge to edge.
  const usedOverview = new Set<string>();
  const RING = 0.032;
  const inner: Rect = {
    x: canvas.x + RING, y: canvas.y + RING,
    w: canvas.w - RING * 2, h: canvas.h - RING * 2,
  };

  const overviewRooms: RoomSpec[] = [
    { code: makeCode('CORRIDOR — NORTH', 0, usedOverview), label: null, grade: 'CIRCULATION',
      rect: { x: canvas.x, y: canvas.y, w: canvas.w, h: RING }, instruments: [] },
    { code: makeCode('CORRIDOR — SOUTH', 0, usedOverview), label: null, grade: 'CIRCULATION',
      rect: { x: canvas.x, y: inner.y + inner.h, w: canvas.w, h: RING }, instruments: [] },
    { code: makeCode('CORRIDOR — WEST', 0, usedOverview), label: null, grade: 'CIRCULATION',
      rect: { x: canvas.x, y: inner.y, w: RING, h: inner.h }, instruments: [] },
    { code: makeCode('CORRIDOR — EAST', 0, usedOverview), label: null, grade: 'CIRCULATION',
      rect: { x: inner.x + inner.w, y: inner.y, w: RING, h: inner.h }, instruments: [] },
  ];

  const areaRects = partition(inner, areaList, (a) =>
    a.locs.reduce((n, [, ids]) => n + ids.length, 0));
  for (const { item: area, rect } of areaRects) {
    const instrumentCount = area.locs.reduce((n, [, ids]) => n + ids.length, 0);
    overviewRooms.push({
      code: makeCode(area.name, 0, usedOverview),
      label: `${instrumentCount} instruments`,
      grade: gradeForArea(area.name),
      rect,
      instruments: [],
      door: [{ wall: 'bottom', offset: 0.4, width: 0.18, kind: 'PASSAGE' }],
    });
  }
  if (ONLY || !overview) {
    console.log(`  ${OVERVIEW_PLAN.padEnd(28)} skipped (${ONLY ? `--only "${ONLY}"` : 'not on the plan list'})`);
  } else {
    if (APPLY) await prisma.$transaction((tx) => drawPlan(tx, overview.id, OVERVIEW_PLAN, overviewRooms), REDRAW_TX_OPTIONS);
    else await drawPlan(prisma, overview.id, OVERVIEW_PLAN, overviewRooms);
    console.log(`  ${OVERVIEW_PLAN.padEnd(28)} rooms=${overviewRooms.length} placed=0 (overview — see the header note)`);
  }

  console.log(`\n${areaList.length} area plans, ${totalRooms} rooms, ${totalPlaced} instruments placed`);
  const unplaced = await prisma.instrument.count({ where: { roomId: null, isGateway: false } });
  console.log(`instruments still unplaced: ${unplaced}`);
  if (!APPLY) console.log('\nDry run only. Re-run with --apply to execute.');
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
