/**
 * Send randomised temperature + humidity to every instrument that has a usable
 * device credential.
 *
 * Goes through the REAL ingest path (`POST /api/ingest/v1/telemetry`, device
 * token auth) rather than inserting rows into `instrument_telemetry_history`.
 * That matters: readings land exactly as genuine device traffic does — same
 * payload parsing, same dead-letter handling, same last-seen bookkeeping — so
 * this exercises ingest instead of pretending to. It also means a failure here
 * is a real failure, not an artefact of the script.
 *
 * ─── THE DATA IS SYNTHETIC ────────────────────────────────────────────────
 * These readings are generated, not measured, and once written they are
 * INDISTINGUISHABLE from real ones — there is no "test" flag on a telemetry
 * row. Run this against local dev only. It refuses to run against a non-local
 * API unless you pass --force, because the failure mode is fabricated data in
 * a 21 CFR Part 11 record and that is not something to do by accident.
 *
 * Values stay INSIDE the usual room band (18-25 °C, 30-60 %RH) by default, so
 * nothing raises an alarm. `--excursion` deliberately pushes some readings out
 * of spec to exercise the alarm path — separate flag on purpose, because
 * fabricated out-of-spec events land in the alarm table and someone has to be
 * able to tell those apart from real ones later.
 *
 * Tokens are REVEALED (decrypted), never regenerated. Regenerating revokes the
 * credential a real field device is using — see demo-live-scenario.ts, which
 * makes the same choice for the same reason. An instrument whose credential
 * predates 2026-08-06 has no recoverable token and is reported as skipped:
 * regenerate it through the UI, which captures the re-authentication
 * signature, then use --token to post for it.
 *
 * Usage:
 *   npx tsx apps/api/scripts/send-random-telemetry.ts
 *   npx tsx apps/api/scripts/send-random-telemetry.ts --points 120 --interval 0.5
 *   npx tsx apps/api/scripts/send-random-telemetry.ts --live            (keeps going)
 *   npx tsx apps/api/scripts/send-random-telemetry.ts --only DEMO-TH-142,CWH-01
 *   npx tsx apps/api/scripts/send-random-telemetry.ts --only GWV-x --token <tok>
 *   npx tsx apps/api/scripts/send-random-telemetry.ts --excursion
 */
import { prisma } from '../src/lib/prisma.js';
import { decryptToken } from '../src/modules/instruments/token-crypto.js';

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string, fallback?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const API = process.env.PROBE_API ?? 'https://localhost:3001';
const POINTS = Number(opt('points', '60'));
const INTERVAL_MIN = Number(opt('interval', '1'));
const ONLY = opt('only')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
const TOKEN_OVERRIDE = opt('token');
const LIVE = flag('live');
const EXCURSION = flag('excursion');

/** The dev API uses a mkcert cert Node does not trust. Local only — see the header. */
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(API);
if (!isLocal && !flag('force')) {
  console.error(`Refusing to post synthetic telemetry to a non-local API (${API}).`);
  console.error('These rows are indistinguishable from real readings. Pass --force if you truly mean it.');
  process.exit(1);
}
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * A random walk that stays in band rather than independent random draws.
 * Independent draws look like noise and make a trend chart useless for judging
 * whether the page is drawing correctly; a walk produces a line you can read.
 */
function makeWalker(base: number, band: [number, number], step: number) {
  let v = base;
  return () => {
    v += (Math.random() - 0.5) * step * 2;
    // Pull gently back toward the middle so it does not wander to an edge and stick.
    v += (base - v) * 0.06;
    v = Math.min(band[1], Math.max(band[0], v));
    return round1(v);
  };
}

interface Target { code: string; token: string; roomed: boolean }

