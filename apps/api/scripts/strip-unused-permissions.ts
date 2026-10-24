/**
 * Remove from every role the permissions the Permissions tab can no longer
 * show or revoke, and record each change.
 *
 * Operator, 2026-10-24: "update all the permissions properly, i think some are
 * not updated in the permissions". Shown the toggles that could never take
 * effect — Dashboards Create / Manage / Assign (they gate only the parked
 * `/api/dashboards` module, which no screen calls), Delete Users (the route is
 * SUPER_ADMIN only), Update Field Labels (its screen is SUPER_ADMIN only) —
 * they chose to take them off the tab AND strip the permissions from roles.
 * The same applies to the four permissions no toggle ever offered
 * (NOTIFICATION_CREATE / _UPDATE / _MANAGE, BACKUP_MANAGE): a role holding one
 * carries a capability the tab can neither show nor take away. Left in place,
 * ADMIN's DASHBOARD_MANAGE would keep "View Dashboard" ON for good, because
 * the server reads X_MANAGE as X_VIEW (`hasEffectivePermission`).
 *
 * Capability a screen actually offered is KEPT, written as the permission the
 * tab does show: BACKUP_MANAGE → BACKUP_EXPORT (the Backup page let it
 * download), DASHBOARD_MANAGE → DASHBOARD_VIEW and NOTIFICATION_MANAGE →
 * NOTIFICATION_VIEW (both opened their page). NOTIFICATION_MANAGE is NOT
 * turned into NOTIFICATION_DELETE: M4/M5 (2026-06-30) made deleting
 * notifications SUPER_ADMIN-only for ADMIN, and only the MANAGE fallback had
 * kept it possible through the API — no screen offered it.
 *
 * SUPER_ADMIN is skipped: it bypasses every check, so its array is not read.
 *
 * One transaction for every role and its ROLE_UPDATED row — all or nothing.
 * No e-signature is captured (a script cannot prompt for one); the reason says
 * so. Sessions are not ended: nothing a user could see is withdrawn.
 *
 * Usage (from apps/api, so `../src` and the .env resolve):
 *   npx tsx scripts/strip-unused-permissions.ts           # dry run: no writes
 *   npx tsx scripts/strip-unused-permissions.ts --apply
 */
import { prisma } from '../src/lib/prisma.js';
import { auditLog } from '../src/lib/audit.js';
import { planUnusedPermissionStrip } from '../src/modules/roles/unused-permissions.js';

const APPLY = process.argv.includes('--apply');
const ACTOR_USERNAME = 'superadmin';

const REASON =
  'Operator instruction 2026-10-24 ("update all the permissions properly"): permissions the Permissions tab '
  + 'can no longer show or revoke were removed by scripts/strip-unused-permissions.ts; capability a screen '
  + 'offered was kept as the permission the tab shows (BACKUP_MANAGE -> BACKUP_EXPORT, DASHBOARD_MANAGE -> '
  + 'DASHBOARD_VIEW, NOTIFICATION_MANAGE -> NOTIFICATION_VIEW). No e-signature was captured: the script '
  + 'cannot prompt for re-authentication as a route would.';

async function main() {
  const actor = await prisma.user.findUnique({
    where: { username: ACTOR_USERNAME },
    select: { username: true, role: true },
  });
  if (!actor) throw new Error(`user "${ACTOR_USERNAME}" not found — refusing to write an audit row with no principal`);

  const roles = await prisma.role.findMany({
    where: { name: { not: 'SUPER_ADMIN' } },
    select: { name: true, permissions: true },
    orderBy: { name: 'asc' },
  });
  const plans = roles
    .map((r) => ({ name: r.name, before: (r.permissions as string[]) ?? [], ...planUnusedPermissionStrip((r.permissions as string[]) ?? []) }))
    .filter((p) => p.removed.length > 0);

  console.log(`MODE: ${APPLY ? 'APPLY (writes)' : 'DRY RUN (no writes)'}`);
  for (const p of plans) {
    console.log(`  ${p.name}: remove [${p.removed.join(', ')}]${p.added.length ? `  add [${p.added.join(', ')}]` : ''}`);
  }
  if (plans.length === 0) { console.log('nothing to strip'); return; }
  if (!APPLY) { console.log('\nDry run only. Re-run with --apply to execute.'); return; }

  await prisma.$transaction(async (tx) => {
    for (const p of plans) {
      // Re-read inside the transaction: refuse rather than overwrite a change
      // made between the plan and the write.
      const now = await tx.role.findUniqueOrThrow({ where: { name: p.name }, select: { permissions: true } });
      if (JSON.stringify(now.permissions) !== JSON.stringify(p.before)) {
        throw new Error(`${p.name}'s permissions changed during the run; rolled back — re-run`);
      }
      await tx.role.update({ where: { name: p.name }, data: { permissions: p.after } });
      await auditLog({
        action: 'ROLE_UPDATED', targetType: 'role', targetId: p.name,
        beforeValue: { permissions: p.before },
        afterValue: { permissions: p.after, removed: p.removed, added: p.added },
        reason: REASON,
        signatureMeaning: `Unused permissions removed from role ${p.name} (${p.removed.length} removed, ${p.added.length} kept as shown)`,
        userId: actor.username, userName: actor.username, userRole: actor.role,
        ipAddress: '127.0.0.1', userAgent: 'scripts/strip-unused-permissions.ts',
      }, tx);
    }
  });
  console.log(`\nDone: ${plans.length} role(s) updated, one ROLE_UPDATED audit row each. The API re-reads role permissions within 5 s.`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
