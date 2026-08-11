/**
 * Move recorded temperature/humidity LIMIT values off instruments and onto the
 * rooms they sit in, then delete the migrated attribute rows — each with an
 * audit entry naming the key and the value removed.
 *
 * Why a script and not the migration: deleting an attribute row is a 21 CFR §11
 * record change and must carry an attributable audit entry. The audit trail is
 * a hash chain computed in application code, so raw SQL in a migration cannot
 * write one. Migration 20260811130000 therefore edits only the registration
 * PROMPTS; this script is the audited data step.
 *
 * SAFE BY DEFAULT — a bare run reports and changes nothing. Pass --apply to write.
 *
 *   npx tsx scripts/retire-limit-attributes.ts            # dry run
 *   npx tsx scripts/retire-limit-attributes.ts --apply    # audited migrate + delete
 *
 * NOTHING IS DELETED THAT COULD NOT BE MOVED. A value survives when its
 * instrument is unplaced, when the text is not a clean number, or when two
 * instruments in the same room disagree — silently picking one would invent a
 * specification nobody wrote. Those are listed at the end for manual handling.
 *
 * Idempotent: re-running after a successful apply finds nothing to do.
 */
import { prisma } from '../apps/api/src/lib/prisma.js';
import { auditLog } from '../apps/api/src/lib/audit.js';

const RETIRED_KEYS = [
  'Low Temperature Limit',
  'High Temperature Limit',
  'Low Humidity Limit',
  'High Humidity Limit',
] as const;

/** Which room column each retired key becomes. */
const COLUMN_FOR: Record<string, 'tempMin' | 'tempMax' | 'rhMin' | 'rhMax'> = {
  'Low Temperature Limit': 'tempMin',
  'High Temperature Limit': 'tempMax',
  'Low Humidity Limit': 'rhMin',
  'High Humidity Limit': 'rhMax',
};

/** Free text in, number or null out. `"25 C"`, `"2 2"` and `""` are all null. */
function parseLimit(raw: string): number | null {
  if (!/^\s*-?\d+(\.\d+)?\s*$/.test(raw)) return null;
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : null;
}

interface Skipped { instrument: string; key: string; value: string; reason: string }

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const actor = process.env.RETIRE_ACTOR ?? 'superadmin';

  const rows = await prisma.instrumentAttribute.findMany({
    where: { key: { in: [...RETIRED_KEYS] } },
    include: {
      instrument: {
        select: { id: true, code: true, roomId: true, room: { select: { id: true, code: true } } },
      },
    },
    orderBy: [{ key: 'asc' }],
  });

  console.log(`${rows.length} limit attribute row(s) found.\n`);
  if (rows.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  const skipped: Skipped[] = [];
  // roomId -> column -> the agreed value, or CONFLICT
  const proposals = new Map<string, Map<string, number | 'CONFLICT'>>();
  const movable: typeof rows = [];

  for (const row of rows) {
    const inst = row.instrument;
    const value = parseLimit(row.value);

    if (!inst.roomId || !inst.room) {
      skipped.push({ instrument: inst.code, key: row.key, value: row.value, reason: 'instrument is not placed in any room' });
      continue;
    }
    if (value === null) {
      skipped.push({ instrument: inst.code, key: row.key, value: row.value, reason: 'value is not a plain number' });
      continue;
    }

    const col = COLUMN_FOR[row.key];
    let forRoom = proposals.get(inst.roomId);
    if (!forRoom) { forRoom = new Map(); proposals.set(inst.roomId, forRoom); }

    const existing = forRoom.get(col);
    if (existing === undefined) forRoom.set(col, value);
    else if (existing !== 'CONFLICT' && existing !== value) forRoom.set(col, 'CONFLICT');

    movable.push(row);
  }

  // Drop anything whose room/column ended up contested.
  const applicable = movable.filter((row) => {
    const col = COLUMN_FOR[row.key];
    const decided = proposals.get(row.instrument.roomId!)?.get(col);
    if (decided === 'CONFLICT') {
      skipped.push({
        instrument: row.instrument.code, key: row.key, value: row.value,
        reason: `two instruments in ${row.instrument.room!.code} give different values for this limit`,
      });
      return false;
    }
    return true;
  });

  console.log(`${applicable.length} row(s) can move onto a room.`);
  console.log(`${skipped.length} row(s) will be LEFT IN PLACE for manual review.\n`);

  for (const row of applicable) {
    console.log(`  ${row.instrument.code}  ${row.key} = ${row.value}  →  room ${row.instrument.room!.code}.${COLUMN_FOR[row.key]}`);
  }
  if (skipped.length > 0) {
    console.log('\nLeft in place:');
    for (const s of skipped) console.log(`  ${s.instrument}  ${s.key} = "${s.value}"  — ${s.reason}`);
  }

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to write these changes.');
    return;
  }

  const user = await prisma.user.findUnique({ where: { username: actor }, select: { username: true, role: true } });
  if (!user) {
    throw new Error(`Audit actor "${actor}" not found. Set RETIRE_ACTOR to an existing username.`);
  }

  console.log('\nApplying…');
  for (const row of applicable) {
    const col = COLUMN_FOR[row.key];
    const value = parseLimit(row.value)!;
    const room = row.instrument.room!;

    await prisma.$transaction(async (tx) => {
      // COALESCE semantics: never overwrite a limit an operator has already set
      // on the room by hand — the room is the newer, deliberate answer.
      const current = await tx.floorplanRoom.findUnique({ where: { id: room.id }, select: { [col]: true } as never });
      const existing = (current as unknown as Record<string, number | null>)?.[col] ?? null;
      if (existing === null) {
        await tx.floorplanRoom.update({ where: { id: room.id }, data: { [col]: value } });
      }
      await tx.instrumentAttribute.delete({ where: { id: row.id } });
    });

    await auditLog({
      userId: user.username,
      userRole: user.role,
      action: 'INSTRUMENT_ATTRIBUTE_REMOVED',
      targetType: 'instrument_attribute',
      targetId: row.id,
      beforeValue: { instrument: row.instrument.code, key: row.key, value: row.value },
      afterValue: { movedTo: { room: room.code, field: col, value } },
      reason: 'Retired — spec limits moved to the room. See docs/superpowers/specs/2026-08-11-instrument-dashboard-floorplan-design.md §3.',
      signatureMeaning: `Limit attribute "${row.key}" moved from instrument ${row.instrument.code} to room ${room.code}`,
    });

    console.log(`  moved + audited: ${row.instrument.code} ${row.key}`);
  }

  console.log(`\nDone. ${applicable.length} moved, ${skipped.length} left in place.`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
