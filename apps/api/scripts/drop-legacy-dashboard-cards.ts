// ONE-SHOT (ran 2026-08-28): deleted `system_config['dashboard-cards']` after the panel-access migration; the row no longer exists — do not re-run.
/**
 * Delete the retired `system_config['dashboard-cards']` row.
 *
 * Run ONLY after `verify-panel-migration.ts` reports VERIFIED — the carry-over is
 * the reason this row can go, and docs/CONTRIBUTING.md's pre-deletion rule exists
 * because a bulk delete in this repo was reverted twice. The final value is
 * printed before the delete so it survives in the session log even though the row
 * does not.
 */
import { prisma } from '../src/lib/prisma.js';

async function main() {
  const row = await prisma.systemConfig.findUnique({ where: { configKey: 'dashboard-cards' } });
  if (!row) {
    console.log('already gone — nothing to delete');
    await prisma.$disconnect();
    return;
  }
  console.log('final value was:', JSON.stringify(row.configValue));
  await prisma.systemConfig.delete({ where: { configKey: 'dashboard-cards' } });
  console.log('deleted 1 row from system_config');
  await prisma.$disconnect();
}

main();
