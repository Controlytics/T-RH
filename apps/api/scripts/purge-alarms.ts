/**
 * Delete EVERY alarm record and EVERY alarm webhook delivery receipt, once,
 * and record that it happened.
 *
 * Operator, 2026-09-21: "once remove all the alarms data". Asked which
 * database and whether to record the purge, they chose the LOCAL database
 * only and ONE hash-chained audit row (`ALARMS_PURGED`).
 *
 * Why a script and not a route: nothing in the product deletes an alarm — an
 * alarm is a §11 record. The one deletion this system has ever needed is this
 * whole-table purge of pre-customer data, and a route for it would be a
 * standing invitation. Like `rename-instruments-to-code.ts`, it runs out of
 * band, writes its audit row through the app's own logger (so the chain stays
 * intact — a raw INSERT into audit_trail would break it), and captures no
 * e-signature because a script cannot prompt for one; the reason says so.
 *
 * Order matters: `alarm_webhook_deliveries.alarm_id` is ON DELETE RESTRICT (a
 * delivery is the evidence of what the annunciator did), so the receipts go
 * first, inside the same transaction as the alarms and the audit row — all or
 * nothing.
 *
 * WHAT HAPPENS NEXT, stated here because it looks like the purge failed: the
 * evaluator runs on every reading and every minute, and it judges the plant
 * as it IS. A silent instrument is re-raised as an inactivity alarm and a
 * reading outside its bound as a limit alarm within a minute — with their
 * notifications and webhook fires. The purge removes the HISTORY; it does not
 * change what the plant is doing.
 *
 * Usage (from apps/api, so `../src` and the .env resolve):
 *   npx tsx scripts/purge-alarms.ts           # dry run: counts only, no writes
 *   npx tsx scripts/purge-alarms.ts --apply
 */
import { prisma } from '../src/lib/prisma.js';
import { auditLog } from '../src/lib/audit.js';

const APPLY = process.argv.includes('--apply');
const ACTOR_USERNAME = 'superadmin';
const REASON =
  'Operator instruction 2026-09-21: "once remove all the alarms data". Every alarm record and every '
  + 'alarm webhook delivery receipt deleted in one transaction by scripts/purge-alarms.ts. No '
  + 'e-signature was captured: the script cannot prompt for re-authentication as a route would. '
  + 'The evaluator continues to judge the live plant, so alarms reflecting its current state are '
  + 'raised again on the next pass.';

async function main() {
  const actor = await prisma.user.findUnique({
    where: { username: ACTOR_USERNAME },
    select: { id: true, username: true, role: true },
  });
  if (!actor) throw new Error(`user "${ACTOR_USERNAME}" not found — refusing to write an audit row with no principal`);

  const alarms = await prisma.alarm.count();
  const deliveries = await prisma.alarmWebhookDelivery.count();
  const byStateSource = await prisma.alarm.groupBy({
    by: ['source', 'state'],
    _count: { _all: true },
    orderBy: [{ source: 'asc' }, { state: 'asc' }],
  });
  const acknowledged = await prisma.alarm.count({ where: { acknowledgedAt: { not: null } } });
  const oldest = await prisma.alarm.findFirst({ orderBy: { raisedAt: 'asc' }, select: { raisedAt: true } });
  const newest = await prisma.alarm.findFirst({ orderBy: { raisedAt: 'desc' }, select: { raisedAt: true } });

  console.log(`MODE: ${APPLY ? 'APPLY (writes)' : 'DRY RUN (no writes)'}`);
  console.log(`alarms: ${alarms} (acknowledged: ${acknowledged}), webhook deliveries: ${deliveries}`);
  for (const g of byStateSource) console.log(`  ${g.source} ${g.state}: ${g._count._all}`);
  if (oldest && newest) console.log(`  raised between ${oldest.raisedAt.toISOString()} and ${newest.raisedAt.toISOString()}`);
  if (alarms === 0 && deliveries === 0) { console.log('nothing to purge'); return; }

  if (!APPLY) {
    console.log('\nDry run only. Re-run with --apply to execute.');
    return;
  }

  const summary = {
    alarms,
    acknowledgedAlarms: acknowledged,
    webhookDeliveries: deliveries,
    byStateSource: byStateSource.map((g) => ({ source: g.source, state: g.state, count: g._count._all })),
    oldestRaisedAt: oldest?.raisedAt ?? null,
    newestRaisedAt: newest?.raisedAt ?? null,
  };

  await prisma.$transaction(async (tx) => {
    const d = await tx.alarmWebhookDelivery.deleteMany({});
    const a = await tx.alarm.deleteMany({});
    if (d.count !== deliveries || a.count !== alarms) {
      // A row landed between the count and the delete. Roll back rather than
      // record numbers that are not what was deleted.
      throw new Error(`counts moved during the purge (deliveries ${deliveries} -> ${d.count}, alarms ${alarms} -> ${a.count}); rolled back — re-run`);
    }
    await auditLog({
      action: 'ALARMS_PURGED', targetType: 'Alarm', targetId: 'ALL',
      beforeValue: summary,
      afterValue: { alarms: 0, webhookDeliveries: 0 },
      reason: REASON,
      signatureMeaning: `All ${alarms} alarm records and ${deliveries} webhook delivery receipts purged`,
      userId: actor.id, userName: actor.username, userRole: actor.role,
      ipAddress: '127.0.0.1', userAgent: 'scripts/purge-alarms.ts',
    }, tx);
  });

  const left = await prisma.alarm.count();
  const leftD = await prisma.alarmWebhookDelivery.count();
  console.log(`\npurged. alarms remaining: ${left}, webhook deliveries remaining: ${leftD}`);
  console.log('One ALARMS_PURGED audit row written. Expect the evaluator to re-raise alarms for the plant\'s CURRENT state within a minute.');
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
