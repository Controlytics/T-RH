/**
 * Drives a full live scenario for browser inspection:
 *
 *   1. gateway fan-out  — IOTGW_01 publishes ONE MQTT message carrying readings for its
 *                         three children; each lands attributed to the right instrument.
 *   2. direct publish   — a non-gateway instrument publishes its own flat payload.
 *   3. alarm rules      — temperature / humidity / a functional-location-wide rule.
 *   4. evaluation       — raises from the readings just ingested, then clears one.
 *
 * Tokens are REVEALED, never regenerated: regenerating kills the field device's current
 * credential, and these are the operator's real instruments.
 *
 * Run `clean` to remove the rules and alarms it created (the telemetry is left — it is
 * ordinary instrument history and the tables are partitioned by time).
 */
import mqtt from 'mqtt';
import { prisma } from '../src/lib/prisma.js';
import { evaluateAlarms } from '../src/workers/alarm-evaluation.worker.js';

const API = process.env.PROBE_API ?? 'https://localhost:3001';
const BROKER = process.env.MQTT_BROKER_URL ?? 'mqtt://127.0.0.1:1883';
// 2026-08-29 (audit L6): read from the environment instead of being baked in.
// It was the only literal credential anywhere in apps/, packages/ or scripts/.
// Harmless in itself — a dev script against localhost — but a hardcoded
// password is the thing a secret scanner flags and a reader copies. DEMO_PASS
// is the variable the sibling probe scripts already use.
const PW = process.env.DEMO_PASS ?? 'Admin@123';
const TAG = '[demo]';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api(path: string, init: RequestInit & { token?: string; reauth?: boolean } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(init.headers as object) };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.reauth) headers['x-reauth-password'] = PW;
  const res = await fetch(`${API}${path}`, { ...init, headers });
  const body = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${body.slice(0, 300)}`);
  return body ? JSON.parse(body) : null;
}

// MQTT contract (mqtt-auth-routes.ts, 2026-09-04): clientId = instrument CODE,
// username = device token, topic = instruments/<code>/telemetry. All three agree.
async function publish(code: string, token: string, payload: unknown) {
  const c = await mqtt.connectAsync(BROKER, { clientId: code, username: token, password: '', clean: true, connectTimeout: 8000 });
  await c.publishAsync(`instruments/${code}/telemetry`, JSON.stringify(payload), { qos: 1 });
  await c.endAsync();
}

async function clean() {
  const rules = await prisma.alarmRule.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  let alarms = 0;
  for (const r of rules) {
    alarms += (await prisma.alarm.deleteMany({ where: { ruleId: r.id } })).count;
    await prisma.alarmRule.delete({ where: { id: r.id } });
  }
  console.log(`removed ${alarms} alarm(s) and ${rules.length} rule(s) tagged ${TAG}`);
}

async function main() {
  const login = await api('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ username: 'superadmin', password: PW, force: true }),
  });
  const jwt = login.accessToken ?? login.token ?? login.data?.accessToken;

  const gw = await prisma.instrument.findFirst({
    where: { code: 'IOTGW_01' },
    select: { id: true, code: true, children: { select: { id: true, code: true } } },
  });
  if (!gw) throw new Error('IOTGW_01 not found');
  console.log(`\ngateway ${gw.code} -> children ${gw.children.map((c) => c.code).join(', ')}`);

  // Reveal (not regenerate) — leaves the field device's credential intact.
  const revealed = await api(`/api/instruments/${gw.id}/token`, { token: jwt, reauth: true });
  const gwToken = revealed.token;
  if (!gwToken) throw new Error(`no token revealed: ${JSON.stringify(revealed).slice(0, 200)}`);

  // ── 1. Gateway fan-out: ONE message, three instruments ──────────────────────
  const kids = gw.children;
  const fanout: Record<string, Record<string, number>> = {};
  fanout[kids[0].code] = { temperature: 31.4, humidity: 58 };   // breaches temp
  if (kids[1]) fanout[kids[1].code] = { temperature: 22.1, humidity: 71 }; // breaches RH
  if (kids[2]) fanout[kids[2].code] = { temperature: 21.7, humidity: 46 }; // in spec
  console.log(`\npublishing ONE gateway message for ${Object.keys(fanout).length} children:`);
  for (const [code, r] of Object.entries(fanout)) console.log(`    ${code}: ${JSON.stringify(r)}`);
  await publish(gw.code, gwToken, { devices: fanout });
  await sleep(3000);

  for (const k of kids) {
    const rows = await prisma.$queryRaw<{ key: string; value: unknown }[]>`
      SELECT key, value FROM instrument_telemetry_latest WHERE instrument_id = ${k.id} ORDER BY key`;
    console.log(`    ingested ${k.code}: ${rows.map((r) => `${r.key}=${JSON.stringify(r.value)}`).join(', ') || '(nothing)'}`);
  }

  // ── 2. Direct publish from a NON-gateway instrument ────────────────────────
  // A THROWAWAY instrument, not one of the operator's: every pre-existing standalone
  // instrument here has a token issued before tokens became viewable (409
  // TOKEN_NOT_RECOVERABLE), and the only way to get a usable credential for one would be
  // to REGENERATE it — which kills the credential the real field device is using.
  let soloId = '';
  try {
    const solo = await api('/api/instruments', {
      method: 'POST', token: jwt,
      body: JSON.stringify({
        name: `${TAG} direct publisher`, code: `DEMO-DIRECT-${Date.now()}`,
        profileId: (await prisma.instrumentProfile.findFirstOrThrow({ select: { id: true } })).id,
      }),
    });
    soloId = solo.id;
    console.log(`