async function resolveTargets(): Promise<{ targets: Target[]; skipped: string[] }> {
  const instruments = await prisma.instrument.findMany({
    where: { isActive: true, ...(ONLY ? { code: { in: ONLY } } : {}) },
    select: {
      code: true, roomId: true,
      credentials: { where: { revokedAt: null }, select: { tokenEncrypted: true } },
    },
    orderBy: { code: 'asc' },
  });

  const targets: Target[] = [];
  const skipped: string[] = [];

  for (const i of instruments) {
    if (TOKEN_OVERRIDE && ONLY?.length === 1) {
      targets.push({ code: i.code, token: TOKEN_OVERRIDE, roomed: !!i.roomId });
      continue;
    }
    const blob = i.credentials.find((c) => c.tokenEncrypted)?.tokenEncrypted;
    if (!blob) { skipped.push(`${i.code} (no recoverable token — regenerate in the UI)`); continue; }
    try {
      targets.push({ code: i.code, token: decryptToken(blob), roomed: !!i.roomId });
    } catch {
      skipped.push(`${i.code} (token would not decrypt)`);
    }
  }
  return { targets, skipped };
}

async function post(token: string, ts: string, temperature: number, humidity: number) {
  const res = await fetch(`${API}/api/ingest/v1/telemetry`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ ts, temperature, humidity }),
  });
  return res.ok ? { ok: true as const } : { ok: false as const, detail: `${res.status} ${(await res.text()).slice(0, 140)}` };
}

async function main() {
  const { targets, skipped } = await resolveTargets();
  if (!targets.length) {
    console.error('No instruments with a usable device token.' + (ONLY ? ` (--only ${ONLY.join(',')})` : ''));
    process.exit(1);
  }

  console.log(`API ${API}`);
  console.log(`${targets.length} instrument(s)${ONLY ? ` (filtered)` : ''}${EXCURSION ? '  [EXCURSION MODE — will breach limits]' : ''}`);
  if (skipped.length) console.log(`skipped: ${skipped.join(', ')}`);

  const walkers = new Map(targets.map((t) => [t.code, {
    temp: makeWalker(21.8, EXCURSION ? [17, 27] : [19.5, 23.5], EXCURSION ? 1.6 : 0.35),
    rh: makeWalker(45, EXCURSION ? [25, 65] : [38, 52], EXCURSION ? 5 : 1.2),
  }]));

  if (LIVE) {
    console.log(`live mode — one reading per instrument every ${INTERVAL_MIN} min. Ctrl+C to stop.\n`);
    let round = 0;
    for (;;) {
      round++;
      const ts = new Date().toISOString();
      let ok = 0, fail = 0;
      for (const t of targets) {
        const w = walkers.get(t.code)!;
        const r = await post(t.token, ts, w.temp(), w.rh());
        r.ok ? ok++ : (fail++, console.error(`  ${t.code}: ${r.detail}`));
        await sleep(120);
      }
      console.log(`round ${round} @ ${ts} — accepted ${ok}, rejected ${fail}`);
      await sleep(Math.max(0, INTERVAL_MIN * 60_000 - targets.length * 120));
    }
  }

  // Backfill mode: one run covering the last (points-1)*interval minutes.
  const now = Date.now();
  console.log(`backfilling ${POINTS} readings each, one every ${INTERVAL_MIN} min ` +
    `(last ${((POINTS - 1) * INTERVAL_MIN / 60).toFixed(1)}h)\n`);

  let grandOk = 0, grandFail = 0;
  for (const t of targets) {
    const w = walkers.get(t.code)!;
    let ok = 0, fail = 0, lastError = '';
    for (let i = 0; i < POINTS; i++) {
      const ts = new Date(now - (POINTS - 1 - i) * INTERVAL_MIN * 60_000).toISOString();
      const r = await post(t.token, ts, w.temp(), w.rh());
      if (r.ok) ok++;
      else {
        fail++; lastError = r.detail;
        // A rejected token rejects every time; do not hammer it POINTS times.
        if (r.detail.startsWith('401')) { console.error(`  ${t.code}: token rejected — skipping the rest for this instrument`); break; }
      }
      await sleep(150); // stays under the route's 600/min device rate limit
    }
    grandOk += ok; grandFail += fail;
    console.log(`  ${t.code.padEnd(20)} ok=${String(ok).padStart(4)} fail=${fail}` +
      `${t.roomed ? '' : '  (not placed on a floorplan)'}${lastError ? `  last: ${lastError}` : ''}`);
  }

  console.log(`\naccepted ${grandOk}, rejected ${grandFail}`);
  if (EXCURSION) console.log('Excursion mode wrote OUT-OF-SPEC readings. Any alarms raised from these are fabricated — clear them before demonstrating anything real.');
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
