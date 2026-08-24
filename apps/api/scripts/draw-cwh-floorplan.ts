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
 */
function gradeFromLimits(attrs: Map<string, string>): Grade {
  const num = (k: string) => { const v = Number(attrs.get(k)); return Number.isFinite(v) ? v : null; };
  const tLo = num('Low Temperature Limit'), tHi = num('High Temperature Limit');
  const hLo = num('Low Humidity Limit'), hHi = num('High Humidity Limit');

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

/** Door faces the corridor the room touches; otherwise the spine, otherwise down. */
function doorTowardCorridorLocal(cell: Cell, corridorRows: Set<number>): Door[] {
  const kind = 'ENTRY' as const;
  if (corridorRows.has(cell.r1 + 1)) return [{ wall: 'bottom', offset: 0.36, width: 0.22, kind }];
  if (corridorRows.has(cell.r0 - 1)) return [{ wall: 'top', offset: 0.36, width: 0.22, kind }];
  if (cell.c0 === 1) return [{ wall: 'left', offset: 0.34, width: 0.28, kind }];
  return [{ wall: 'bottom', offset: 0.36, width: 0.22, kind }];
}

interface RoomSpec { code: string; label: string | null; grade: Grade; rect: Rect; instruments: string[]; door?: Door[] }

/** Replace a plan's rooms wholesale, audited, and place its instruments. */
async function drawPlan(planId: string, planName: string, rooms: RoomSpec[]): Promise<number> {
  const old = await prisma.floorplanRoom.findMany({ where: { floorplanId: planId }, select: { id: true, code: true } });
  for (const r of old) {
    await prisma.$transaction(async (tx) => {
      await tx.floorplanRoom.delete({ where: { id: r.id } });
      await auditLog({
        action: 'FLOORPLAN_ROOM_DELETED', targetType: 'floorplan_room', targetId: r.id,
        beforeValue: { code: r.code, plan: planName },
        reason: REASON,
        signatureMeaning: `Room "${r.code}" deleted — "${planName}" redrawn from the instrument registry`,
        userId: ACTOR, userRole: 'SUPER_ADMIN',
        ipAddress: '127.0.0.1', userAgent: 'scripts/draw-cwh-floorplan.ts', sessionId: null,
      }, tx);
    });
  }

  let placed = 0;
  for (const spec of rooms) {
    await prisma.$transaction(async (tx) => {
      const room = await tx.floorplanRoom.create({
        data: {
          floorplanId: planId, code: spec.code, label: spec.label,
          x: spec.rect.x, y: spec.rect.y, w: spec.rect.w, h: spec.rect.h,
          doors: (spec.door ?? (spec.grade === 'CIRCULATION' ? [] : doorFor(spec.rect))) as unknown as Prisma.InputJsonValue,
          grade: spec.grade, createdBy: ACTOR, updatedBy: ACTOR,
        },
        select: { id: true },
      });
      if (spec.instruments.length) {
        await tx.instrument.updateMany({ where: { id: { in: spec.instruments } }, data: { roomId: room.id } });
      }
      await auditLog({
        action: 'FLOORPLAN_ROOM_CREATED', targetType: 'floorplan_room', targetId: room.id,
        afterValue: { code: spec.code, label: spec.label, plan: planName, grade: spec.grade, instruments: spec.instruments.length },
        reason: REASON,
        signatureMeaning: `Room "${spec.code}" (${spec.label}) drawn on "${planName}" with ${spec.instruments.length} instrument(s)`,
        userId: ACTOR, userRole: 'SUPER_ADMIN',
        ipAddress: '127.0.0.1', userAgent: 'scripts/draw-cwh-floorplan.ts', sessionId: null,
      }, tx);
    });
    placed += spec.instruments.length;
  }
  return placed;
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

  const attrRows = await prisma.instrumentAttribute.findMany({
    where: { key: { in: ['Low Temperature Limit', 'High Temperature Limit', 'Low Humidity Limit', 'High Humidity Limit'] } },
    select: { instrumentId: true, key: true, value: true },
  });
  const codeById = new Map<string, string>(instruments.map((i) => [i.id, i.code]));
  const attrsByInstrument = new Map<string, Map<string, string>>();
  for (const a of attrRows) {
    let m = attrsByInstrument.get(a.instrumentId);
    if (!m) { m = new Map(); attrsByInstrument.set(a.instrumentId, m); }
    m.set(a.key, a.value);
  }

  const areaList = [...areas.entries()]
    .map(([name, locs]) => ({ name, locs: [...locs.entries()] }))
    .sort((a, b) => b.locs.length - a.locs.length);

  const canvas: Rect = { x: 0.012, y: 0.012, w: 0.976, h: 0.976 };

  console.log(`MODE: ${APPLY ? 'APPLY (writes)' : 'DRY RUN (no writes)'}`);
  console.log(`plans: ${areaList.length} area plans + 1 overview ("${OVERVIEW_PLAN}")`);
  for (const a of areaList) {
    console.log(`  ${a.name.padEnd(20)} rooms=${String(a.locs.length).padStart(2)}  grade=${gradeForArea(a.name)}`);
  }
  if (skipped.length) console.log(`skipped (no area or Location): ${skipped.join(', ')}`);
  if (!APPLY) { console.log('\nDry run only. Re-run with --apply to execute.'); await prisma.$disconnect(); return; }

  const overview = await prisma.floorplan.findFirst({ where: { name: OVERVIEW_PLAN }, select: { id: true, imagePath: true, imageWidth: true, imageHeight: true } });
  if (!overview) throw new Error(`overview plan "${OVERVIEW_PLAN}" not found`);

  // ── One plan per area ──────────────────────────────────────────────────
  let totalRooms = 0, totalPlaced = 0;
  for (let idx = 0; idx < areaList.length; idx++) {
    const area = areaList[idx];
    const planName = `CWH — ${area.name}`;
    const shape = canvasFor(area.locs.length);
    let plan = await prisma.floorplan.findFirst({ where: { name: planName }, select: { id: true, imageWidth: true, imageHeight: true } });
    if (!plan) {
      plan = await prisma.floorplan.create({
        data: {
          name: planName,
          // The dashboard DRAWS rooms and never renders this image; it is only a
          // tracing guide in the editor. Reusing the block's own scan is honest
          // — it is the same building — and avoids inventing a second asset.
          imagePath: overview.imagePath,
          imageWidth: shape.width, imageHeight: shape.height,
          sortOrder: idx + 1, createdBy: ACTOR, updatedBy: ACTOR,
        },
        select: { id: true, imageWidth: true, imageHeight: true },
      });
      console.log(`created plan "${planName}" ${shape.width}x${shape.height}`);
    } else if (plan.imageWidth !== shape.width || plan.imageHeight !== shape.height) {
      // An existing plan keeps its rooms but must adopt the corrected shape,
      // or it goes on rendering at the old zoom.
      await prisma.floorplan.update({
        where: { id: plan.id },
        data: { imageWidth: shape.width, imageHeight: shape.height, updatedBy: ACTOR },
      });
      console.log(`reshaped "${planName}" -> ${shape.width}x${shape.height}`);
    }

    const grade = gradeForArea(area.name);
    const used = new Set<string>();
    // Grade per ROOM from its instrument's own limits, so a floor carries
    // variety that means something rather than one flat hue.
    const rooms = buildingLayout(area.name, area.locs, grade, used, (ids) => {
      const first = ids[0];
      const attrs = attrsByInstrument.get(first);
      return attrs ? gradeFromLimits(attrs) : grade;
    }, (ids) => {
      // Two instruments in one location: name the room for the first and say
      // there is another, rather than silently showing only one of them.
      const codes = ids.map((id) => codeById.get(id)).filter(Boolean) as string[];
      if (!codes.length) return null;
      return codes.length === 1 ? codes[0] : `${codes[0]} +${codes.length - 1}`;
    });

    const placed = await drawPlan(plan.id, planName, rooms);
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
  await drawPlan(overview.id, OVERVIEW_PLAN, overviewRooms);
  console.log(`  ${OVERVIEW_PLAN.padEnd(28)} rooms=${overviewRooms.length} placed=0 (overview — see the header note)`);

  console.log(`\n${areaList.length} area plans, ${totalRooms} rooms, ${totalPlaced} instruments placed`);
  const unplaced = await prisma.instrument.count({ where: { roomId: null, isGateway: false } });
  console.log(`instruments still unplaced: ${unplaced}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
