/**
 * Draw the QC floor on "CWH — QC" from `src/modules/floorplans/qc-layout-2.ts`
 * (traced from `Layouts/CWH/QC Layout-2.png`, 2026-10-01).
 *
 *   npx tsx scripts/draw-qc-layout-2.ts            # dry run: validates and reports
 *   npx tsx scripts/draw-qc-layout-2.ts --apply    # writes
 *
 * History, same day: this floor was first drawn as a SECOND plan,
 * "CWH — QC Layout-2", beside the older trace. The operator then chose the 2D
 * design for it and asked for ONE plan — "CWH — QC" — so this script now
 * redraws "CWH — QC" in place and DELETES "CWH — QC Layout-2" (its instruments
 * move back here). `draw-cwh-floorplan.ts` no longer draws the QC area at all,
 * so a full run of it cannot put the older trace back over this one.
 *
 * What it writes, each step audited like the other drawing scripts (no
 * e-signature: a script cannot prompt for re-authentication), ALL IN ONE
 * TRANSACTION (audit 2026-10-12: a room per transaction left a half-drawn plan
 * when a step failed):
 *   - "CWH — QC": canvas = the building, the structure layer and the 2D style
 *     flag on its annotations;
 *   - its rooms, replaced wholesale — every room through the API's own
 *     `validateRoomPayload`, so nothing lands that the Layout Designer would
 *     refuse; outlines as polygons, the box derived by `roomGeometry`; each
 *     room's label / grade / meta AND ITS FOUR LIMITS carried over BY CODE
 *     from the rooms it replaces, so edits made there are kept (the limits
 *     were not carried until 2026-10-12 — a redraw cleared every in-spec band);
 *   - the 12 QC instruments placed on the new rooms;
 *   - "CWH — QC Layout-2", if it still exists: its instruments released, its
 *     rooms deleted, then the plan itself — one audit row each.
 * The dry run lists every room with the limits it will carry. The shared
 * write path is `src/modules/floorplans/redraw.ts`.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { auditLog } from '../src/lib/audit.js';
import { validateRoomPayload, roomGeometry } from '../src/modules/floorplans/validation.js';
import {
  QC2_ROOMS, QC2_CANVAS, QC2_PLAN_NAME, QC2_RETIRED_PLAN_NAME, QC2_SOURCE, points2, edgeDoor, annotations2,
} from '../src/modules/floorplans/qc-layout-2.js';
import {
  REDRAW_ROOM_SELECT, REDRAW_LINK_SELECT, REDRAW_TX_OPTIONS, assertUniqueRoomCodes, carriedLimits, describeLimits,
  linkCode, replacePlanRooms, type RedrawRoom,
} from '../src/modules/floorplans/redraw.js';

const APPLY = process.argv.includes('--apply');
const ACTOR = 'superadmin';
const REASON = `Floor traced from ${QC2_SOURCE} by scripts/draw-qc-layout-2.ts. `
  + 'No e-signature was captured: a script cannot prompt for re-authentication as the HTTP route does.';
const audit = { userId: ACTOR, userRole: 'SUPER_ADMIN', ipAddress: '127.0.0.1', userAgent: 'scripts/draw-qc-layout-2.ts', sessionId: null };

const PLAN_SELECT = { id: true, name: true, rooms: { select: REDRAW_ROOM_SELECT }, links: { select: REDRAW_LINK_SELECT } } as const;

async function main() {
  // Before anything is read or written: a layout that repeats a room code
  // would carry one room's limits onto two.
  assertUniqueRoomCodes(QC2_ROOMS.map((r) => r.code), QC2_PLAN_NAME);

  const target = await prisma.floorplan.findFirst({ where: { name: QC2_PLAN_NAME }, select: PLAN_SELECT });
  if (!target) throw new Error(`"${QC2_PLAN_NAME}" not found — it is the plan this floor is drawn on.`);
  const retired = await prisma.floorplan.findFirst({ where: { name: QC2_RETIRED_PLAN_NAME }, select: PLAN_SELECT });

  // Labels, grades, meta and limits carried BY CODE. The retired plan's rooms
  // win where both carry a code: they are the most recent edit of this floor.
  const byCode = new Map(target.rooms.map((r) => [r.code.toUpperCase(), r]));
  for (const r of retired?.rooms ?? []) byCode.set(r.code.toUpperCase(), r);

  const codes = QC2_ROOMS.flatMap((r) => (r.instrument ? [r.instrument] : []));
  const instruments = await prisma.instrument.findMany({ where: { code: { in: codes } }, select: { id: true, code: true } });
  const missing = codes.filter((c) => !instruments.some((i) => i.code === c));
  if (missing.length) throw new Error(`instruments not in the registry: ${missing.join(', ')}`);

  // Build and VALIDATE every room before anything is written.
  const specs: RedrawRoom[] = QC2_ROOMS.map((r) => {
    const carried = byCode.get(r.code.toUpperCase());
    const points = points2(r);
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
    // The drawing's rooms are plain WHITE, and `meta.fill` is how a traced plan
    // says so. The rest of the carried meta (ceiling height, dimensions) is kept.
    const meta = { ...((carried?.meta as Record<string, unknown> | null) ?? {}), fill: '#ffffff' };
    return {
      ...payload, label: payload.label ?? null, meta,
      limits: carriedLimits(carried),
      instrumentIds: r.instrument ? [instruments.find((i) => i.code === r.instrument)!.id] : [],
    };
  });

  const ann = annotations2();
  console.log(`MODE: ${APPLY ? 'APPLY (writes)' : 'DRY RUN (no writes)'}`);
  console.log(`plan "${QC2_PLAN_NAME}" ${QC2_CANVAS.width}x${QC2_CANVAS.height}: ${target.rooms.length} rooms replaced by ${specs.length}, ${codes.length} instruments placed, style ${ann.style}`);
  for (const s of specs) {
    console.log(`  ${s.code.padEnd(12)} ${String(s.label).padEnd(26)} corners=${s.points!.length} doors=${s.doors.length} limits=${describeLimits(s.limits)}${s.instrumentIds.length ? ' +instrument' : ''}`);
  }
  const kept = new Set(QC2_ROOMS.map((r) => r.code.toUpperCase()));
  for (const o of target.rooms) {
    if (!kept.has(o.code.toUpperCase())) console.log(`  room ${o.code} — on the plan today, not in the trace: deleted (limits ${describeLimits(carriedLimits(o))} go with it)`);
  }
  for (const l of [...target.links, ...(retired?.links ?? [])]) {
    console.log(`  link ${l.kind} ${linkCode(l)} — deleted (its rooms are replaced)`);
  }
  console.log(`structure: ${ann.columns.length} columns, ${ann.windows.length} windows, ${ann.walls.length} stubs`);
  console.log(retired
    ? `retire "${retired.name}": ${retired.rooms.length} rooms and ${retired.links.length} links deleted, then the plan`
    : `"${QC2_RETIRED_PLAN_NAME}" not present — nothing to retire`);
  if (!APPLY) { console.log('\nDry run only. Re-run with --apply to execute.'); await prisma.$disconnect(); return; }

  const placed = await prisma.$transaction(async (tx) => {
    // 1. Retire the second plan first, so its rooms release the instruments.
    // Its links go first, one audit row each (they would otherwise die with
    // their rooms, by cascade, unrecorded).
    if (retired) {
      const why = `"${retired.name}" merged into "${QC2_PLAN_NAME}"`;
      await replacePlanRooms(tx, {
        planId: retired.id, planName: retired.name, oldRooms: retired.rooms, oldLinks: retired.links, rooms: [],
        audit: { ...audit, reason: REASON }, actor: ACTOR, why,
      });
      await tx.floorplan.delete({ where: { id: retired.id } });
      await auditLog({
        ...audit, action: 'FLOORPLAN_DELETED', targetType: 'floorplan', targetId: retired.id,
        beforeValue: { name: retired.name, rooms: retired.rooms.length },
        reason: REASON, signatureMeaning: `Floor plan "${retired.name}" deleted — its floor is now drawn on "${QC2_PLAN_NAME}"`,
      }, tx);
    }

    // 2. The target plan: canvas, structure layer, style.
    await tx.floorplan.update({
      where: { id: target.id },
      data: { imageWidth: QC2_CANVAS.width, imageHeight: QC2_CANVAS.height, annotations: ann as unknown as Prisma.InputJsonValue, updatedBy: ACTOR },
    });
    await auditLog({
      ...audit, action: 'FLOORPLAN_UPDATED', targetType: 'floorplan', targetId: target.id,
      afterValue: { name: QC2_PLAN_NAME, source: QC2_SOURCE, canvas: QC2_CANVAS, style: ann.style, structure: { columns: ann.columns.length, windows: ann.windows.length } },
      reason: REASON, signatureMeaning: `Floor plan "${QC2_PLAN_NAME}" redrawn from ${QC2_SOURCE}`,
    }, tx);

    // 3. Its links and old rooms out, the traced rooms in.
    return replacePlanRooms(tx, {
      planId: target.id, planName: QC2_PLAN_NAME, oldRooms: target.rooms, oldLinks: target.links, rooms: specs,
      audit: { ...audit, reason: REASON }, actor: ACTOR, why: `"${QC2_PLAN_NAME}" redrawn from ${QC2_SOURCE}`,
    });
  }, REDRAW_TX_OPTIONS);
  console.log(`rooms=${specs.length} instruments placed=${placed}`);
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
