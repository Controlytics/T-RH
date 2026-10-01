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
 * e-signature: a script cannot prompt for re-authentication):
 *   - "CWH — QC": canvas = the building, the structure layer and the 2D style
 *     flag on its annotations;
 *   - its rooms, replaced wholesale — every room through the API's own
 *     `validateRoomPayload`, so nothing lands that the Layout Designer would
 *     refuse; outlines as polygons, the box derived by `roomGeometry`; each
 *     room's label / grade / meta carried over BY CODE from the rooms it
 *     replaces, so edits made there are kept;
 *   - the 12 QC instruments placed on the new rooms;
 *   - "CWH — QC Layout-2", if it still exists: its instruments released, its
 *     rooms deleted, then the plan itself — one audit row each.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { auditLog } from '../src/lib/audit.js';
import { validateRoomPayload, roomGeometry } from '../src/modules/floorplans/validation.js';
import {
  QC2_ROOMS, QC2_CANVAS, QC2_PLAN_NAME, QC2_RETIRED_PLAN_NAME, QC2_SOURCE, points2, edgeDoor, annotations2,
} from '../src/modules/floorplans/qc-layout-2.js';

const APPLY = process.argv.includes('--apply');
const ACTOR = 'superadmin';
const REASON = `Floor traced from ${QC2_SOURCE} by scripts/draw-qc-layout-2.ts. `
  + 'No e-signature was captured: a script cannot prompt for re-authentication as the HTTP route does.';
const audit = { userId: ACTOR, userRole: 'SUPER_ADMIN', ipAddress: '127.0.0.1', userAgent: 'scripts/draw-qc-layout-2.ts', sessionId: null };

type Tx = Prisma.TransactionClient;

const LINK_SELECT = {
  id: true, kind: true, fromEdge: true, offset: true, width: true, door: true, label: true,
  fromRoom: { select: { code: true } }, toRoom: { select: { code: true } },
} as const;
/** "A ↔ B", the same code the link routes audit under. */
const linkCode = (l: { fromRoom: { code: string }; toRoom: { code: string } }) => `${l.fromRoom.code} ↔ ${l.toRoom.code}`;

/** Release a room's instruments, delete it, and audit the deletion. */
async function deleteRoom(tx: Tx, room: { id: string; code: string }, planName: string, why: string) {
  await tx.instrument.updateMany({ where: { roomId: room.id }, data: { roomId: null } });
  await tx.floorplanRoom.delete({ where: { id: room.id } });
  await auditLog({
    ...audit, action: 'FLOORPLAN_ROOM_DELETED', targetType: 'floorplan_room', targetId: room.id,
    beforeValue: { code: room.code, plan: planName }, reason: REASON,
    signatureMeaning: `Room "${room.code}" deleted — ${why}`,
  }, tx);
}

