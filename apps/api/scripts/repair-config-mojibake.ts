/**
 * Repair administered text in `system_config` that was double-encoded on the
 * way in — an em dash stored as `â€”`, a curly quote as `â€™`, and so on.
 *
 * Found 2026-09-21 (operator: "in alarm page in middle of the text symbols
 * coming" — the Alarms page printed `Cleared â€” Unacknowledged`). Cause,
 * from the audit trail: the `alarm-limits` row was rewritten on 2026-09-16
 * 14:04 by a Python script (`Python-urllib/3.14`) that read the existing row
 * through Windows' default codepage and sent it back as UTF-8, turning the two
 * em dashes in the status wordings into three characters each. The
 * before-value on that CONFIG_CHANGED row still holds the correct text.
 *
 * What this does: for every string leaf in every `system_config` row, try to
 * reverse that exact fault — map each character back to its Windows-1252 byte
 * and decode the bytes as UTF-8. Only when EVERY character maps, the bytes
 * decode cleanly, and the result differs is the value treated as mojibake.
 * Ordinary text never satisfies all three, and a value that is genuinely a
 * mix is left alone rather than guessed at.
 *
 * Writes go through the app's audit logger as CONFIG_CHANGED on the config
 * key, with the whole row before and after — the same record the dynamic PUT
 * writes — because an administered §11 wording changed, whoever caused it.
 *
 * Usage (from apps/api):
 *   npx tsx scripts/repair-config-mojibake.ts           # dry run: shows every repair
 *   npx tsx scripts/repair-config-mojibake.ts --apply
 */
import { prisma } from '../src/lib/prisma.js';
import { auditLog } from '../src/lib/audit.js';

const APPLY = process.argv.includes('--apply');
const ACTOR_USERNAME = 'superadmin';

/** The 0x80..0x9F block, the only place Windows-1252 and Latin-1 differ. */
const CP1252_HIGH: Record<string, number> = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86,
  '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8A, '‹': 0x8B, 'Œ': 0x8C,
  'Ž': 0x8E, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95,
  '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9A, '›': 0x9B,
  'œ': 0x9C, 'ž': 0x9E, 'Ÿ': 0x9F,
};

/** The original text if `s` is a Windows-1252 misreading of UTF-8, else null. */
export function undoCp1252Mojibake(s: string): string | null {
  // Cheap gate: every UTF-8 multibyte sequence misread as cp1252 starts with a
  // char in 0xC2..0xF4, i.e. Â..ô. No such char, no mojibake.
  if (!/[Â-ô]/.test(s)) return null;
  const bytes: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80 || (cp >= 0xA0 && cp <= 0xFF)) bytes.push(cp);
    else if (CP1252_HIGH[ch] !== undefined) bytes.push(CP1252_HIGH[ch]);
    else return null;
  }
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
  return decoded !== s ? decoded : null;
}

interface Repair { path: string; from: string; to: string }

/** Walk a JSON value; return a repaired copy and the list of changes. */
function repairValue(v: unknown, path: string, out: Repair[]): unknown {
  if (typeof v === 'string') {
    const fixed = undoCp1252Mojibake(v);
    if (fixed !== null) { out.push({ path, from: v, to: fixed }); return fixed; }
    return v;
  }
  if (Array.isArray(v)) return v.map((x, i) => repairValue(x, `${path}[${i}]`, out));
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = repairValue(x, path ? `${path}.${k}` : k, out);
    return o;
  }
  return v;
}

async function main() {
  const rows = await prisma.systemConfig.findMany({ select: { configKey: true, configValue: true } });
  const plan: { key: string; before: unknown; after: unknown; repairs: Repair[] }[] = [];
  for (const r of rows) {
    const repairs: Repair[] = [];
    const after = repairValue(r.configValue, '', repairs);
    if (repairs.length) plan.push({ key: r.configKey, before: r.configValue, after, repairs });
  }

  console.log(`MODE: ${APPLY ? 'APPLY (writes)' : 'DRY RUN (no writes)'}`);
  console.log(`system_config rows scanned: ${rows.length}, rows needing repair: ${plan.length}`);
  for (const p of plan) {
    console.log(`\n${p.key}`);
    for (const r of p.repairs) console.log(`  ${r.path}: ${JSON.stringify(r.from)}  ->  ${JSON.stringify(r.to)}`);
  }
  if (!plan.length) return;
  if (!APPLY) { console.log('\nDry run only. Re-run with --apply to execute.'); return; }

  const actor = await prisma.user.findUnique({
    where: { username: ACTOR_USERNAME },
    select: { id: true, username: true, role: true },
  });
  if (!actor) throw new Error(`user "${ACTOR_USERNAME}" not found — refusing to write audit rows with no principal`);

  for (const p of plan) {
    await prisma.$transaction(async (tx) => {
      await tx.systemConfig.update({ where: { configKey: p.key }, data: { configValue: p.after as object } });
      await auditLog({
        action: 'CONFIG_CHANGED', targetType: 'config', targetId: p.key,
        beforeValue: p.before as object, afterValue: p.after as object,
        reason: `Text encoding repaired by scripts/repair-config-mojibake.ts: ${p.repairs.length} value(s) had been `
          + 'double-encoded (UTF-8 read as Windows-1252) by a client on 2026-09-16 and are restored to the '
          + 'characters originally administered. No e-signature was captured: a script cannot prompt for one.',
        signatureMeaning: `System configuration repaired: ${p.key} (text encoding)`,
        userId: actor.id, userName: actor.username, userRole: actor.role,
        ipAddress: '127.0.0.1', userAgent: 'scripts/repair-config-mojibake.ts',
      }, tx);
    });
    console.log(`repaired ${p.key} (${p.repairs.length} value(s)), audit row written`);
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
