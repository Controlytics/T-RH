/**
 * Draw a floor in the 2D ARCHITECTURAL style from its trace
 * (`src/modules/floorplans/architectural-layout.ts`).
 *
 *   npx tsx scripts/draw-architectural-floor.ts --area "QC Microbiology"            # dry run: validates and reports
 *   npx tsx scripts/draw-architectural-floor.ts --area "QC Microbiology" --apply    # writes
 *
 * Floors it knows: QC Microbiology (`microbiology-layout.ts`, traced from
 * `Layouts/CWH/Microbiology.png`), QC 3 (`qc3-layout.ts`, from
 * `Layouts/CWH/QC 3 Layout.png`), Module-E (`module-e-layout.ts`) and
 * Module-F's TWO floors (`module-f-layout.ts`, from `Layouts/CWH/Mod-F Ground
 * floor.pdf` and `Mod-F First floor.pdf`), all 2026-10-01. An area with
 * several floors is drawn whole: one plan per floor, each with its
 * `annotations.floor`, so the dashboard lists the building once and offers
 * the floors. The QC floor is drawn the same
 * way by its OWN script, `draw-qc-layout-2.ts`, which was written first and
 * also retires the second plan that floor was once drawn on; this is that
 * script without the retire step, for every floor after it.
 * `draw-cwh-floorplan.ts` skips both areas, so a full run of it cannot put a
 * generated or rectangle-traced floor back over one of these.
 *
 * What it writes, each step audited like the other drawing scripts (no
 * e-signature: a script cannot prompt for re-authentication), and EACH PLAN IN
 * ONE TRANSACTION (audit 2026-10-12: a room per transaction left a half-drawn
 * plan when a step failed):
 *   - the area's plan: canvas = the building, the structure layer and the 2D
 *     style flag on its annotations — FOUND by the trace's plan name; else
 *     RENAMED from the name the trace says it had (`renamesPlan`: Module-F's
 *     generated plan becomes its ground floor rather than standing beside it);
 *     else CREATED (a second floor), with the sibling floor's sort order;
 *   - its rooms, replaced wholesale — every room through the API's own
 *     `validateRoomPayload`, so nothing lands that the Layout Designer would
 *     refuse; outlines as polygons, the box derived by `roomGeometry`; a room's
 *     label / grade / meta AND ITS FOUR LIMITS carried over BY CODE from the
 *     room it replaces, so edits made there are kept (the limits were not
 *     carried until 2026-10-12 — a redraw cleared every room's in-spec band);
 *   - the trace's instruments placed on the new rooms;
 *   - any room links on the plan deleted first, one audit row each (they would
 *     otherwise die with their rooms, by cascade, unrecorded).
 * The dry run lists every room with the limits it will carry.
 * The shared write path is `src/modules/floorplans/redraw.ts`.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { auditLog } from '../src/lib/audit.js';
import { validateRoomPayload, roomGeometry } from '../src/modules/floorplans/validation.js';
import { archCanvas, archPoints, archAnnotations, edgeDoor, type ArchLayout } from '../src/modules/floorplans/architectural-layout.js';
import { MICROBIOLOGY_LAYOUT } from '../src/modules/floorplans/microbiology-layout.js';
import { QC3_LAYOUT } from '../src/modules/floorplans/qc3-layout.js';
import { MODULE_E_LAYOUT } from '../src/modules/floorplans/module-e-layout.js';
import { MODULE_F_GROUND_LAYOUT, MODULE_F_FIRST_LAYOUT } from '../src/modules/floorplans/module-f-layout.js';
import {
  REDRAW_ROOM_SELECT, REDRAW_LINK_SELECT, REDRAW_TX_OPTIONS, assertUniqueRoomCodes, carriedLimits, describeLimits,
  linkCode, replacePlanRooms, type RedrawRoom,
} from '../src/modules/floorplans/redraw.js';

/** The floors drawn in this style by this script, keyed by AREA name — one or several per area. */
const LAYOUTS: Record<string, ArchLayout[]> = {
  [MICROBIOLOGY_LAYOUT.area]: [MICROBIOLOGY_LAYOUT],
  [QC3_LAYOUT.area]: [QC3_LAYOUT],
  [MODULE_E_LAYOUT.area]: [MODULE_E_LAYOUT],
  [MODULE_F_GROUND_LAYOUT.area]: [MODULE_F_GROUND_LAYOUT, MODULE_F_FIRST_LAYOUT],
};

const APPLY = process.argv.includes('--apply');
const areaAt = process.argv.indexOf('--area');
const AREA = areaAt >= 0 ? process.argv[areaAt + 1] : undefined;
const SCRIPT = 'scripts/draw-architectural-floor.ts';
const ACTOR = 'superadmin';
const audit = { userId: ACTOR, userRole: 'SUPER_ADMIN', ipAddress: '127.0.0.1', userAgent: SCRIPT, sessionId: null };

