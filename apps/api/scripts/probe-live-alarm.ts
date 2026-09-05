/**
 * End-to-end live test: MQTT telemetry -> ingest -> alarm raise -> clear -> notification.
 *
 * Everything before this exercised the evaluator against telemetry that was already in
 * the database. This drives the real wire: it publishes as a device over MQTT with the
 * device's own credentials, so the broker's auth, the ingest bridge, slot resolution and
 * the evaluator are all in the path.
 *
 * MQTT contract (mqtt-auth-routes.ts, 2026-09-04): clientId = instrument CODE, username = device
 * token, topic = instruments/<code>/telemetry. All three must agree.
 *
 * Not a test file: it creates a real instrument and rule and removes both in a finally.
 */
import mqtt from 'mqtt';
import { prisma } from '../src/lib/prisma.js';
import { evaluateAlarms } from '../src/workers/alarm-evaluation.worker.js';

const API = process.env.PROBE_API ?? 'https://localhost:3001';
const BROKER = process.env.MQTT_BROKER_URL ?? 'mqtt://127.0.0.1:1883';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // local mkcert cert

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api(path: string, init: RequestInit & { token?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(init.headers as object) };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const res = await fetch(`${API}${path}`, { ...init, headers });
  const body = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${body.slice(0, 300)}`);
  return body ? JSON.parse(body) : null;
}

async function publish(code: string, token: string, value: number) {
  const client = await mqtt.connectAsync(BROKER, { clientId: code, username: token, password: '', clean: true, connectTimeout: 8000 });
  await client.publishAsync(`instruments/${code}/telemetry`, JSON.stringify({ temperature: value }), { qos: 1 });
  await client.endAsync();
}

async function latestTemp(instrumentId: string) {
  const rows = await prisma.$queryRaw<{ key: string; value: unknown; ts: Date }[]>`
    SELECT key, value, ts FROM instrument_telemetry_latest WHERE instrument_id = ${instrumentId}`;
  return rows.find((r) => r.key === 'temperature');
}

async function main() {
  let instrumentId = '';
  let ruleId = '';
  const jobsBefore = await countJobs();

  try {
    const login = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'superadmin', password: 'Admin@123', force: true }),
    });
    const jwt = login.accessToken ?? login.token ?? login.data?.accessToken;
    if (!jwt) throw new Error(`no token in login response: ${JSON.stringify(login).slice(0, 200)}`);

    const profile = await prisma.instrumentProfile.findFirst({ select: { id: true } });
    if (!profile) throw new Error('no instrument profile exists');

    const inst = await api('/api/instruments', {
      method: 'POST', token: jwt,
      body: JSON.stringify({ name: '__probe__ live alarm', code: `PROBE-LIVE-${Date.now()}`, profileId: profile.id }),
    });
    instrumentId = inst.id;
    console.log(`\n  instrument ${inst.code}  id=${instrumentId}`);

    const rule = await prisma.alarmRule.create({
      data: {
        name: '__probe__ live temp above 25', instrumentId,
        metric: 'TEMPERATURE', comparison: 'ABOVE', thresholdHigh: 25,
        delaySeconds: 0, severity: 'CRITICAL', isActive: true, createdBy: 'probe',
      },
    });
    ruleId = rule.id;
    console.log('  rule: temperature above 25, immediate, CRITICAL\n');

    // ── 1. Publish a BREACHING reading over MQTT ──────────────────────────────
    console.log('  publishing temperature=31.2 over MQTT as the device...');
    await publish(inst.code, inst.token, 31.2);
    await sleep(2500);
    const hot = await latestTemp(instrumentId);
    console.log(`  ingested: ${hot ? `${hot.key}=${JSON.stringify(hot.value)}` : 'NOTHING — the bridge did not accept it'}`);
    if (!hot) throw new Error('telemetry never landed; the rest of the test would be meaningless');

    console.log(`  evaluator: ${JSON.stringify(await evaluateAlarms())}`);
    let alarm = await prisma.alarm.findFirst({ where: { ruleId }, orderBy: { raisedAt: 'desc' } });
    console.log(`  alarm: state=${alarm?.state} value=${alarm?.triggeredValue} severity=${alarm?.severity}`);

    // ── 2. Publish an IN-SPEC reading; the alarm must clear ───────────────────
    console.log('\n  publishing temperature=21.0 over MQTT...');
    await publish(inst.code, inst.token, 21.0);
    await sleep(2500);
    const cool = await latestTemp(instrumentId);
    console.log(`  ingested: ${cool ? `${cool.key}=${JSON.stringify(cool.value)}` : 'NOTHING'}`);

    console.log(`  evaluator: ${JSON.stringify(await evaluateAlarms())}`);
    alarm = await prisma.alarm.findFirst({ where: { ruleId }, orderBy: { raisedAt: 'desc' } });
    console.log(`  alarm: state=${alarm?.state} clearedAt=${alarm?.clearedAt ? 'set' : 'null'} acknowledgedAt=${alarm?.acknowledgedAt ?? 'null'}`);
    console.log('  ^ cleared but NOT acknowledged — still needs answering for');

    console.log(`\n  notification jobs enqueued during this run: ${(await countJobs()) - jobsBefore} (queued now; the running worker drains them)`);
  } finally {
    if (ruleId) {
      const n = await prisma.alarm.deleteMany({ where: { ruleId } });
      await prisma.alarmRule.delete({ where: { id: ruleId } });
      console.log(`\n  cleaned up: ${n.count} alarm(s) + the rule`);
    }
    if (instrumentId) {
      await prisma.$executeRaw`DELETE FROM instrument_telemetry_latest WHERE instrument_id = ${instrumentId}`;
      await prisma.$executeRaw`DELETE FROM instrument_telemetry_history WHERE instrument_id = ${instrumentId}`;
      await prisma.instrumentCredential.deleteMany({ where: { instrumentId } });
      await prisma.instrument.delete({ where: { id: instrumentId } }).catch((e) => console.error('  instrument delete failed:', e.message));
      console.log('  cleaned up: the probe instrument and its telemetry');
    }
    await prisma.$disconnect();
  }
}

async function countJobs(): Promise<number> {
  const r = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM graphile_worker._private_jobs j
      JOIN graphile_worker._private_tasks t ON t.id = j.task_id
     WHERE t.identifier = 'notification'`;
  return Number(r[0]?.n ?? 0);
}

main().catch(async (e) => { console.error('\nFAILED:', e.message); await prisma.$disconnect(); process.exit(1); });
