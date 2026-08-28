/**
 * Prove the `20260828070000_panel_access` carry-over against the row it came from.
 *
 * Run BEFORE deleting `system_config['dashboard-cards']`. The migration hardcodes
 * the panel keys, because SQL cannot import `@digilog/shared`; this script and the
 * frozen-key test in `packages/shared/src/types/panels.test.ts` are the two guards
 * that keep the two lists from drifting apart.
 *
 * Two expectations, both of which encode a decision:
 *   - the surviving DASHBOARD keys are exactly the live ones from the old list;
 *   - EVERY trend key is present, because the trend page was ungoverned before this
 *     migration, so everyone saw all five of its panels. Carrying only the dashboard
 *     keys would have stripped the trend page from every role that had a row.
 */
import { prisma } from '../src/lib/prisma.js';

const LIVE_DASHBOARD_KEYS = ['telemetry_table', 'telemetry_floorplan'];
const TREND_KEYS = ['trend_gauges', 'trend_charts', 'trend_summary', 'trend_historian_table', 'trend_alarms'];

async function main() {
  const legacy = await prisma.systemConfig.findUnique({ where: { configKey: 'dashboard-cards' } });
  if (!legacy) {
    console.log('system_config[dashboard-cards] is already gone — nothing to compare against.');
    await prisma.$disconnect();
    return;
  }

  const roles = (legacy.configValue as { roles?: Record<string, string[]> })?.roles ?? {};
  const rows = await prisma.roleConfig.findMany({ select: { role: true, dashboardCards: true } });
  let bad = 0;

  for (const [role, cards] of Object.entries(roles)) {
    const got = rows.find((r) => r.role === role)?.dashboardCards as string[] | null | undefined;
    const want = [...cards.filter((c) => LIVE_DASHBOARD_KEYS.includes(c)), ...TREND_KEYS];
    const ok = Array.isArray(got) && got.length === want.length && want.every((k) => got.includes(k));
    if (!ok) bad++;
    console.log(`${ok ? 'OK  ' : 'BAD '} ${role.padEnd(14)} was ${JSON.stringify(cards)}`);
    console.log(`     ${' '.repeat(14)} now ${JSON.stringify(got)}`);
  }

  // A role ABSENT from the legacy map must be left NULL — inherit, not a blanking.
  const untouched = rows.filter((r) => !(r.role in roles) && r.dashboardCards !== null);
  for (const r of untouched) {
    bad++;
    console.log(`BAD  ${r.role}: absent from the legacy map but not NULL`);
  }

  console.log(bad === 0 ? '\ncarry-over VERIFIED' : `\ncarry-over FAILED (${bad})`);
  await prisma.$disconnect();
  if (bad > 0) process.exit(1);
}

main();
