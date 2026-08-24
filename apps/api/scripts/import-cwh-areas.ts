/**
 * Create the CWH spreadsheet's Areas as functional locations under a
 * "CWH Block" BLOCK, and link each instrument to its own Area.
 *
 * The sheet's `Building` column is "CWH Block" for all 100 rows and its `Area`
 * column holds 14 distinct values once trimmed — several arrive with a leading
 * space (" QC", " QC 3"), which would otherwise create near-duplicate areas
 * that look identical in the UI and sort apart.
 *
 * Every create and every link writes its audit row in the SAME transaction as
 * the change, because a functional location is the grouping an instrument's
 * alarms and visibility scope resolve against — a registry change with no
 * attributable record is exactly what §11 forbids. As with the instrument
 * import, the one thing this cannot reproduce is the route's re-authentication
 * prompt; that gap is stated in each audit row's reason rather than hidden.
 *
 * Idempotent: areas are matched by (parent, name), so re-running relinks
 * rather than duplicating.
 *
 * Usage:
 *   npx tsx apps/api/scripts/import-cwh-areas.ts           # dry run
 *   npx tsx apps/api/scripts/import-cwh-areas.ts --apply
 */
import { readFileSync } from 'node:fs';
import { prisma } from '../src/lib/prisma.js';
import { auditLog } from '../src/lib/audit.js';

const APPLY = process.argv.includes('--apply');
const ACTOR = 'superadmin';
const BLOCK_NAME = 'CWH Block';
const SHEET_JSON = '.superpowers/sdd/cwh.json';

const REASON =
  'Areas imported from CWH.xlsx via scripts/import-cwh-areas.ts. No e-signature was captured: '
  + 'a script cannot prompt for re-authentication as the HTTP route does.';

interface SheetRow { [k: string]: string }

/** The XLSX parser leaves XML entities raw; a name shown as "KF &amp; Auto" is wrong. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

const clean = (s: string) => decodeEntities(String(s ?? '')).replace(/\s+/g, ' ').trim();

/**
 * Area names carrying an AHU qualifier — "Module-F(AHU-046)",
 * "Module-F(AHU-046,AHU-047)" — collapse to their base area. Operator decision
 * 2026-08-24: those are one area, not eight. Nothing is lost by it: the FULL
 * spreadsheet value stays on each instrument's `Area` attribute, so which AHU
 * serves a given room is still answerable; only the functional-location tree
 * is simplified.
 */
function normaliseArea(name: string): string {
  const base = name.replace(/\s*\(.*\)\s*$/, '').trim();
  return base || name;
}

