/**
 * Draw a floor in the 2D ARCHITECTURAL style from its trace
 * (`src/modules/floorplans/architectural-layout.ts`).
 *
 *   npx tsx scripts/draw-architectural-floor.ts --area "QC Microbiology"            # dry run: validates and reports
 *   npx tsx scripts/draw-architectural-floor.ts --area "QC Microbiology" --apply    # writes
 *
 * Floors it knows: QC Microbiology (`microbiology-layout.ts`, traced from
 * `Layouts/CWH/Microbiology.png`, 2026-10-01). The QC floor is drawn the same
 * way by its OWN script, `draw-qc-layout-2.ts`, which was written first and
 * also retires the second plan that floor was once drawn on; this is that
 * script without the retire step, for every floor after it.
 * `draw-cwh-floorplan.ts` skips both areas, so a full run of it cannot put a
 * generated or rectangle-traced floor back over one of these.
 *
 * What it writes, each step audited like the other drawing scripts (no
 * e-signature: a script cannot prompt for re-authentication):
 *   - the area's plan: canvas = the building, the structure layer and the 2D
 *     style flag on its annotations;
 *   - its rooms, replaced wholesale — every room through the API's own
 *     `validateRoomPayload`, so nothing lands that the Layout Designer would
 *     refuse; outlines as polygons, the box derived by `roomGeometry`; a room's
 *     label / grade / meta carried over BY CODE from the room it replaces, so
 *     edits made there are kept;
 *   - the trace's instruments placed on the new rooms;
 *   - any room links on the plan deleted first, one audit row each (they would
 *     otherwise die with their rooms, by cascade, unrecorded).
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { auditLog } from '../src/lib/audit.js';
import { validateRoomPayload, roomGeometry } from '../src/modules/floorplans/validation.js';
import { archCanvas, archPoints, archAnnotations, edgeDoor, type ArchLayout } from '../src/modules/floorplans/architectural-layout.js';
import { MICROBIOLOGY_LAYOUT } from '../src/modules/floorplans/microbiology-layout.js';

/** The floors drawn in this style by this script, keyed by AREA name. */
const LAYOUTS: Record<string, ArchLayout> = {
  [MICROBIOLOGY_LAYOUT.area]: MICROBIOLOGY_LAYOUT,
};

const APPLY = process.argv.includes('--apply');
const areaAt = process.argv.indexOf('--area');
const AREA = areaAt >= 0 ? process.argv[areaAt + 1] : undefined;
const SCRIPT = 'scripts/draw-architectural-floor.ts';
const ACTOR = 'superadmin';
const audit = { userId: ACTOR, userRole: 'SUPER_ADMIN', ipAddress: '127.0.0.1', userAgent: SCRIPT, sessionId: null };

const LINK_SELECT = {
  id: true, kind: true, fromEdge: true, offset: true, width: true, door: true, label: true,
  fromRoom: { select: { code: true } }, toRoom: { select: { code: true } },
} as const;
/** "A ↔ B", the same code the link routes audit under. */
const linkCode = (l: { fromRoom: { code: string }; toRoom: { code: string } }) => `${l.fromRoom.code} ↔ ${l.toRoom.code}`;

