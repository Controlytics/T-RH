/**
 * Replace the instrument registry with the CWH spreadsheet.
 *
 * Two phases, both audited:
 *   1. DELETE every instrument except the T&RH Sensors gateway `IOTGW01`,
 *      then delete the profiles left empty.
 *   2. CREATE one instrument per row of CWH.xlsx — `name` column becomes the
 *      instrument CODE, every other column becomes an attribute — all in the
 *      T&RH Sensors profile, all linked to `IOTGW01`.
 *
 * ─── WHY THIS WRITES AUDIT ROWS ──────────────────────────────────────────
 * Deleting an instrument and creating one are both §11 record changes. The
 * HTTP routes that normally do this write INSTRUMENT_DELETED / INSTRUMENT_CREATED
 * rows; a script that skipped them would leave the registry changed with no
 * attributable record of who changed it. Each audit row is written in the SAME
 * transaction as its change, so a change cannot land without its record.
 *
 * What it does NOT reproduce: the routes' `enforceReauth` password prompt. A
 * script cannot capture a signature. That is a real gap and it is stated in the
 * audit `reason` of every row this writes, rather than left for someone to
 * discover.
 *
 * ─── OPERATOR DECISIONS RECORDED HERE ────────────────────────────────────
 * The spreadsheet's `token` column spreads these 100 instruments across FOUR
 * gateways (IOTGW01 31, IOTGW03 25, IOTGW04 23, IOTGW08 21). The operator was
 * shown that and chose to link ALL 100 to IOTGW01 on 2026-08-24. So 69 of them
 * are deliberately attributed to a gateway that is not the one their own token
 * names — fine for a demo registry, wrong for live ingest, and the `token`
 * attribute preserves the real value so it can be corrected later.
 *
 * Usage:
 *   npx tsx apps/api/scripts/import-cwh-instruments.ts            # dry run
 *   npx tsx apps/api/scripts/import-cwh-instruments.ts --apply
 */
import { readFileSync } from 'node:fs';
import { prisma } from '../src/lib/prisma.js';
import { auditLog } from '../src/lib/audit.js';

const APPLY = process.argv.includes('--apply');
const ACTOR = process.argv.includes('--actor')
  ? process.argv[process.argv.indexOf('--actor') + 1]
  : 'superadmin';

const KEEP_CODE = 'IOTGW01';
const PROFILE_NAME = 'T&RH Sensors';
const CODE_COLUMN = 'name';
const SHEET_JSON = '.superpowers/sdd/cwh.json';

const REASON =
  'Bulk registry replacement from CWH.xlsx, run out of band via scripts/import-cwh-instruments.ts. '
  + 'No e-signature was captured: the script cannot prompt for re-authentication as the HTTP route does.';

interface SheetRow { [k: string]: string }

function loadRows(): { headers: string[]; rows: SheetRow[] } {
  const parsed = JSON.parse(readFileSync(SHEET_JSON, 'utf8')) as { headers: string[]; rows: SheetRow[] };
  if (!parsed.rows?.length) throw new Error(`${SHEET_JSON} has no rows — re-run the parser first`);
  return parsed;
}

