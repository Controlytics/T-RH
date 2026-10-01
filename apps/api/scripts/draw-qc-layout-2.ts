/**
 * Draw "CWH — QC Layout-2" from `src/modules/floorplans/qc-layout-2.ts`
 * (traced from `Layouts/CWH/QC Layout-2.png`, 2026-10-01).
 *
 *   npx tsx scripts/draw-qc-layout-2.ts            # dry run: validates and reports
 *   npx tsx scripts/draw-qc-layout-2.ts --apply    # writes
 *
 * Its own script rather than another entry in `draw-cwh-floorplan.ts`, whose
 * unit is ONE plan per functional-location area: this is a SECOND plan for the
 * QC area, and it must not delete or redraw "CWH — QC".
 *
 * What it writes, each step audited like the other drawing scripts (no
 * e-signature: a script cannot prompt for re-authentication):
 *   - the plan (created, or updated in place on a rerun), canvas = the building;
 *   - its rooms, replaced wholesale — every room through the API's own
 *     `validateRoomPayload`, so nothing lands that the Layout Designer would
 *     refuse; outlines as polygons, the box derived by `roomGeometry`;
 *   - each room's label / grade / meta carried over BY CODE from the rooms of
 *     "CWH — QC" (the same floor), so edits made there are kept;
 *   - the 12 QC instruments MOVED onto this plan's rooms (operator's choice) —
 *     an instrument sits in one room, so "CWH — QC" shows none afterwards;
 *   - the structure layer (columns, windows, partition stubs).
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { auditLog } from '../src/lib/audit.js';
import { validateRoomPayload, roomGeometry } from '../src/modules/floorplans/validation.js';
import {
  QC2_ROOMS, QC2_CANVAS, QC2_PLAN_NAME, QC2_SOURCE, points2, edgeDoor, annotations2,
} from '../src/modules/floorplans/qc-layout-2.js';

const APPLY = process.argv.includes('--apply');
const ACTOR = 'superadmin';
const SOURCE_PLAN = 'CWH — QC';
const REASON = `Floor traced from ${QC2_SOURCE} by scripts/draw-qc-layout-2.ts. `
  + 'No e-signature was captured: a script cannot prompt for re-authentication as the HTTP route does.';
const audit = { userId: ACTOR, userRole: 'SUPER_ADMIN', ipAddress: '127.0.0.1', userAgent: 'scripts/draw-qc-layout-2.ts', sessionId: null };

async function main() {
  const source = await prisma.floorplan.findFirst({
    where: { name: SOURCE_PLAN },
    select: { id: true, sortOrder: true, rooms: { select: { code: true, label: true, grade: true, meta: true } } },
  });
  if (!source) throw new Error(`"${SOURCE_PLAN}" not found — it is where the room names and grades come from.`);
  const byCode = new Map(source.rooms.map((r) => [r.code.toUpperCase(), r]));

  const codes = QC2_ROOMS.flatMap((r) => (r.instrument ? [r.instrument] : []));
  const instruments = await prisma.instrument.findMany({ where: { code: { in: codes } }, select: { id: true, code: true, roomId: true } });
  const missing = codes.filter((c) => !instruments.some((i) => i.code === c));
  if (missing.length) throw new Error(`instruments not in the registry: ${missing.join(', ')}`);

  // Build and VALIDATE every room before anything is written.
  const specs = QC2_ROOMS.map((r) => {
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
    // The drawing's rooms are plain WHITE (no fills, unlike the QC mockup), and
    // `meta.fill` is how a traced plan says so — it overrides the grade tint.
    // The rest of the carried meta (ceiling height, dimensions) is kept.
    const meta = { ...((carried?.meta as Record<string, unknown> | null) ?? {}), fill: '#ffffff' };
    return { payload, meta, instrumentId: r.instrument ? instruments.find((i) => i.code === r.instrument)!.id : null };
  });

  console.log(`MODE: ${APPLY ? 'APPLY (writes)' : 'DRY RUN (no writes)'}`);
  console.log(`plan "${QC2_PLAN_NAME}" ${QC2_CANVAS.width}x${QC2_CANVAS.height}, ${specs.length} rooms, ${codes.length} instruments to move`);
  for (const s of specs) {
    console.log(`  ${s.payload.code.padEnd(12)} ${String(s.payload.label).padEnd(26)} corners=${s.payload.points.length} doors=${s.payload.doors.length}${s.instrumentId ? ' +instrument' : ''}`);
  }
  const ann = annotations2();
  console.log(`structure: ${ann.columns.length} columns, ${ann.windows.length} windows, ${ann.walls.length} stubs`);
  if (!APPLY) { console.log('\nDry run only. Re-run with --apply to execute.'); await prisma.$disconnect(); return; }

  let plan = await prisma.floorplan.findFirst({ where: { name: QC2_PLAN_NAME }, select: { id: true } });
  if (!plan) {
    plan = await prisma.$transaction(async (tx) => {
      const p = await tx.floorplan.create({
        data: {
          name: QC2_PLAN_NAME, imagePath: null,
          imageWidth: QC2_CANVAS.width, imageHeight: QC2_CANVAS.height,
          // Beside "CWH — QC" in every plan list (ties sort by name).
          sortOrder: source.sortOrder,
          annotations: ann as unknown as Prisma.InputJsonValue,
          createdBy: ACTOR, updatedBy: ACTOR,
        },
        select: { id: true },
      });
      await auditLog({
        ...audit, action: 'FLOORPLAN_CREATED', targetType: 'floorplan', targetId: p.id,
        afterValue: { name: QC2_PLAN_NAME, source: QC2_SOURCE, canvas: QC2_CANVAS },
        reason: REASON, signatureMeaning: `Floor plan "${QC2_PLAN_NAME}" traced from ${QC2_SOURCE}`,
      }, tx);
      return p;
    });
    console.log(`created plan "${QC2_PLAN_NAME}"`);
  } else {
    await prisma.$transaction(async (tx) => {
      await tx.floorplan.update({
        where: { id: plan!.id },
        data: { imageWidth: QC2_CANVAS.width, imageHeight: QC2_CANVAS.height, annotations: ann as unknown as Prisma.InputJsonValue, updatedBy: ACTOR },
      });
      await auditLog({
        ...audit, action: 'FLOORPLAN_UPDATED', targetType: 'floorplan', targetId: plan!.id,
        afterValue: { name: QC2_PLAN_NAME, source: QC2_SOURCE, canvas: QC2_CANVAS, structure: { columns: ann.columns.length, windows: ann.windows.length } },
        reason: REASON, signatureMeaning: `Floor plan "${QC2_PLAN_NAME}" redrawn from ${QC2_SOURCE}`,
      }, tx);
    });
    console.log(`updated plan "${QC2_PLAN_NAME}"`);
  }

  const old = await prisma.floorplanRoom.findMany({ where: { floorplanId: plan.id }, select: { id: true, code: true } });
  for (const r of old) {
    await prisma.$transaction(async (tx) => {
      // Instruments in a room being replaced are re-placed below; release them
      // first so the delete cannot be blocked or leave a dangling room id.
      await tx.instrument.updateMany({ where: { roomId: r.id }, data: { roomId: null } });
      await tx.floorplanRoom.delete({ where: { id: r.id } });
      await auditLog({
        ...audit, action: 'FLOORPLAN_ROOM_DELETED', targetType: 'floorplan_room', targetId: r.id,
        beforeValue: { code: r.code, plan: QC2_PLAN_NAME }, reason: REASON,
        signatureMeaning: `Room "${r.code}" deleted — "${QC2_PLAN_NAME}" redrawn from ${QC2_SOURCE}`,
      }, tx);
    });
  }

  let moved = 0;
  for (const s of specs) {
    await prisma.$transaction(async (tx) => {
      const p = s.payload;
      const room = await tx.floorplanRoom.create({
        data: {
          floorplanId: plan!.id, code: p.code, label: p.label,
          x: p.x, y: p.y, w: p.w, h: p.h,
          points: p.points as unknown as Prisma.InputJsonValue,
          doors: p.doors as unknown as Prisma.InputJsonValue,
          grade: p.grade,
          meta: s.meta ? (s.meta as Prisma.InputJsonValue) : Prisma.DbNull,
          createdBy: ACTOR, updatedBy: ACTOR,
        },
        select: { id: true },
      });
      if (s.instrumentId) {
        await tx.instrument.update({ where: { id: s.instrumentId }, data: { roomId: room.id } });
        moved += 1;
      }
      await auditLog({
        ...audit, action: 'FLOORPLAN_ROOM_CREATED', targetType: 'floorplan_room', targetId: room.id,
        afterValue: { code: p.code, label: p.label, plan: QC2_PLAN_NAME, grade: p.grade, corners: p.points.length, doors: p.doors.length, instruments: s.instrumentId ? 1 : 0 },
        reason: REASON,
        signatureMeaning: `Room "${p.code}" (${p.label}) drawn on "${QC2_PLAN_NAME}"${s.instrumentId ? ' with its instrument moved onto it' : ''}`,
      }, tx);
    });
  }
  console.log(`rooms=${specs.length} instruments moved=${moved}`);
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
