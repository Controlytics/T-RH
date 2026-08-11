/**
 * Dev-only. Registers a handful of instruments named after real CWH 3rd-floor
 * rooms and publishes plausible temperature/humidity through the NORMAL ingest
 * endpoint — no direct database writes, so what the dashboard shows is what a
 * real device would produce.
 *
 * Deliberately includes one instrument that drifts out of spec and one that
 * never reports, because a dashboard whose colours have only ever been green
 * has not been tested.
 *
 * Usage:
 *   npx tsx scripts/publish-demo-telemetry.ts --seed      # create instruments, print tokens
 *   DEMO_TOKENS='<json>' npx tsx scripts/publish-demo-telemetry.ts --publish
 *
 * NOT wired into the app. Never imported by anything.
 */

// This repo's API is :3001. :3000 is the sibling DigiLog checkout — publishing
// there would write telemetry into an unrelated database.
const API = process.env.DEMO_API ?? 'https://localhost:3001';
const USER = process.env.DEMO_USER ?? 'superadmin';
const PASS = process.env.DEMO_PASS ?? 'Admin@123';
const INTERVAL_MS = Number(process.env.DEMO_INTERVAL_MS ?? 5000);

// Local mkcert cert; this script only ever talks to localhost.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

interface Device {
  code: string;
  name: string;
  room: string;
  temp: number;
  rh: number;
  /** °C added per tick — the one that walks out of spec. */
  drift?: number;
  /** Never publishes, so it goes STALE. */
  silent?: boolean;
  /** Publishes temperature only — renders PARTIAL in a room that specifies RH. */
  tempOnly?: boolean;
}

const DEVICES: Device[] = [
  { code: 'DEMO-TH-142', name: 'Wet Lab probe',      room: 'CWH-I/142', temp: 22.0, rh: 45 },
  { code: 'DEMO-TH-220', name: 'HPLC Room probe',    room: 'CWH-I/220', temp: 21.5, rh: 48 },
  { code: 'DEMO-TH-221', name: 'GC Room probe',      room: 'CWH-I/221', temp: 23.0, rh: 50, tempOnly: true },
  // Crosses a 25 °C limit within a couple of minutes — this is the one that
  // proves the colour coding works.
  { code: 'DEMO-TH-347', name: 'Canteen probe',      room: 'CWH-I/347', temp: 24.6, rh: 55, drift: 0.15 },
  { code: 'DEMO-TH-361', name: 'Service Area probe', room: 'CWH-I/361', temp: 22.0, rh: 45, silent: true },
];

async function login(): Promise<string> {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS, force: true }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const body = await res.json() as { token?: string };
  if (!body.token) throw new Error(`login returned no token: ${JSON.stringify(body).slice(0, 200)}`);
  return body.token;
}

async function seed(): Promise<void> {
  const jwt = await login();
  const auth = { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' };

  const profileRes = await fetch(`${API}/api/instrument-profiles`, { headers: auth });
  if (!profileRes.ok) throw new Error(`could not list profiles: ${profileRes.status}`);
  const profiles = await profileRes.json() as { data: { id: string; name: string }[] };
  const profileId = profiles.data[0]?.id;
  if (!profileId) throw new Error('no instrument profile exists — create one first');
  console.log(`Using profile "${profiles.data[0].name}"\n`);

  const tokens: Record<string, string> = {};
  for (const d of DEVICES) {
    const res = await fetch(`${API}/api/instruments`, {
      method: 'POST', headers: auth,
      // `location` is COSMETIC. This feature places instruments by `roomId`,
      // set in the floorplan editor — never by matching this text. It is seeded
      // only so the instrument list reads sensibly before any plan exists.
      // Until a plan is drawn, every instrument correctly shows "Not placed" on
      // the dashboard; that is not a bug.
      body: JSON.stringify({ name: d.name, code: d.code, profileId, location: d.room }),
    });
    if (res.status === 409) {
      console.log(`${d.code}: already exists — regenerate its token in the UI if you need it`);
      continue;
    }
    if (!res.ok) throw new Error(`${d.code}: ${res.status} ${await res.text()}`);
    const body = await res.json() as { token: string };
    tokens[d.code] = body.token;
    console.log(`${d.code}: created`);
  }

  if (Object.keys(tokens).length === 0) {
    console.log('\nNothing new created. Tokens are shown once at creation and cannot be re-read.');
    return;
  }

  console.log('\nSave this — device tokens are shown exactly once:\n');
  console.log(JSON.stringify(tokens));
  console.log(`\nThen:\n  DEMO_TOKENS='${JSON.stringify(tokens)}' npx tsx scripts/publish-demo-telemetry.ts --publish`);
}

async function publish(): Promise<void> {
  const raw = process.env.DEMO_TOKENS;
  if (!raw) throw new Error('Set DEMO_TOKENS to the JSON printed by --seed');
  const tokens = JSON.parse(raw) as Record<string, string>;
  const drift: Record<string, number> = {};

  const tick = async () => {
    for (const d of DEVICES) {
      if (d.silent) continue;
      const token = tokens[d.code];
      if (!token) continue;

      drift[d.code] = (drift[d.code] ?? 0) + (d.drift ?? 0);
      const temperature = +(d.temp + drift[d.code] + (Math.random() - 0.5) * 0.3).toFixed(2);
      const humidity = +(d.rh + (Math.random() - 0.5) * 2).toFixed(2);
      const payload: Record<string, number> = d.tempOnly
        ? { temperature }
        : { temperature, humidity };

      const shown = d.tempOnly ? `${temperature} °C` : `${temperature} °C  ${humidity} %RH`;
      const stamp = new Date().toISOString().slice(11, 19);

      // Survive an API restart. The dev server runs under `tsx watch`, so it
      // goes down and up again on every backend edit — a publisher that exits
      // on the first ECONNREFUSED has to be babysat, and then nobody runs it.
      try {
        const res = await fetch(`${API}/api/ingest/v1/telemetry`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        console.log(`${stamp}  ${d.code}  ${shown}  → ${res.status}`);
      } catch {
        console.log(`${stamp}  ${d.code}  ${shown}  → API unreachable, retrying next tick`);
      }
    }
  };

  console.log(`Publishing every ${INTERVAL_MS / 1000}s. Ctrl-C to stop.\n`);
  await tick();
  setInterval(tick, INTERVAL_MS);
}

// Wrapped rather than top-level await: the repo root is CJS, so tsx transpiles
// this to CommonJS and top-level await is a build error there.
async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === '--seed') return seed();
  if (mode === '--publish') return publish();
  console.error('Usage: publish-demo-telemetry.ts --seed | --publish');
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
