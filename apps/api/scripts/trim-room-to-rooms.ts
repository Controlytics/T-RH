/**
 * Shorten ONE room so it ends where the plan's real rooms end — an audited
 * room update, written the way `draw-cwh-floorplan.ts` writes its rows
 * (Prisma + `auditLog` in one transaction), because the API path needs a
 * login and a login terminates the operator's browser session.
 *
 * Why it exists (2026-09-22, operator: "shaft-e also should end where rooms
 * end"): on the QC plan every real room had been moved up to end at ~58 % of
 * the canvas, but SHAFT-E — a 0.9 %-wide service strip — still ran the full
 * height, and the dashboard's border follows the rooms. This trims its height
 * so its bottom edge sits on the lowest real room's bottom edge. "Real" = a
 * room at least 1.5 % of the plan in both axes, the dashboard's own SLIVER
 * rule, and never the target itself.
 *
 * A polygon room (`points` set) is trimmed by clamping every corner's y to the
 * new bottom; a rectangle by its height. The box is what the dashboard's
 * extent reads, so both end up consistent.
 *
 * Dry run by default; `--apply` writes. Usage (from apps/api):
 *   npx tsx scripts/trim-room-to-rooms.ts --plan "QC" --room SHAFT-E
 *   npx tsx scripts/trim-room-to-rooms.ts --plan "QC" --room SHAFT-E --apply
 */
import 'dotenv/config';
import { prisma } from '../src/lib/prisma.js';
import { auditLog } from '../src/lib/audit.js';

const argv = process.argv.slice(2);
const opt = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const APPLY = argv.includes('--apply');
const PLAN = opt('plan');
const ROOM = opt('room');
const SLIVER = 0.015;
const ACTOR = 'superadmin';
const clean = (n: number) => Math.round(n * 1e9) / 1e9;

async function main() {
  if (!PLAN || !ROOM) { console.error('usage: --plan <name part> --room <code> [--apply]'); process.exit(1); }
  const plans = await prisma.floorplan.findMany({ where: { name: { contains: PLAN } }, select: { id: true, name: true } });
  // "QC" also matches "QC 3" and "QC Microbiology": take the shortest name, and say so.
  plans.sort((a, b) => a.name.length - b.name.length);
  const plan = plans[0];
  if (!plan) { console.error(`no plan matches "${PLAN}"`); process.exit(1); }
  if (plans.length > 1) console.log(`plans matching "${PLAN}": ${plans.map((p) => p.name).join(' | ')} — using "${plan.name}"`);

  const rooms = await prisma.floorplanRoom.findMany({ where: { floorplanId: plan.id } });
  const target = rooms.find((r) => r.code === ROOM);
  if (!target) { console.error(`no room "${ROOM}" on "${plan.name}"`); process.exit(1); }
  const real = rooms.filter((r) => r.id !== target.id && r.w >= SLIVER && r.h >= SLIVER);
  if (!real.length) { console.error('no real rooms to fit to'); process.exit(1); }
  const bottom = clean(Math.max(...real.map((r) => r.y + r.h)));
  const lowest = real.reduce((a, b) => (a.y + a.h >= b.y + b.h ? a : b));

  const before = { x: target.x, y: target.y, w: target.w, h: target.h, points: target.points };
  if (target.y + target.h <= bottom + 1e-9) {
    console.log(`"${target.code}" already ends at ${clean(target.y + target.h)} ≤ rooms' bottom ${bottom} ("${lowest.code}"). Nothing to do.`);
    return;
  }
  const newH = clean(bottom - target.y);
  if (newH < 0.005) { console.error(`"${target.code}" would be ${newH} tall — refusing`); process.exit(1); }
  const points = Array.isArray(target.points)
    ? (target.points as { x: number; y: number }[]).map((p) => ({ x: p.x, y: clean(Math.min(p.y, bottom)) }))
    : null;
  const after = { x: target.x, y: target.y, w: target.w, h: newH, points };

  console.log(`"${plan.name}" / "${target.code}": bottom ${clean(target.y + target.h)} → ${bottom} (the bottom of "${lowest.code}"); h ${target.h} → ${newH}${points ? `; ${points.length} corners clamped` : ''}`);
  if (!APPLY) { console.log('dry run — pass --apply to write.'); return; }

  await prisma.$transaction(async (tx) => {
    await tx.floorplanRoom.update({
      where: { id: target.id },
      data: { h: newH, ...(points ? { points } : {}), updatedBy: ACTOR },
    });
    await auditLog({
      action: 'FLOORPLAN_ROOM_UPDATED', targetType: 'floorplan_room', targetId: target.id,
      beforeValue: { code: target.code, geometry: { x: before.x, y: before.y, w: before.w, h: before.h, corners: Array.isArray(before.points) ? (before.points as unknown[]).length : 4 } },
      afterValue: { code: target.code, geometry: { x: after.x, y: after.y, w: after.w, h: after.h, corners: points ? points.length : 4 } },
      reason: `Trimmed to end where the plan's rooms end (${bottom}, the bottom of "${lowest.code}"); operator, 2026-09-22: "shaft-e also should end where rooms end"`,
      signatureMeaning: `Room "${target.code}" updated`,
      userId: ACTOR, userRole: 'SUPER_ADMIN',
      ipAddress: '127.0.0.1', userAgent: 'scripts/trim-room-to-rooms.ts', sessionId: null,
    }, tx);
  });
  console.log('written, with one FLOORPLAN_ROOM_UPDATED audit row.');
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