/** The database a floor is read from and written to: the plan's transaction under --apply, else the client. */
type Db = Prisma.TransactionClient;

const PLAN_SELECT = {
  id: true, name: true, sortOrder: true,
  rooms: { select: REDRAW_ROOM_SELECT },
  links: { select: REDRAW_LINK_SELECT },
} as const;

async function main() {
  const layouts = AREA ? LAYOUTS[AREA] : undefined;
  if (!layouts) {
    throw new Error(`--area "<name>" is required. Floors this script draws: ${Object.keys(LAYOUTS).map((a) => `"${a}"`).join(', ')}`);
  }
  console.log(`MODE: ${APPLY ? 'APPLY (writes)' : 'DRY RUN (no writes)'}`);
  for (const layout of layouts) {
    // ONE transaction per plan: either the whole floor is redrawn, or nothing.
    if (APPLY) await prisma.$transaction((tx) => drawFloor(tx, layout, layouts), REDRAW_TX_OPTIONS);
    else await drawFloor(prisma, layout, layouts);
  }
  if (!APPLY) console.log('\nDry run only. Re-run with --apply to execute.');
  await prisma.$disconnect();
}

/**
 * The plan a floor is drawn on: the one of its name; else the one it RENAMES
 * (the generated plan the area had before it had floors — renamed, audited,
 * never left beside the new ones); else a NEW plan beside its sibling floor
 * (same sort order, so the building's floors stay together in the list).
 * In a dry run a plan that would be renamed or created is reported and the
 * floor is checked against it as it is, or against an empty plan.
 */
async function targetPlan(db: Db, layout: ArchLayout, siblings: ArchLayout[], reason: string) {
  const found = await db.floorplan.findFirst({ where: { name: layout.planName }, select: PLAN_SELECT });
  if (found) return found;
  if (layout.renamesPlan) {
    const old = await db.floorplan.findFirst({ where: { name: layout.renamesPlan }, select: PLAN_SELECT });
    if (!old) throw new Error(`neither "${layout.planName}" nor "${layout.renamesPlan}" (the plan it renames) exists.`);
    console.log(`plan "${old.name}" -> renamed "${layout.planName}"`);
    if (!APPLY) return { ...old, name: layout.planName };
    await db.floorplan.update({ where: { id: old.id }, data: { name: layout.planName, updatedBy: ACTOR } });
    await auditLog({
      ...audit, action: 'FLOORPLAN_UPDATED', targetType: 'floorplan', targetId: old.id,
      beforeValue: { name: old.name }, afterValue: { name: layout.planName },
      reason, signatureMeaning: `Floor plan "${old.name}" renamed "${layout.planName}" — one floor of ${layout.floor?.group ?? layout.area}`,
    }, db);
    return { ...old, name: layout.planName };
  }
  // Beside its sibling floor, when one is on the plan list already.
  // ...by its name, or the name it had before it was renamed (a dry run renames nothing).
  const siblingNames = siblings.filter((l) => l !== layout).flatMap((l) => (l.renamesPlan ? [l.planName, l.renamesPlan] : [l.planName]));
  const sibling = siblingNames.length ? await db.floorplan.findFirst({ where: { name: { in: siblingNames } }, select: { sortOrder: true } }) : null;
  const sortOrder = sibling?.sortOrder ?? ((await db.floorplan.aggregate({ _max: { sortOrder: true } }))._max.sortOrder ?? -1) + 1;
  const canvas = archCanvas(layout.building);
  const empty = { id: '', name: layout.planName, sortOrder, rooms: [], links: [] };
  console.log(`plan "${layout.planName}" — not on the list: created (sort order ${sortOrder})`);
  if (!APPLY) return empty;
  const plan = await db.floorplan.create({
    data: { name: layout.planName, imagePath: null, imageWidth: canvas.width, imageHeight: canvas.height, isActive: true, sortOrder, createdBy: ACTOR, updatedBy: ACTOR },
    select: { id: true },
  });
  await auditLog({
    ...audit, action: 'FLOORPLAN_CREATED', targetType: 'floorplan', targetId: plan.id,
    afterValue: { name: layout.planName, imagePath: null, imageWidth: canvas.width, imageHeight: canvas.height, isActive: true, sortOrder },
    reason, signatureMeaning: `Floor plan "${layout.planName}" created — one floor of ${layout.floor?.group ?? layout.area}, from ${layout.source}`,
  }, db);
  return { ...empty, id: plan.id };
}