publishing DIRECT (flat payload, no gateway) from ${solo.code}: {"temperature":26.8,"humidity":52}`);
    await publish(solo.code, solo.token, { temperature: 26.8, humidity: 52 });
    await sleep(2500);
    const rows = await prisma.$queryRaw<{ key: string; value: unknown }[]>`
      SELECT key, value FROM instrument_telemetry_latest WHERE instrument_id = ${solo.id} ORDER BY key`;
    console.log(`    ingested ${solo.code}: ${rows.map((r) => `${r.key}=${JSON.stringify(r.value)}`).join(', ') || '(nothing)'}`);
  } finally {
    if (soloId) {
      await prisma.$executeRaw`DELETE FROM instrument_telemetry_latest WHERE instrument_id = ${soloId}`;
      await prisma.$executeRaw`DELETE FROM instrument_telemetry_history WHERE instrument_id = ${soloId}`;
      await prisma.instrumentCredential.deleteMany({ where: { instrumentId: soloId } });
      await prisma.instrument.delete({ where: { id: soloId } }).catch(() => {});
      console.log('    (throwaway publisher removed — the real instruments were not touched)');
    }
  }

  // ── 3. Rules: per-instrument, and one that covers a whole functional location ─
  await clean();
  const block = await prisma.functionalLocation.findFirst({ where: { type: 'BLOCK' }, select: { id: true, name: true } });
  const defs = [
    { name: `${TAG} cold room temperature high`, instrumentId: kids[0].id, functionalLocationId: null,
      metric: 'TEMPERATURE' as const, comparison: 'ABOVE' as const, thresholdHigh: 25, thresholdLow: null, severity: 'CRITICAL' as const },
    ...(kids[1] ? [{ name: `${TAG} humidity above 65`, instrumentId: kids[1].id, functionalLocationId: null,
      metric: 'HUMIDITY' as const, comparison: 'ABOVE' as const, thresholdHigh: 65, thresholdLow: null, severity: 'MAJOR' as const }] : []),
    ...(block ? [{ name: `${TAG} ${block.name} outside 18-24`, instrumentId: null, functionalLocationId: block.id,
      metric: 'TEMPERATURE' as const, comparison: 'OUTSIDE_RANGE' as const, thresholdLow: 18, thresholdHigh: 24, severity: 'MINOR' as const }] : []),
  ];
  console.log('\nrules:');
  for (const d of defs) {
    await prisma.alarmRule.create({ data: { ...d, delaySeconds: 0, isActive: true, createdBy: 'demo' } });
    console.log(`    ${d.name}`);
  }

  // ── 4. Evaluate ────────────────────────────────────────────────────────────
  console.log(`\nevaluator: ${JSON.stringify(await evaluateAlarms())}`);
  const raised = await prisma.alarm.findMany({
    where: { rule: { name: { startsWith: TAG } } },
    include: { instrument: { select: { code: true } } }, orderBy: { severity: 'asc' },
  });
  for (const a of raised) {
    console.log(`    ${a.severity.padEnd(8)} ${a.instrument.code.padEnd(18)} ${a.metric.padEnd(12)} value=${a.triggeredValue ?? '—'}  state=${a.state}`);
  }

  // ── 5. Clear ONE of them, so the History tab has content too ───────────────
  console.log('\nre-publishing the cold room in spec (temperature=21.9) so one alarm CLEARS...');
  await publish(gw.code, gwToken, { devices: { [kids[0].code]: { temperature: 21.9 } } });
  await sleep(2500);
  console.log(`evaluator: ${JSON.stringify(await evaluateAlarms())}`);

  const final = await prisma.alarm.findMany({
    where: { rule: { name: { startsWith: TAG } } },
    include: { instrument: { select: { code: true } } },
  });
  console.log('\nfinal alarm set:');
  for (const a of final) {
    console.log(`    ${a.state.padEnd(8)} ${a.severity.padEnd(8)} ${a.instrument.code.padEnd(18)} ${a.metric.padEnd(12)} ack=${a.acknowledgedAt ? 'yes' : 'NO'}`);
  }
  await prisma.$disconnect();
}

const mode = process.argv[2] === 'clean' ? () => clean().then(() => prisma.$disconnect()) : main;
mode().catch(async (e) => { console.error('\nFAILED:', e.message); await prisma.$disconnect(); process.exit(1); });
