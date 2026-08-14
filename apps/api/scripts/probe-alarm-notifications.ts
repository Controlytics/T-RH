/**
 * Proves the C4 wiring against the REAL database and the REAL dispatcher.
 *
 * The thing worth proving is that the generated Prisma client accepts the new enum
 * values: the client validates enums, so a rule targeting ALARM_RAISED is rejected
 * outright by a client generated before the migration — and the failure looks like a
 * broken feature, not a stale build artefact.
 *
 * Not a test file: it writes to live tables, so cleanup is unconditional.
 */
import { prisma } from '../src/lib/prisma.js';
import { alarmNotificationJob } from '../src/modules/alarms/notify.js';
import { notificationTask } from '../src/workers/notification.worker.js';

const logger = { info: (m: string) => console.log(`    worker: ${m}`), error: console.error };

async function main() {
  let ruleId: string | null = null;
  try {
    // 1. The client must accept the new enum values at all.
    const rule = await prisma.notificationRule.create({
      data: {
        name: '__probe__ alarm raised',
        eventType: 'ALARM_RAISED',
        eventTypes: ['ALARM_RAISED', 'ALARM_CLEARED'],
        inAppEnabled: true,
        emailEnabled: false,
        isActive: true,
        createdBy: 'probe',
      },
    });
    ruleId = rule.id;
    console.log(`\n  rule created with eventTypes ${JSON.stringify(rule.eventTypes)} -> the client accepts the new enum values`);

    // 2. The rule must be FOUND by the same `has` query the dispatcher runs.
    const matched = await prisma.notificationRule.findMany({
      where: { isActive: true, eventTypes: { has: 'ALARM_RAISED' } },
      select: { id: true, name: true },
    });
    console.log(`  rules matching ALARM_RAISED: ${matched.length} (must include the probe rule: ${matched.some((r) => r.id === ruleId)})`);

    // 3. The whole handler path, on a payload shaped exactly as the evaluator emits.
    const job = alarmNotificationJob('raised', {
      alarmId: 'probe-alarm',
      instrumentId: 'probe-instrument',
      instrumentCode: 'PROBE-I/1',
      instrumentName: 'Probe probe',
      metric: 'TEMPERATURE',
      severity: 'MAJOR',
      ruleName: 'probe rule',
      condition: 'temperature above 25',
      triggeredValue: 27.4,
      raisedAt: new Date(),
    });
    console.log(`\n  payload: ${JSON.stringify(job.variables)}`);
    console.log('  running the notification task handler on it...');
    await notificationTask(job as never, { logger } as never, {} as never);
    console.log('  handler completed without throwing');

    // 4. And the cleared variant, which carries the duration.
    const cleared = alarmNotificationJob('cleared', {
      alarmId: 'probe-alarm', instrumentId: 'probe-instrument', instrumentCode: 'PROBE-I/1',
      metric: 'TEMPERATURE', severity: 'MAJOR', ruleName: 'probe rule',
      condition: 'temperature above 25', triggeredValue: 24,
      raisedAt: new Date(Date.now() - 95 * 60 * 1000), clearedAt: new Date(),
    });
    console.log(`\n  cleared duration: ${cleared.variables.duration} (expect "1 h 35 min")`);
    await notificationTask(cleared as never, { logger } as never, {} as never);
    console.log('  handler completed without throwing');
  } finally {
    if (ruleId) {
      await prisma.notificationRuleRecipient.deleteMany({ where: { ruleId } });
      await prisma.notificationRule.delete({ where: { id: ruleId } });
      console.log('\n  cleaned up: probe rule deleted');
    }
    await prisma.$disconnect();
  }
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
