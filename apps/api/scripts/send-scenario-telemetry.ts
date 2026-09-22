/**
 * Send EVERY kind of reading the dashboard can show, to every placed
 * instrument, continuously — so the floor plan and the readings table can be
 * judged with all of their states on screen at once (operator, 2026-09-22:
 * "send data to all instruments continously with all type values, like below
 * limits values, higher than limits, NA, error what ever types are there").
 *
 * Each instrument is assigned ONE scenario, by its position in code order, and
 * keeps it for the whole run, so a given room always shows the same state and
 * the assignment printed at start-up can be read against the screen:
 *
 *   IN_LIMIT    both readings inside the limits            → green / green
 *   TEMP_HIGH   temperature above its high limit           → red / green
 *   TEMP_LOW    temperature below its low limit            → red / green
 *   RH_HIGH     humidity above its high limit              → green / red
 *   RH_LOW      humidity below its low limit               → green / red
 *   TEMP_ERROR  the temperature probe sends the text "NA"  → violet Error / green
 *   RH_ERROR    the humidity probe sends the text "NA"     → green / violet Error
 *   TEMP_OL     temperature outside the SENSOR RANGE       → violet OL / green
 *   RH_OL       humidity outside the sensor range          → green / violet OL
 *   RH_ABSENT   humidity is never sent                     → green / grey NA
 *   OFFLINE     reports once, then nothing for a while     → amber after the activity window
 *
 * Every value is generated RELATIVE to the instrument's own bounds — its
 * `t_ll`/`t_hl`/`h_ll`/`h_hl` limits and its `Low/High … Range` attributes — so
 * "above the limit" means above THAT instrument's limit, whatever it is.
 *
 * ─── LIMITS ARE WRITTEN WHERE THERE ARE NONE ─────────────────────────────────
 * On 2026-09-22, 99 of 100 instruments carried NO limit attributes (the four
 * `… Limit` keys were deleted on 2026-09-16 and only CWH/RDU/001-00 has the
 * gateway's `t_hl` family). Without a bound nothing can ever be "above the
 * limit", so unless `--no-limits` is passed this script first writes
 * `t_ll 18 / t_hl 27 / h_ll 30 / h_hl 60` to every target that has none of
 * the four — THE WAY THE GATEWAY DOES IT, over MQTT on
 * `instruments/<code>/attributes/report`, so each lands as a system
 * `INSTRUMENT_ATTRIBUTE_REPORTED` audit row naming the device. An instrument
 * that already has any of the four is left alone.
 *
 * ─── THE DATA IS SYNTHETIC ───────────────────────────────────────────────────
 * Readings go through the REAL ingest path (`POST /api/ingest/v1/telemetry`,
 * device token auth) and, once written, are indistinguishable from real ones;
 * the alarms they raise (limit, RS485 failure, sensor range, inactivity) are
 * real alarm rows. Local dev only — it refuses a non-local API without
 * `--force`. `scripts/purge-alarms.ts` clears the alarms afterwards.
 *
 * Tokens are REVEALED (decrypted), never regenerated — regenerating would
 * revoke the credential a real field device is using (send-random-telemetry.ts
 * makes the same choice for the same reason).
 *
 * Usage (from apps/api, so `.env` is found):
 *   npx tsx scripts/send-scenario-telemetry.ts                 every 30 s until Ctrl+C
 *   npx tsx scripts/send-scenario-telemetry.ts --interval 15
 *   npx tsx scripts/send-scenario-telemetry.ts --once           one round, then exit
 *   npx tsx scripts/send-scenario-telemetry.ts --no-limits      do not write missing limits
 *   npx tsx scripts/send-scenario-telemetry.ts --offline-every 8   minutes between the OFFLINE group's reports
 *   npx tsx scripts/send-scenario-telemetry.ts --only CWH/RDU/001-00,CWH/RDU/002-00
 */
import 'dotenv/config';
import mqtt from 'mqtt';
import { prisma } from '../src/lib/prisma.js';
import { decryptToken } from '../src/modules/instruments/token-crypto.js';

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string, fallback?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const API = process.env.PROBE_API ?? 'https://localhost:3001';
const BROKER = process.env.MQTT_BROKER_URL ?? 'mqtt://127.0.0.1:1883';
const INTERVAL_S = Number(opt('interval', '30'));
const OFFLINE_EVERY_MIN = Number(opt('offline-every', '8'));
const ONLY = opt('only')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
const ONCE = flag('once');
const WRITE_LIMITS = !flag('no-limits');

const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(API);
if (!isLocal && !flag('force')) {
  console.error(`Refusing to post synthetic telemetry to a non-local API (${API}).`);
  console.error('These rows are indistinguishable from real readings. Pass --force if you truly mean it.');
  process.exit(1);
}
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const round1 = (n: number) => Math.round(n * 10) / 10;
const between = (lo: number, hi: number) => round1(lo + Math.random() * (hi - lo));