async function main() {
  const target = await prisma.floorplan.findFirst({
    where: { name: QC2_PLAN_NAME },
    select: { id: true, rooms: { select: { id: true, code: true, label: true, grade: true, meta: true } }, links: { select: LINK_SELECT } },
  });
  if (!target) throw new Error(`"${QC2_PLAN_NAME}" not found — it is the plan this floor is drawn on.`);
  const retired = await prisma.floorplan.findFirst({
    where: { name: QC2_RETIRED_PLAN_NAME },
    select: { id: true, name: true, rooms: { select: { id: true, code: true, label: true, grade: true, meta: true } }, links: { select: LINK_SELECT } },
  });

  // Labels, grades and meta carried BY CODE. The retired plan's rooms win
  // where both carry a code: they are the most recent edit of this floor.
  const byCode = new Map(target.rooms.map((r) => [r.code.toUpperCase(), r]));
  for (const r of retired?.rooms ?? []) byCode.set(r.code.toUpperCase(), r);

  const codes = QC2_ROOMS.flatMap((r) => (r.instrument ? [r.instrument] : []));
  const instruments = await prisma.instrument.findMany({ where: { code: { in: codes } }, select: { id: true, code: true } });
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
    // The drawing's rooms are plain WHITE, and `meta.fill` is how a traced plan
    // says so. The rest of the carried meta (ceiling height, dimensions) is kept.
    const meta = { ...((carried?.meta as Record<string, unknown> | null) ?? {}), fill: '#ffffff' };
    return { payload, meta, instrumentId: r.instrument ? instruments.find((i) => i.code === r.instrument)!.id : null };
  });

  const ann = annotations2();
  console.log(`MODE: ${APPLY ? 'APPLY (writes)' : 'DRY RUN (no writes)'}`);
  console.log(`plan "${QC2_PLAN_NAME}" ${QC2_CANVAS.width}x${QC2_CANVAS.height}: ${target.rooms.length} rooms replaced by ${specs.length}, ${codes.length} instruments placed, style ${ann.style}`);
  for (const s of specs) {
    console.log(`  ${s.payload.code.padEnd(12)} ${String(s.payload.label).padEnd(26)} corners=${s.payload.points.length} doors=${s.payload.doors.length}${s.instrumentId ? ' +instrument' : ''}`);
  }
  for (const l of [...target.links, ...(retired?.links ?? [])]) {
    console.log(`  link ${l.kind} ${linkCode(l)} — deleted (its rooms are replaced)`);
  }
  console.log(`structure: ${ann.columns.length} columns, ${ann.windows.length} windows, ${ann.walls.length} stubs`);
  console.log(retired
    ? `retire "${retired.name}": ${retired.rooms.length} rooms and ${retired.links.length} links deleted, then the plan`
    : `"${QC2_RETIRED_PLAN_NAME}" not present — nothing to retire`);
  if (!APPLY) { console.log('\nDry run only. Re-run with --apply to execute.'); await prisma.$disconnect(); return; }

  // 0. Links die with their rooms (FK cascade) WITHOUT an audit row of their
  // own, so each is deleted here first, one FLOORPLAN_LINK_DELETED row apiece
  // in the route's own shape. On 2026-10-01 these were two CONNECTORS drawn in
  // the Layout Designer on 2026-09-22, to rooms the traced floor does not have.
  for (const [planName, links] of [[QC2_PLAN_NAME, target.links], [QC2_RETIRED_PLAN_NAME, retired?.links ?? []]] as const) {
    for (const l of links) {
      await prisma.$transaction(async (tx) => {
        await tx.floorplanRoomLink.delete({ where: { id: l.id } });
        await auditLog({
          ...audit, action: 'FLOORPLAN_LINK_DELETED', targetType: 'floorplan_room_link', targetId: l.id,
          beforeValue: { floorplan: planName, code: linkCode(l), kind: l.kind, fromEdge: l.fromEdge, offset: l.offset, width: l.width, door: l.door, label: l.label },
          reason: REASON, signatureMeaning: `Room link "${linkCode(l)}" deleted — "${planName}" redrawn from ${QC2_SOURCE}`,
        }, tx);
      });
    }
  }

  // 1. Retire the second plan first, so its rooms release the instruments.
  if (retired) {
    for (const r of retired.rooms) {
      await prisma.$transaction((tx) => deleteRoom(tx, r, retired.name, `"${retired.name}" merged into "${QC2_PLAN_NAME}"`));
    }
    await prisma.$transaction(async (tx) => {
      await tx.floorplan.delete({ where: { id: retired.id } });
      await auditLog({
        ...audit, action: 'FLOORPLAN_DELETED', targetType: 'floorplan', targetId: retired.id,
        beforeValue: { name: retired.name, rooms: retired.rooms.length },
        reason: REASON, signatureMeaning: `Floor plan "${retired.name}" deleted — its floor is now drawn on "${QC2_PLAN_NAME}"`,
      }, tx);
    });
    console.log(`deleted plan "${retired.name}"`);
  }

  // 2. The target plan: canvas, structure layer, style.
  await prisma.$transaction(async (tx) => {
    await tx.floorplan.update({
      where: { id: target.id },
      data: { imageWidth: QC2_CANVAS.width, imageHeight: QC2_CANVAS.height, annotations: ann as unknown as Prisma.InputJsonValue, updatedBy: ACTOR },
    });
    await auditLog({
      ...audit, action: 'FLOORPLAN_UPDATED', targetType: 'floorplan', targetId: target.id,
      afterValue: { name: QC2_PLAN_NAME, source: QC2_SOURCE, canvas: QC2_CANVAS, style: ann.style, structure: { columns: ann.columns.length, windows: ann.windows.length } },
      reason: REASON, signatureMeaning: `Floor plan "${QC2_PLAN_NAME}" redrawn from ${QC2_SOURCE}`,
    }, tx);
  });
  console.log(`updated plan "${QC2_PLAN_NAME}"`);

  // 3. Its old rooms out, the traced rooms in.
  for (const r of target.rooms) {
    await prisma.$transaction((tx) => deleteRoom(tx, r, QC2_PLAN_NAME, `"${QC2_PLAN_NAME}" redrawn from ${QC2_SOURCE}`));
  }
  let placed = 0;
  for (const s of specs) {
    await prisma.$transaction(async (tx) => {
      const p = s.payload;
      const room = await tx.floorplanRoom.create({
        data: {
          floorplanId: target.id, code: p.code, label: p.label,
          x: p.x, y: p.y, w: p.w, h: p.h,
          points: p.points as unknown as Prisma.InputJsonValue,
          doors: p.doors as unknown as Prisma.InputJsonValue,
          grade: p.grade,
          meta: s.meta as Prisma.InputJsonValue,
          createdBy: ACTOR, updatedBy: ACTOR,
        },
        select: { id: true },
      });
      if (s.instrumentId) {
        await tx.instrument.update({ where: { id: s.instrumentId }, data: { roomId: room.id } });
        placed += 1;
      }
      await auditLog({
        ...audit, action: 'FLOORPLAN_ROOM_CREATED', targetType: 'floorplan_room', targetId: room.id,
        afterValue: { code: p.code, label: p.label, plan: QC2_PLAN_NAME, grade: p.grade, corners: p.points.length, doors: p.doors.length, instruments: s.instrumentId ? 1 : 0 },
        reason: REASON,
        signatureMeaning: `Room "${p.code}" (${p.label}) drawn on "${QC2_PLAN_NAME}"${s.instrumentId ? ' with its instrument placed in it' : ''}`,
      }, tx);
    });
  }
  console.log(`rooms=${specs.length} instruments placed=${placed}`);
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