async function drawFloor(db: Db, layout: ArchLayout, siblings: ArchLayout[]) {
  const REASON = `Floor traced from ${layout.source} by ${SCRIPT}. `
    + 'No e-signature was captured: a script cannot prompt for re-authentication as the HTTP route does.';

  // Before anything is read or written: a layout that repeats a room code
  // would carry one room's limits onto two.
  assertUniqueRoomCodes(layout.rooms.map((r) => r.code), layout.planName);

  const target = await targetPlan(db, layout, siblings, REASON);
  const byCode = new Map(target.rooms.map((r) => [r.code.toUpperCase(), r]));

  const codes = layout.rooms.flatMap((r) => (r.instrument ? [r.instrument] : []));
  const instruments = await db.instrument.findMany({ where: { code: { in: codes } }, select: { id: true, code: true } });
  const missing = codes.filter((c) => !instruments.some((i) => i.code === c));
  if (missing.length) throw new Error(`instruments not in the registry: ${missing.join(', ')}`);

  // Build and VALIDATE every room before anything is written.
  const specs: RedrawRoom[] = layout.rooms.map((r) => {
    const carried = byCode.get(r.code.toUpperCase());
    const points = archPoints(layout.building, r);
    const doors = r.doors.map((d) => edgeDoor(r, d));
    const box = roomGeometry({ x: 0, y: 0, w: 1, h: 1, points });
    const payload = {
      code: r.code,
      label: carried?.label ?? r.label,
      ...box,
      points,
      doors,
      grade: (carried?.grade as string | null) ?? r.grade ?? null,
    };
    const v = validateRoomPayload(payload);
    if (!v.ok) throw new Error(`${r.code}: ${v.error}`);
    // The trace's own ceiling height and dimensions, then whatever the room it
    // replaces carried; `fill` is white — this style never paints the
    // draughtsman's colour, and a stale tint would show in the Layout Designer.
    const meta = { ...(r.meta ?? {}), ...((carried?.meta as Record<string, unknown> | null) ?? {}), fill: '#ffffff' };
    return {
      ...payload, label: payload.label ?? null, meta,
      limits: carriedLimits(carried),
      instrumentIds: r.instrument ? [instruments.find((i) => i.code === r.instrument)!.id] : [],
    };
  });

  const canvas = archCanvas(layout.building);
  const ann = archAnnotations(layout.building, layout.annotations, { floor: layout.floor, north: layout.north });
  const dropped = target.rooms.filter((o) => !layout.rooms.some((r) => r.code.toUpperCase() === o.code.toUpperCase()));
  const floorNote = (ann.floor ? `, floor "${ann.floor.label}" of "${ann.floor.group}"` : '') + (ann.north !== undefined ? `, north ${ann.north} deg` : '');
  console.log(`plan "${layout.planName}" ${canvas.width}x${canvas.height}: ${target.rooms.length} rooms replaced by ${specs.length}, ${codes.length} instruments placed, style ${ann.style}${floorNote}`);
  for (const s of specs) {
    console.log(`  ${s.code.padEnd(14)} ${String(s.label).padEnd(26)} grade=${String(s.grade).padEnd(11)} corners=${s.points!.length} doors=${s.doors.length} limits=${describeLimits(s.limits)}${s.instrumentIds.length ? ' +instrument' : ''}`);
  }
  for (const o of dropped) console.log(`  room ${o.code} — on the plan today, not in the trace: deleted (limits ${describeLimits(carriedLimits(o))} go with it)`);
  for (const l of target.links) console.log(`  link ${l.kind} ${linkCode(l)} — deleted (its rooms are replaced)`);
  console.log(`structure: ${ann.columns.length} columns, ${ann.windows.length} windows, ${ann.walls.length} stubs, ${ann.equipment.length} outlined plant`);
  if (!APPLY) return;

  // 1. The plan: canvas, structure layer, style.
  await db.floorplan.update({
    where: { id: target.id },
    data: { imageWidth: canvas.width, imageHeight: canvas.height, annotations: ann as unknown as Prisma.InputJsonValue, updatedBy: ACTOR },
  });
  await auditLog({
    ...audit, action: 'FLOORPLAN_UPDATED', targetType: 'floorplan', targetId: target.id,
    afterValue: { name: layout.planName, source: layout.source, canvas, style: ann.style, floor: ann.floor ?? null, north: ann.north ?? null, structure: { columns: ann.columns.length, windows: ann.windows.length, stubs: ann.walls.length, equipment: ann.equipment.length } },
    reason: REASON, signatureMeaning: `Floor plan "${layout.planName}" redrawn from ${layout.source}`,
  }, db);

  // 2. Its links and old rooms out (instruments released), the traced rooms in.
  const placed = await replacePlanRooms(db, {
    planId: target.id, planName: layout.planName,
    oldRooms: target.rooms, oldLinks: target.links, rooms: specs,
    audit: { ...audit, reason: REASON }, actor: ACTOR,
    why: `"${layout.planName}" redrawn from ${layout.source}`,
  });
  console.log(`updated plan "${layout.planName}": rooms=${specs.length} instruments placed=${placed}`);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