/** The limits written to an instrument that has none. */
const DEFAULT_LIMITS = { t_ll: 18, t_hl: 27, h_ll: 30, h_hl: 60 } as const;
/** Sensor spans assumed when an instrument carries no range attributes. */
const DEFAULT_RANGE = { tLo: -40, tHi: 60, hLo: 0, hHi: 100 } as const;

type Scenario =
  | 'IN_LIMIT' | 'TEMP_HIGH' | 'TEMP_LOW' | 'RH_HIGH' | 'RH_LOW'
  | 'TEMP_ERROR' | 'RH_ERROR' | 'TEMP_OL' | 'RH_OL' | 'RH_ABSENT' | 'OFFLINE';

/** Position in code order → scenario. Four in fourteen stay in limit; every other state gets one slot. */
const CYCLE: Scenario[] = [
  'IN_LIMIT', 'TEMP_HIGH', 'IN_LIMIT', 'RH_HIGH', 'TEMP_ERROR', 'IN_LIMIT', 'TEMP_LOW',
  'RH_OL', 'OFFLINE', 'IN_LIMIT', 'RH_LOW', 'TEMP_OL', 'RH_ERROR', 'RH_ABSENT',
];

interface Bounds { tLo: number; tHi: number; hLo: number; hHi: number; range: { tLo: number; tHi: number; hLo: number; hHi: number } }
interface Target { id: string; code: string; token: string; scenario: Scenario; bounds: Bounds; hadLimits: boolean }

const num = (s: string | undefined, fallback: number) => {
  const n = Number(s);
  return s !== undefined && Number.isFinite(n) ? n : fallback;
};

async function resolveTargets(): Promise<{ targets: Target[]; skipped: string[] }> {
  const instruments = await prisma.instrument.findMany({
    where: { isActive: true, isGateway: false, roomId: { not: null }, ...(ONLY ? { code: { in: ONLY } } : {}) },
    select: {
      id: true, code: true,
      credentials: { where: { revokedAt: null }, select: { tokenEncrypted: true } },
    },
    orderBy: { code: 'asc' },
  });
  const attrs = await prisma.instrumentAttribute.findMany({
    where: { instrumentId: { in: instruments.map((i) => i.id) } },
    select: { instrumentId: true, key: true, value: true },
  });
  const byInstrument = new Map<string, Map<string, string>>();
  for (const a of attrs) {
    const m = byInstrument.get(a.instrumentId) ?? new Map<string, string>();
    m.set(a.key.toLowerCase(), a.value);
    byInstrument.set(a.instrumentId, m);
  }

  const targets: Target[] = [];
  const skipped: string[] = [];
  instruments.forEach((i, ix) => {
    const blob = i.credentials.find((c) => c.tokenEncrypted)?.tokenEncrypted;
    if (!blob) { skipped.push(`${i.code} (no recoverable token — regenerate in the UI)`); return; }
    let token: string;
    try { token = decryptToken(blob); } catch { skipped.push(`${i.code} (token would not decrypt)`); return; }

    const a = byInstrument.get(i.id) ?? new Map<string, string>();
    const hadLimits = ['t_ll', 't_hl', 'h_ll', 'h_hl'].some((k) => a.has(k));
    const bounds: Bounds = {
      tLo: num(a.get('t_ll'), DEFAULT_LIMITS.t_ll),
      tHi: num(a.get('t_hl'), DEFAULT_LIMITS.t_hl),
      hLo: num(a.get('h_ll'), DEFAULT_LIMITS.h_ll),
      hHi: num(a.get('h_hl'), DEFAULT_LIMITS.h_hl),
      range: {
        tLo: num(a.get('low temperature range'), DEFAULT_RANGE.tLo),
        tHi: num(a.get('high temperature range'), DEFAULT_RANGE.tHi),
        hLo: num(a.get('low humidity range'), DEFAULT_RANGE.hLo),
        hHi: num(a.get('high humidity range'), DEFAULT_RANGE.hHi),
      },
    };
    targets.push({ id: i.id, code: i.code, token, scenario: CYCLE[ix % CYCLE.length], bounds, hadLimits });
  });
  return { targets, skipped };
}

