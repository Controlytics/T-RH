/**
 * Repair XML entities left raw by the CWH import.
 *
 * `CWH.xlsx` is a zip of XML and its shared-strings table stores `&` as
 * `&amp;`. The first import read those strings without unescaping, so seven
 * instruments carry names and attribute values like
 * "KF &amp; Auto titrator Room" — visibly wrong wherever they are displayed,
 * and wrong in any report printed from them.
 *
 * This is a correction of a defect introduced by scripts/import-cwh-instruments.ts,
 * not an operator edit, and it says so in the audit reason: a §11 reader must be
 * able to tell a data repair from someone changing their mind about a value.
 *
 * Idempotent — decoding an already-decoded string is a no-op.
 *
 * Usage:
 *   npx tsx apps/api/scripts/fix-cwh-entities.ts           # dry run
 *   npx tsx apps/api/scripts/fix-cwh-entities.ts --apply
 */
import { prisma } from '../src/lib/prisma.js';
import { auditLog } from '../src/lib/audit.js';

const APPLY = process.argv.includes('--apply');
const ACTOR = 'superadmin';

const REASON =
  'Data repair: XML entities (&amp; etc.) were stored raw by the CWH.xlsx import because the '
  + 'parser did not unescape the spreadsheet shared-strings table. Values are being decoded to '
  + 'what the spreadsheet actually says. This corrects an import defect; no operator changed a value.';

function decode(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'");
}
const needsFix = (s: string | null | undefined) => typeof s === 'string' && decode(s) !== s;

async function main() {
  const instruments = await prisma.instrument.findMany({
    select: { id: true, code: true, name: true, attributes: { select: { id: true, key: true, value: true } } },
    orderBy: { code: 'asc' },
  });

  const plan = instruments
    .map((i) => ({
      i,
      nameFix: needsFix(i.name) ? decode(i.name) : null,
      attrFixes: i.attributes.filter((a) => needsFix(a.value) || needsFix(a.key)),
    }))
    .filter((p) => p.nameFix || p.attrFixes.length);

  console.log(`MODE: ${APPLY ? 'APPLY (writes)' : 'DRY RUN (no writes)'}`);
  console.log(`instruments needing repair: ${plan.length}`);
  for (const p of plan) {
    if (p.nameFix) console.log(`  ${p.i.code}  name: "${p.i.name}"  ->  "${p.nameFix}"`);
    for (const a of p.attrFixes) {
      console.log(`  ${p.i.code}  ${a.key}: "${a.value}"  ->  "${decode(a.value)}"`);
    }
  }
  if (!plan.length) { console.log('nothing to repair'); await prisma.$disconnect(); return; }

  if (!APPLY) {
    console.log('\nDry run only. Re-run with --apply to execute.');
    await prisma.$disconnect();
    return;
  }

  let fixed = 0;
  for (const p of plan) {
    await prisma.$transaction(async (tx) => {
      const before = { name: p.i.name, attributes: p.attrFixes.map((a) => ({ key: a.key, value: a.value })) };
      if (p.nameFix) await tx.instrument.update({ where: { id: p.i.id }, data: { name: p.nameFix } });
      for (const a of p.attrFixes) {
        await tx.instrumentAttribute.update({
          where: { id: a.id },
          data: { key: decode(a.key), value: decode(a.value) },
        });
      }
      await auditLog({
        action: 'INSTRUMENT_UPDATED', targetType: 'Instrument', targetId: p.i.id,
        beforeValue: before,
        afterValue: {
          name: p.nameFix ?? p.i.name,
          attributes: p.attrFixes.map((a) => ({ key: decode(a.key), value: decode(a.value) })),
        },
        reason: REASON,
        signatureMeaning: `Instrument "${p.i.code}" — XML entities decoded in ${p.attrFixes.length} attribute(s)${p.nameFix ? ' and the name' : ''}`,
        userId: ACTOR, userRole: 'SUPER_ADMIN',
        ipAddress: '127.0.0.1', userAgent: 'scripts/fix-cwh-entities.ts', sessionId: null,
      }, tx);
    });
    fixed++;
  }
  console.log(`\nrepaired ${fixed} instrument(s)`);

  const remaining = (await prisma.instrumentAttribute.count({ where: { value: { contains: '&amp;' } } }))
    + (await prisma.instrument.count({ where: { name: { contains: '&amp;' } } }));
  console.log(`rows still containing "&amp;": ${remaining}`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