async function main() {
  const { headers, rows } = loadRows();
  const attrColumns = headers.filter((h) => h && h !== CODE_COLUMN);

  const keep = await prisma.instrument.findFirst({
    where: { code: KEEP_CODE },
    select: { id: true, code: true, profileId: true, profile: { select: { name: true } } },
  });
  if (!keep) throw new Error(`Gateway ${KEEP_CODE} not found — refusing to wipe a registry without the survivor present`);
  if (keep.profile?.name !== PROFILE_NAME) {
    throw new Error(`${KEEP_CODE} is in profile "${keep.profile?.name}", expected "${PROFILE_NAME}" — check you are pointed at the right gateway`);
  }

  const doomed = await prisma.instrument.findMany({
    where: { id: { not: keep.id } },
    select: { id: true, code: true, name: true, profileId: true },
    orderBy: { code: 'asc' },
  });

  const dupes = rows.filter((r) => !r[CODE_COLUMN]?.trim());
  if (dupes.length) throw new Error(`${dupes.length} sheet rows have an empty "${CODE_COLUMN}" — cannot use as instrument code`);
  const codes = rows.map((r) => r[CODE_COLUMN].trim());
  const dupeCodes = codes.filter((c, i) => codes.indexOf(c) !== i);
  if (dupeCodes.length) throw new Error(`duplicate codes in the sheet: ${[...new Set(dupeCodes)].join(', ')}`);

  const clash = await prisma.instrument.findMany({ where: { code: { in: codes } }, select: { code: true } });
  const clashing = clash.filter((c) => c.code !== keep.code);

  console.log(`MODE: ${APPLY ? 'APPLY (writes)' : 'DRY RUN (no writes)'}`);
  console.log(`keep:        ${keep.code} (profile "${keep.profile?.name}")`);
  console.log(`delete:      ${doomed.length} instruments`);
  console.log(`create:      ${rows.length} instruments in "${PROFILE_NAME}", all linked to ${keep.code}`);
  console.log(`attributes:  ${attrColumns.length} per instrument (${attrColumns.slice(0, 5).join(', ')}…)`);
  console.log(`code column: "${CODE_COLUMN}" -> e.g. ${codes[0]}, ${codes[1]}, … ${codes[codes.length - 1]}`);
  if (clashing.length) console.log(`NOTE: ${clashing.length} sheet codes already exist and will be deleted first, then recreated`);

  if (!APPLY) {
    console.log('\nDry run only. Re-run with --apply to execute.');
    await prisma.$disconnect();
    return;
  }

  // ── Phase 1: delete ────────────────────────────────────────────────────
  let deleted = 0;
  for (const inst of doomed) {
    await prisma.$transaction(async (tx) => {
      // Telemetry lives in a partitioned raw table with no cascading FK to
      // Instrument, so it has to go explicitly or it is orphaned by id.
      await tx.$executeRaw`DELETE FROM instrument_telemetry_history WHERE instrument_id = ${inst.id}`;

      // `alarms_instrument_id_fkey` is RESTRICT, not CASCADE — a deliberate
      // guard so an instrument cannot be deleted out from under its alarm
      // history. Removing them is destructive and is only done here because the
      // operator was shown the count (6) and approved it for this dev registry
      // replacement. Each removal is counted into the instrument's own audit
      // row rather than vanishing silently.
      //
      // NOTE: `DELETE /api/instruments/:id` has the SAME gap — it does not
      // clear alarms either, so deleting an alarmed instrument through the UI
      // fails with a 500 rather than a explained 409. Reported separately.
      const alarmCount = await tx.alarm.count({ where: { instrumentId: inst.id } });
      if (alarmCount) await tx.alarm.deleteMany({ where: { instrumentId: inst.id } });
      // Alarm RULES were removed 2026-08-31 (migration 20260831200000); there
      // is no `alarmRule` delegate any more, so nothing to clear here.

      await tx.instrument.delete({ where: { id: inst.id } });
      await auditLog({
        action: 'INSTRUMENT_DELETED', targetType: 'Instrument', targetId: inst.id,
        beforeValue: { code: inst.code, name: inst.name, alarmsRemoved: alarmCount },
        reason: REASON,
        signatureMeaning: `Instrument "${inst.code}" deleted in the CWH registry replacement`,
        userId: ACTOR, userRole: 'SUPER_ADMIN',
        ipAddress: '127.0.0.1', userAgent: 'scripts/import-cwh-instruments.ts',
      }, tx);
    });
    deleted++;
  }
  console.log(`deleted ${deleted} instruments`);

  // ── Phase 2: empty profiles ────────────────────────────────────────────
  const empties = await prisma.instrumentProfile.findMany({
    where: { id: { not: keep.profileId }, instruments: { none: {} } },
    select: { id: true, name: true },
  });
  for (const pr of empties) {
    await prisma.$transaction(async (tx) => {
      await tx.instrumentProfile.delete({ where: { id: pr.id } });
      await auditLog({
        action: 'INSTRUMENT_PROFILE_DELETED', targetType: 'InstrumentProfile', targetId: pr.id,
        beforeValue: { name: pr.name },
        reason: REASON,
        signatureMeaning: `Instrument profile "${pr.name}" deleted — left empty by the CWH registry replacement`,
        userId: ACTOR, userRole: 'SUPER_ADMIN',
        ipAddress: '127.0.0.1', userAgent: 'scripts/import-cwh-instruments.ts',
      }, tx);
    });
  }
  console.log(`deleted ${empties.length} now-empty profile(s): ${empties.map((e) => e.name).join(', ') || 'none'}`);

  // ── Phase 3: create ────────────────────────────────────────────────────
  let created = 0;
  for (const row of rows) {
    const code = row[CODE_COLUMN].trim();
    const attributes = attrColumns
      .map((k) => ({ key: k, value: String(row[k] ?? '').trim() }))
      .filter((a) => a.value !== '');

    await prisma.$transaction(async (tx) => {
      const inst = await tx.instrument.create({
        data: {
          code,
          // `name` is required. The sheet's "name" column is the CODE per the
          // operator's instruction, and on 2026-09-04 the operator asked that
          // every instrument be NAMED by its code too (scripts/
          // rename-instruments-to-code.ts applied that to the live registry).
          // Until then this read the Location column, which left `name`
          // byte-identical to the Location attribute; the room is still kept
          // as that attribute, so nothing is lost.
          name: code,
          profileId: keep.profileId,
          gatewayId: keep.id,
          isGateway: false,
          isActive: true,
          createdBy: ACTOR,
          attributes: { create: attributes },
        },
        select: { id: true },
      });
      await auditLog({
        action: 'INSTRUMENT_CREATED', targetType: 'Instrument', targetId: inst.id,
        afterValue: { code, profile: PROFILE_NAME, gateway: keep.code, attributeCount: attributes.length },
        reason: REASON,
        signatureMeaning: `Instrument "${code}" created from CWH.xlsx under gateway "${keep.code}"`,
        userId: ACTOR, userRole: 'SUPER_ADMIN',
        ipAddress: '127.0.0.1', userAgent: 'scripts/import-cwh-instruments.ts',
      }, tx);
    });
    created++;
  }
  console.log(`created ${created} instruments`);

  const finalCount = await prisma.instrument.count();
  const attrCount = await prisma.instrumentAttribute.count();
  const children = await prisma.instrument.count({ where: { gatewayId: keep.id } });
  console.log(`\nregistry now: ${finalCount} instruments, ${attrCount} attributes, ${children} linked to ${keep.code}`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