/** One reading pair for the scenario, relative to the instrument's own bounds. `undefined` = not sent. */
function readingsFor(t: Target): { t?: number | string; h?: number | string } {
  const b = t.bounds;
  const inT = () => between(b.tLo + (b.tHi - b.tLo) * 0.3, b.tLo + (b.tHi - b.tLo) * 0.7);
  const inH = () => between(b.hLo + (b.hHi - b.hLo) * 0.3, b.hLo + (b.hHi - b.hLo) * 0.7);
  switch (t.scenario) {
    case 'IN_LIMIT': case 'OFFLINE': return { t: inT(), h: inH() };
    case 'TEMP_HIGH': return { t: between(b.tHi + 1, b.tHi + 4), h: inH() };
    case 'TEMP_LOW': return { t: between(b.tLo - 4, b.tLo - 1), h: inH() };
    case 'RH_HIGH': return { t: inT(), h: between(b.hHi + 3, b.hHi + 10) };
    case 'RH_LOW': return { t: inT(), h: between(Math.max(b.range.hLo + 1, b.hLo - 10), b.hLo - 3) };
    case 'TEMP_ERROR': return { t: 'NA', h: inH() };
    case 'RH_ERROR': return { t: inT(), h: 'NA' };
    case 'TEMP_OL': return { t: between(b.range.tHi + 5, b.range.tHi + 15), h: inH() };
    case 'RH_OL': return { t: inT(), h: between(b.range.hHi + 10, b.range.hHi + 20) };
    case 'RH_ABSENT': return { t: inT() };
  }
}

async function post(token: string, body: Record<string, unknown>) {
  try {
    const res = await fetch(`${API}/api/ingest/v1/telemetry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return res.ok ? { ok: true as const } : { ok: false as const, detail: `${res.status} ${(await res.text()).slice(0, 140)}` };
  } catch (e) {
    const cause = (e as { cause?: { code?: string } })?.cause?.code;
    return { ok: false as const, detail: `transport: ${cause ?? (e instanceof Error ? e.message : String(e))}` };
  }
}

/** The gateway's own path for an attribute: an MQTT report as the device. */
async function reportLimits(t: Target): Promise<string | null> {
  try {
    const c = await mqtt.connectAsync(BROKER, { clientId: t.code, username: t.token, password: '', clean: true, connectTimeout: 8000 });
    await c.publishAsync(`instruments/${t.code}/attributes/report`, JSON.stringify(DEFAULT_LIMITS), { qos: 1 });
    await c.endAsync();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function main() {
  const { targets, skipped } = await resolveTargets();
  if (!targets.length) {
    console.error('No placed instruments with a usable device token.' + (ONLY ? ` (--only ${ONLY.join(',')})` : ''));
    process.exit(1);
  }
  console.log(`API ${API}   broker ${BROKER}`);
  console.log(`${targets.length} placed instrument(s), every ${INTERVAL_S} s; OFFLINE group reports every ${OFFLINE_EVERY_MIN} min`);
  if (skipped.length) console.log(`skipped: ${skipped.join(', ')}`);

  if (WRITE_LIMITS) {
    const missing = targets.filter((t) => !t.hadLimits);
    console.log(`\nwriting limits ${JSON.stringify(DEFAULT_LIMITS)} to ${missing.length} instrument(s) with none, as their device would …`);
    let ok = 0;
    for (const t of missing) {
      const err = await reportLimits(t);
      if (err) console.error(`  ${t.code}: ${err}`); else ok++;
    }
    console.log(`  reported to ${ok}/${missing.length}`);
    // The bridge writes them asynchronously; give it a moment before the first
    // readings arrive, or the first evaluation may run against no bounds.
    if (ok) await sleep(3000);
  } else {
    const missing = targets.filter((t) => !t.hadLimits).length;
    if (missing) console.log(`\n--no-limits: ${missing} instrument(s) have no limits — their red states cannot appear.`);
  }

  console.log('\nassignment (code order):');
  for (const t of targets) console.log(`  ${t.code.padEnd(20)} ${t.scenario}`);
  console.log('');

  const offlineLastSent = new Map<string, number>();
  let round = 0;
  for (;;) {
    round++;
    const ts = new Date().toISOString();
    let ok = 0, fail = 0, held = 0;
    for (const t of targets) {
      if (t.scenario === 'OFFLINE') {
        const last = offlineLastSent.get(t.code) ?? 0;
        if (Date.now() - last < OFFLINE_EVERY_MIN * 60_000) { held++; continue; }
        offlineLastSent.set(t.code, Date.now());
      }
      const r = await post(t.token, { ts, ...readingsFor(t) });
      r.ok ? ok++ : (fail++, console.error(`  ${t.code}: ${r.detail}`));
      await sleep(60);
    }
    console.log(`round ${round} @ ${ts} - accepted ${ok}, rejected ${fail}, offline group held ${held}`);
    if (ok === 0) console.error(`  round ${round}: NOTHING accepted — API unreachable or tokens revoked. Still retrying.`);
    if (ONCE) break;
    await sleep(Math.max(1000, INTERVAL_S * 1000 - targets.length * 60));
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
