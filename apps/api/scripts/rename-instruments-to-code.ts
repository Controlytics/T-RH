/**
 * Set every instrument's `name` to its `code`.
 *
 * Operator instruction, 2026-09-04: "make all the instruments name should come
 * as client ids for all instruments" — and, asked which value they meant by
 * client id, they chose the instrument CODE (e.g. `CWH/RDU/001-00`), not the
 * gateway-child `token` attribute (e.g. `IOTGW01_163`).
 *
 * ─── WHY THE NAME WAS SOMETHING ELSE ─────────────────────────────────────
 * scripts/import-cwh-instruments.ts named each instrument after the sheet's
 * `Location` column, so `name` was the room ("IT Server Room") and was
 * byte-identical to the `Location` attribute on all 100 CWH instruments — the
 * dashboard printed the same text twice. Nothing is lost by the rename: the
 * room stays in the `Location` attribute, which the dashboard's Location
 * column reads.
 *
 * ─── WHY THIS WRITES AUDIT ROWS ──────────────────────────────────────────
 * Renaming an instrument is a §11 record change; the PUT route writes an
 * INSTRUMENT_UPDATED row with the before/after name, and so does this. Each
 * row is written in the SAME transaction as its rename. What it cannot
 * reproduce is the route's e-signature prompt, and the audit `reason` says so.
 *
 * Idempotent — an instrument whose name already equals its code is skipped,
 * so a second run writes nothing (the gateway IOTGW01 is already in that
 * state).
 *
 * Usage:
 *   npx tsx apps/api/scripts/rename-instruments-to-code.ts           # dry run
 *   npx tsx apps/api/scripts/rename-instruments-to-code.ts --apply
 */
import { prisma } from '../src/lib/prisma.js';
import { auditLog } from '../src/lib/audit.js';

const APPLY = process.argv.includes('--apply');
const ACTOR_USERNAME = 'superadmin';
const REASON =
  'Operator instruction 2026-09-04: every instrument is to be named by its code. '
  + 'Run out of band via scripts/rename-instruments-to-code.ts. No e-signature was captured: '
  + 'the script cannot prompt for re-authentication as the HTTP route does. '
  + 'The previous name (the room) is retained in the Location attribute.';

/**
 * `audit_trail.signature_meaning` is VarChar(255) and a code is free text of
 * any length (routes.ts `codeLabel`); the full code is in afterValue.
 */
function meaning(code: string): string {
  const s = `Instrument "${code}" renamed to its code`;
  return s.length > 255 ? `${s.slice(0, 252)}...` : s;
}

async function main() {
  const actor = await prisma.user.findUnique({
    where: { username: ACTOR_USERNAME },
    select: { id: true, username: true, role: true },
  });
  if (!actor) throw new Error(`user "${ACTOR_USERNAME}" not found — refusing to write audit rows with no principal`);

  const instruments = await prisma.instrument.findMany({
    select: { id: true, code: true, name: true },
    orderBy: { code: 'asc' },
  });
  const plan = instruments.filter((i) => i.name !== i.code);

  console.log(`MODE: ${APPLY ? 'APPLY (writes)' : 'DRY RUN (no writes)'}`);
  console.log(`instruments: ${instruments.length}, to rename: ${plan.length}, already named by code: ${instruments.length - plan.length}`);
  for (const i of plan) console.log(`  ${i.code}  name: "${i.name}"  ->  "${i.code}"`);
  if (!plan.length) { console.log('nothing to rename'); return; }

  if (!APPLY) {
    console.log('\nDry run only. Re-run with --apply to execute.');
    return;
  }

  let renamed = 0;
  for (const i of plan) {
    await prisma.$transaction(async (tx) => {
      await tx.instrument.update({ where: { id: i.id }, data: { name: i.code } });
      await auditLog({
        action: 'INSTRUMENT_UPDATED', targetType: 'Instrument', targetId: i.id,
        beforeValue: { code: i.code, name: i.name },
        afterValue: { code: i.code, name: i.code },
        reason: REASON,
        signatureMeaning: meaning(i.code),
        userId: actor.id, userName: actor.username, userRole: actor.role,
        ipAddress: '127.0.0.1', userAgent: 'scripts/rename-instruments-to-code.ts',
      }, tx);
    });
    renamed++;
  }
  console.log(`\nrenamed ${renamed} instrument(s)`);

  const remaining = await prisma.$queryRaw<{ n: bigint }[]>`select count(*) as n from instruments where name <> code`;
  console.log(`instruments whose name still differs from code: ${Number(remaining[0]?.n ?? 0)}`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