async function main() {
  const { rows } = JSON.parse(readFileSync(SHEET_JSON, 'utf8')) as { rows: SheetRow[] };

  const byArea = new Map<string, string[]>();
  for (const r of rows) {
    const area = normaliseArea(clean(r.Area));
    const code = String(r.name ?? '').trim();
    if (!area || !code) continue;
    const list = byArea.get(area);
    if (list) list.push(code); else byArea.set(area, [code]);
  }
  const areaNames = [...byArea.keys()].sort();

  const existingBlock = await prisma.functionalLocation.findFirst({
    where: { name: BLOCK_NAME, type: 'BLOCK' },
    select: { id: true, name: true },
  });
  const otherBlocks = await prisma.functionalLocation.findMany({
    where: { type: 'BLOCK', name: { not: BLOCK_NAME } },
    select: { name: true, _count: { select: { children: true, instruments: true } } },
  });

  console.log(`MODE: ${APPLY ? 'APPLY (writes)' : 'DRY RUN (no writes)'}`);
  console.log(`block:  "${BLOCK_NAME}" ${existingBlock ? '(exists)' : '(will be created)'}`);
  console.log(`areas:  ${areaNames.length}`);
  for (const a of areaNames) console.log(`   ${String(byArea.get(a)!.length).padStart(3)}  ${a}`);
  if (otherBlocks.length) {
    console.log(`\nOTHER BLOCKS left untouched: ${otherBlocks.map((b) => `"${b.name}" (children=${b._count.children}, instruments=${b._count.instruments})`).join(', ')}`);
    console.log('  If one of these is the same place under an older name, merge it yourself — this script will not rename or delete a block.');
  }

  if (!APPLY) {
    console.log('\nDry run only. Re-run with --apply to execute.');
    await prisma.$disconnect();
    return;
  }

  // ── The block ──────────────────────────────────────────────────────────
  let blockId = existingBlock?.id;
  if (!blockId) {
    blockId = await prisma.$transaction(async (tx) => {
      const created = await tx.functionalLocation.create({
        data: { name: BLOCK_NAME, type: 'BLOCK', createdBy: ACTOR, updatedBy: ACTOR },
        select: { id: true },
      });
      await auditLog({
        action: 'FUNCTIONAL_LOCATION_CREATED', targetType: 'FunctionalLocation', targetId: created.id,
        afterValue: { name: BLOCK_NAME, type: 'BLOCK' },
        reason: REASON,
        signatureMeaning: `Functional location block "${BLOCK_NAME}" created from CWH.xlsx`,
        userId: ACTOR, userRole: 'SUPER_ADMIN',
        ipAddress: '127.0.0.1', userAgent: 'scripts/import-cwh-areas.ts', sessionId: null,
      }, tx);
      return created.id;
    });
    console.log(`created block "${BLOCK_NAME}"`);
  }

  // ── The areas, and the instruments under each ──────────────────────────
  let createdAreas = 0, linked = 0, missing: string[] = [];

  for (const area of areaNames) {
    const codes = byArea.get(area)!;

    const existing = await prisma.functionalLocation.findFirst({
      where: { parentId: blockId, name: area },
      select: { id: true },
    });

    const areaId = existing?.id ?? await prisma.$transaction(async (tx) => {
      const created = await tx.functionalLocation.create({
        data: { name: area, type: 'AREA', parentId: blockId, createdBy: ACTOR, updatedBy: ACTOR },
        select: { id: true },
      });
      await auditLog({
        action: 'FUNCTIONAL_LOCATION_CREATED', targetType: 'FunctionalLocation', targetId: created.id,
        afterValue: { name: area, type: 'AREA', parent: BLOCK_NAME },
        reason: REASON,
        signatureMeaning: `Functional location area "${area}" created under "${BLOCK_NAME}" from CWH.xlsx`,
        userId: ACTOR, userRole: 'SUPER_ADMIN',
        ipAddress: '127.0.0.1', userAgent: 'scripts/import-cwh-areas.ts', sessionId: null,
      }, tx);
      return created.id;
    });
    if (!existing) createdAreas++;

    const found = await prisma.instrument.findMany({
      where: { code: { in: codes } },
      select: { id: true, code: true, functionalLocationId: true },
    });
    const foundCodes = new Set(found.map((f) => f.code));
    missing.push(...codes.filter((c) => !foundCodes.has(c)));

    const toLink = found.filter((f) => f.functionalLocationId !== areaId);
    if (toLink.length) {
      await prisma.$transaction(async (tx) => {
        await tx.instrument.updateMany({
          where: { id: { in: toLink.map((t) => t.id) } },
          data: { functionalLocationId: areaId },
        });
        await auditLog({
          action: 'FUNCTIONAL_LOCATION_INSTRUMENTS_CHANGED', targetType: 'FunctionalLocation', targetId: areaId,
          afterValue: { area, added: toLink.map((t) => t.code) },
          reason: REASON,
          signatureMeaning: `${toLink.length} instrument(s) assigned to area "${area}" from CWH.xlsx`,
          userId: ACTOR, userRole: 'SUPER_ADMIN',
          ipAddress: '127.0.0.1', userAgent: 'scripts/import-cwh-areas.ts', sessionId: null,
        }, tx);
      });
      linked += toLink.length;
    }
    console.log(`  ${area.padEnd(28)} ${existing ? 'existing' : 'created '}  linked=${toLink.length}/${codes.length}`);
  }

  // The Module-F merge strands the areas an earlier run created for each AHU
  // qualifier. An AREA with no instruments and no children is dead structure:
  // it clutters every location picker and every scope screen while meaning
  // nothing. Removed here, audited — the AHU value itself survives on each
  // instrument's `Area` attribute, so nothing is actually lost.
  const stranded = await prisma.functionalLocation.findMany({
    where: { parentId: blockId, type: 'AREA', instruments: { none: {} }, children: { none: {} } },
    select: { id: true, name: true },
  });
  for (const dead of stranded) {
    await prisma.$transaction(async (tx) => {
      await tx.functionalLocation.delete({ where: { id: dead.id } });
      await auditLog({
        action: 'FUNCTIONAL_LOCATION_DELETED', targetType: 'FunctionalLocation', targetId: dead.id,
        beforeValue: { name: dead.name, type: 'AREA', parent: BLOCK_NAME },
        reason: REASON + ' Area left empty by the Module-F merge; the AHU qualifier survives on each instrument Area attribute.',
        signatureMeaning: `Empty functional location area "${dead.name}" removed after the Module-F merge`,
        userId: ACTOR, userRole: 'SUPER_ADMIN',
        ipAddress: '127.0.0.1', userAgent: 'scripts/import-cwh-areas.ts', sessionId: null,
      }, tx);
    });
  }
  if (stranded.length) console.log(`removed ${stranded.length} empty area(s): ${stranded.map((s) => s.name).join(', ')}`);

  console.log(`\nareas created: ${createdAreas}   instruments linked: ${linked}`);
  if (missing.length) console.log(`NOT FOUND in the registry (${missing.length}): ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? '…' : ''}`);

  const unassigned = await prisma.instrument.count({ where: { functionalLocationId: null } });
  console.log(`instruments still with no functional location: ${unassigned}`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
