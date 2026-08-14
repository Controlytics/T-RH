/**
 * Throwaway demo data for screenshotting the Alarms page. NOT a fixture — run with
 * `clean` to remove everything it made.
 *
 * The rule is created INACTIVE on purpose: the evaluator only reads active rules, so the
 * per-minute cron cannot clear these rows out from under the screenshot.
 */
import { prisma } from '../src/lib/prisma.js';

const RULE_NAME = '__demo__ screenshot rule';

async function clean() {
  const rules = await prisma.alarmRule.findMany({ where: { name: RULE_NAME }, select: { id: true } });
  for (const r of rules) {
    const n = await prisma.alarm.deleteMany({ where: { ruleId: r.id } });
    await prisma.alarmRule.delete({ where: { id: r.id } });
    console.log(`removed ${n.count} demo alarm(s) and the demo rule`);
  }
  if (rules.length === 0) console.log('nothing to clean');
}

async function seed() {
  await clean();
  const instruments = await prisma.instrument.findMany({
    select: { id: true, code: true }, orderBy: { code: 'asc' }, take: 3,
  });
  if (instruments.length === 0) throw new Error('no instruments to attach demo alarms to');

  const rule = await prisma.alarmRule.create({
    data: {
      name: RULE_NAME, instrumentId: instruments[0].id,
      metric: 'TEMPERATURE', comparison: 'ABOVE', thresholdHigh: 25,
      delaySeconds: 0, severity: 'MAJOR', isActive: false, createdBy: 'demo',
    },
  });

  const now = Date.now();
  const rows = [
    { i: 0, metric: 'TEMPERATURE', severity: 'CRITICAL', value: 31.8, state: 'ACTIVE',
      desc: 'temperature above 25', ageMin: 12, ack: null },
    { i: 1 % instruments.length, metric: 'HUMIDITY', severity: 'MAJOR', value: 68.4, state: 'ACTIVE',
      desc: 'humidity above 60', ageMin: 47, ack: null },
    { i: 2 % instruments.length, metric: 'TEMPERATURE', severity: 'MINOR', value: 25.6, state: 'CLEARED',
      desc: 'temperature above 25', ageMin: 210, ack: null },
    { i: 0, metric: 'OFFLINE', severity: 'MAJOR', value: null, state: 'CLEARED',
      desc: 'stopped reporting', ageMin: 380, ack: 'qa.lead' },
  ];

  for (const r of rows) {
    const raisedAt = new Date(now - r.ageMin * 60000);
    await prisma.alarm.create({
      data: {
        ruleId: rule.id,
        instrumentId: instruments[r.i].id,
        metric: r.metric as never,
        triggeredValue: r.value,
        severity: r.severity as never,
        state: r.state as never,
        raisedAt,
        clearedAt: r.state === 'CLEARED' ? new Date(raisedAt.getTime() + 40 * 60000) : null,
        acknowledgedAt: r.ack ? new Date(raisedAt.getTime() + 55 * 60000) : null,
        acknowledgedBy: r.ack,
        acknowledgeReason: r.ack ? 'Investigated — chiller serviced, deviation DEV-114 raised' : null,
        ruleSnapshot: { name: RULE_NAME, description: r.desc, snapshotAt: raisedAt.toISOString() },
      },
    });
  }
  console.log(`seeded ${rows.length} demo alarms on ${instruments.map((i) => i.code).join(', ')}`);
}

const mode = process.argv[2] === 'clean' ? clean : seed;
mode()
  .then(() => prisma.$disconnect())
  .catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
