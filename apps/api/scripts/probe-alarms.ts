/**
 * Exercises the REAL alarm evaluator against the real database.
 *
 * Creates a throwaway rule against one instrument, drives it through
 * raise → hold → clear, and deletes everything it made in a `finally`. Not a test
 * file: it writes to live tables, so cleanup is unconditional.
 */
import { prisma } from '../src/lib/prisma.js';
import { evaluateAlarms } from '../src/workers/alarm-evaluation.worker.js';

async function main() {
  const inst = await prisma.instrument.findFirst({
    where: { code: 'DEMO-TH-142' },
    select: { id: true, code: true },
  });
  if (!inst) throw new Error('DEMO-TH-142 not found');

  const latest = await prisma.$queryRaw<{ key: string; value: unknown }[]>`
    SELECT key, value FROM instrument_telemetry_latest WHERE instrument_id = ${inst.id}`;
  console.log(`\ninstrument ${inst.code} latest: ${JSON.stringify(latest)}`);

  const temp = latest.find((r) => /temp/i.test(r.key));
  const current = typeof temp?.value === 'number' ? temp.value : null;
  if (current === null) throw new Error('no numeric temperature reading to test against');
  console.log(`current temperature: ${current}\n`);

  let ruleId: string | null = null;
  try {
    // Threshold BELOW the current reading, so the condition is met immediately.
    const rule = await prisma.alarmRule.create({
      data: {
        name: '__probe__ temp above',
        instrumentId: inst.id,
        metric: 'TEMPERATURE',
        comparison: 'ABOVE',
        thresholdHigh: current - 1,
        delaySeconds: 0,
        severity: 'MAJOR',
        isActive: true,
        createdBy: 'probe',
      },
    });
    ruleId = rule.id;
    console.log(`rule: temperature above ${current - 1} (current ${current}) -> should RAISE`);

    console.log('  run 1:', JSON.stringify(await evaluateAlarms()));
    let a = await prisma.alarm.findFirst({ where: { ruleId }, orderBy: { raisedAt: 'desc' } });
    console.log(`  alarm: state=${a?.state} value=${a?.triggeredValue} severity=${a?.severity}`);
    console.log(`  snapshot: ${JSON.stringify((a?.ruleSnapshot as Record<string, unknown>)?.description)}`);

    // Second run must NOT create a second alarm: one excursion, one alarm.
    console.log('  run 2 (must raise 0):', JSON.stringify(await evaluateAlarms()));
    console.log(`  alarms for this rule: ${await prisma.alarm.count({ where: { ruleId } })} (expect 1)`);

    // Raise the threshold above the reading so the condition ends.
    await prisma.alarmRule.update({ where: { id: ruleId }, data: { thresholdHigh: current + 10 } });
    console.log(`\n  threshold moved to ${current + 10} -> should CLEAR`);
    console.log('  run 3:', JSON.stringify(await evaluateAlarms()));
    a = await prisma.alarm.findFirst({ where: { ruleId }, orderBy: { raisedAt: 'desc' } });
    console.log(`  alarm: state=${a?.state} clearedAt=${a?.clearedAt ? 'set' : 'null'} acknowledgedAt=${a?.acknowledgedAt ?? 'null'}`);
    console.log('  ^ cleared but NOT acknowledged — the record still needs answering for');

    // A rule with no threshold must never fire.
    await prisma.alarmRule.update({ where: { id: ruleId }, data: { thresholdHigh: null } });
    const beforeMisconfigured = await prisma.alarm.count({ where: { ruleId } });
    console.log('\n  threshold removed (misconfigured) -> must NOT fire');
    console.log('  run 4:', JSON.stringify(await evaluateAlarms()));
    console.log(`  alarms: ${await prisma.alarm.count({ where: { ruleId } })} (expect ${beforeMisconfigured})`);
  } finally {
    if (ruleId) {
      // Alarms are RESTRICT-protected, so they must go before the rule. This is the
      // only place alarm rows are deleted — the product has no delete path.
      const n = await prisma.alarm.deleteMany({ where: { ruleId } });
      await prisma.alarmRule.delete({ where: { id: ruleId } });
      console.log(`\n  cleaned up: ${n.count} probe alarm(s) and the probe rule`);
    }
    await prisma.$disconnect();
  }
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