async function main() {
  const layout = AREA ? LAYOUTS[AREA] : undefined;
  if (!layout) {
    throw new Error(`--area "<name>" is required. Floors this script draws: ${Object.keys(LAYOUTS).map((a) => `"${a}"`).join(', ')}`);
  }
  const REASON = `Floor traced from ${layout.source} by ${SCRIPT}. `
    + 'No e-signature was captured: a script cannot prompt for re-authentication as the HTTP route does.';

  const target = await prisma.floorplan.findFirst({
    where: { name: layout.planName },
    select: { id: true, rooms: { select: { id: true, code: true, label: true, grade: true, meta: true } }, links: { select: LINK_SELECT } },
  });
  if (!target) throw new Error(`"${layout.planName}" not found — it is the plan this floor is drawn on.`);
  const byCode = new Map(target.rooms.map((r) => [r.code.toUpperCase(), r]));

  const codes = layout.rooms.flatMap((r) => (r.instrument ? [r.instrument] : []));
  const instruments = await prisma.instrument.findMany({ where: { code: { in: codes } }, select: { id: true, code: true } });
  const missing = codes.filter((c) => !instruments.some((i) => i.code === c));
  if (missing.length) throw new Error(`instruments not in the registry: ${missing.join(', ')}`);

  // Build and VALIDATE every room before anything is written.
  const specs = layout.rooms.map((r) => {
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
    return { payload, meta, instrumentId: r.instrument ? instruments.find((i) => i.code === r.instrument)!.id : null };
  });

  const canvas = archCanvas(layout.building);
  const ann = archAnnotations(layout.building, layout.annotations);
  const dropped = target.rooms.filter((o) => !layout.rooms.some((r) => r.code.toUpperCase() === o.code.toUpperCase()));
  console.log(`MODE: ${APPLY ? 'APPLY (writes)' : 'DRY RUN (no writes)'}`);
  console.log(`plan "${layout.planName}" ${canvas.width}x${canvas.height}: ${target.rooms.length} rooms replaced by ${specs.length}, ${codes.length} instruments placed, style ${ann.style}`);
  for (const s of specs) {
    console.log(`  ${s.payload.code.padEnd(14)} ${String(s.payload.label).padEnd(26)} grade=${String(s.payload.grade).padEnd(11)} corners=${s.payload.points.length} doors=${s.payload.doors.length}${s.instrumentId ? ' +instrument' : ''}`);
  }
  for (const o of dropped) console.log(`  room ${o.code} — on the plan today, not in the trace: deleted`);
  for (const l of target.links) console.log(`  link ${l.kind} ${linkCode(l)} — deleted (its rooms are replaced)`);
  console.log(`structure: ${ann.columns.length} columns, ${ann.windows.length} windows, ${ann.walls.length} stubs`);
  if (!APPLY) { console.log('\nDry run only. Re-run with --apply to execute.'); await prisma.$disconnect(); return; }

  // 0. Links die with their rooms (FK cascade) WITHOUT an audit row of their
  // own, so each is deleted here first, in the route's own shape.
  for (const l of target.links) {
    await prisma.$transaction(async (tx) => {
      await tx.floorplanRoomLink.delete({ where: { id: l.id } });
      await auditLog({
        ...audit, action: 'FLOORPLAN_LINK_DELETED', targetType: 'floorplan_room_link', targetId: l.id,
        beforeValue: { floorplan: layout.planName, code: linkCode(l), kind: l.kind, fromEdge: l.fromEdge, offset: l.offset, width: l.width, door: l.door, label: l.label },
        reason: REASON, signatureMeaning: `Room link "${linkCode(l)}" deleted — "${layout.planName}" redrawn from ${layout.source}`,
      }, tx);
    });
  }

  // 1. The plan: canvas, structure layer, style.
  await prisma.$transaction(async (tx) => {
    await tx.floorplan.update({
      where: { id: target.id },
      data: { imageWidth: canvas.width, imageHeight: canvas.height, annotations: ann as unknown as Prisma.InputJsonValue, updatedBy: ACTOR },
    });
    await auditLog({
      ...audit, action: 'FLOORPLAN_UPDATED', targetType: 'floorplan', targetId: target.id,
      afterValue: { name: layout.planName, source: layout.source, canvas, style: ann.style, structure: { columns: ann.columns.length, windows: ann.windows.length } },
      reason: REASON, signatureMeaning: `Floor plan "${layout.planName}" redrawn from ${layout.source}`,
    }, tx);
  });
  console.log(`updated plan "${layout.planName}"`);

  // 2. Its old rooms out (their instruments released), the traced rooms in.
  for (const r of target.rooms) {
    await prisma.$transaction(async (tx) => {
      await tx.instrument.updateMany({ where: { roomId: r.id }, data: { roomId: null } });
      await tx.floorplanRoom.delete({ where: { id: r.id } });
      await auditLog({
        ...audit, action: 'FLOORPLAN_ROOM_DELETED', targetType: 'floorplan_room', targetId: r.id,
        beforeValue: { code: r.code, plan: layout.planName }, reason: REASON,
        signatureMeaning: `Room "${r.code}" deleted — "${layout.planName}" redrawn from ${layout.source}`,
      }, tx);
    });
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
        afterValue: { code: p.code, label: p.label, plan: layout.planName, grade: p.grade, corners: p.points.length, doors: p.doors.length, instruments: s.instrumentId ? 1 : 0 },
        reason: REASON,
        signatureMeaning: `Room "${p.code}" (${p.label}) drawn on "${layout.planName}"${s.instrumentId ? ' with its instrument placed in it' : ''}`,
      }, tx);
    });
  }
  console.log(`rooms=${specs.length} instruments placed=${placed}`);
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
