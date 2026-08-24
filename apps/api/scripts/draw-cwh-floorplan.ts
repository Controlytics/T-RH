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

function stem(area: string): string {
  return area.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ')
    .map((w) => w.slice(0, 3).toUpperCase()).join('-').slice(0, 20);
}

function makeCode(area: string, n: number, used: Set<string>): string {
  let code = `${stem(area)}/${String(n).padStart(2, '0')}`;
  let i = 1;
  while (used.has(code)) code = `${stem(area)}/${String(n).padStart(2, '0')}-${i++}`;
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
function buildingLayout(
  areaName: string,
  locs: [string, string[]][],
  grade: Grade,
  used: Set<string>,
): RoomSpec[] {
  const N = locs.length;
  const perBand = Math.max(3, Math.min(7, Math.ceil(Math.sqrt(N * 1.35))));
  const bands = Math.ceil(N / perBand);

  const M = 0.014;                 // outer margin
  const SPINE_W = 0.055;           // vertical service corridor down the left
  const CORR_H = Math.min(0.06, Math.max(0.03, 0.42 / (bands + 1)));
  const left = M, right = 1 - M, top = M, bottom = 1 - M;
  const bodyX = left + SPINE_W;
  const bodyW = right - bodyX;
  const bandH = (bottom - top - CORR_H * (bands - 1)) / bands;

  const out: RoomSpec[] = [];

  // The spine, full height — one connected run, not a gap between blocks.
  out.push({
    code: makeCode(areaName, 90, used),
    label: 'SERVICE CORRIDOR',
    grade: 'CIRCULATION',
    rect: { x: left, y: top, w: SPINE_W, h: bottom - top },
    instruments: [],
  });

  let n = 0;
  for (let b = 0; b < bands; b++) {
    const y = top + b * (bandH + CORR_H);
    const slice = locs.slice(b * perBand, (b + 1) * perBand);
    if (!slice.length) continue;

    // Irregular widths that still sum exactly to bodyW.
    const weights = slice.map(([label]) => 0.72 + jitter(label) * 0.7);
    const totalW = weights.reduce((a, c) => a + c, 0);
    let cursor = bodyX;
    slice.forEach(([label, ids], i) => {
      const w = i === slice.length - 1 ? right - cursor : (bodyW * weights[i]) / totalW;
      // Doors face the corridor this band touches: below, unless it is the last
      // band, which opens upward onto the corridor above it.
      const wall: Door['wall'] = b < bands - 1 ? 'bottom' : 'top';
      out.push({
        code: makeCode(areaName, ++n, used),
        label: label.slice(0, 120),
        grade,
        rect: { x: cursor, y, w, h: bandH },
        instruments: ids,
        door: [{ wall, offset: 0.36, width: 0.2, kind: 'ENTRY' }],
      });
      cursor += w;
    });

    // The corridor under this band, spanning the body width.
    if (b < bands - 1) {
      out.push({
        code: makeCode(areaName, 80 + b, used),
        label: `CORRIDOR-${b + 1}`,
        grade: 'CIRCULATION',
        rect: { x: bodyX, y: y + bandH, w: bodyW, h: CORR_H },
        instruments: [],
      });
    }
  }
  return out;
}

interface RoomSpec { code: string; label: string; grade: Grade; rect: Rect; instruments: string[]; door?: Door[] }

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
    let plan = await prisma.floorplan.findFirst({ where: { name: planName }, select: { id: true } });
    if (!plan) {
      plan = await prisma.floorplan.create({
        data: {
          name: planName,
          // The dashboard DRAWS rooms and never renders this image; it is only a
          // tracing guide in the editor. Reusing the block's own scan is honest
          // — it is the same building — and avoids inventing a second asset.
          imagePath: overview.imagePath,
          imageWidth: overview.imageWidth, imageHeight: overview.imageHeight,
          sortOrder: idx + 1, createdBy: ACTOR, updatedBy: ACTOR,
        },
        select: { id: true },
      });
      console.log(`created plan "${planName}"`);
    }

    const grade = gradeForArea(area.name);
    const used = new Set<string>();
    const rooms = buildingLayout(area.name, area.locs, grade, used);

    const placed = await drawPlan(plan.id, planName, rooms);
    totalRooms += rooms.length; totalPlaced += placed;
    console.log(`  ${planName.padEnd(28)} rooms=${String(rooms.length).padStart(2)} placed=${placed}`);
  }

  // ── The overview: one room per area, no instruments ────────────────────
  const usedOverview = new Set<string>();
  const areaRects = partition(canvas, areaList, (a) => a.locs.length);
  const overviewRooms: RoomSpec[] = areaRects.map(({ item: area, rect }) => ({
    code: makeCode(area.name, 0, usedOverview),
    label: `${area.name} — ${area.locs.length} rooms`,
    grade: gradeForArea(area.name),
    rect: inset(rect, 0.0045),
    instruments: [],
  }));
  await drawPlan(overview.id, OVERVIEW_PLAN, overviewRooms);
  console.log(`  ${OVERVIEW_PLAN.padEnd(28)} rooms=${overviewRooms.length} placed=0 (overview — see the header note)`);

  console.log(`\n${areaList.length} area plans, ${totalRooms} rooms, ${totalPlaced} instruments placed`);
  const unplaced = await prisma.instrument.count({ where: { roomId: null, isGateway: false } });
  console.log(`instruments still unplaced: ${unplaced}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
