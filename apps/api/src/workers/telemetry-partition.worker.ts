/**
 * Telemetry partition maintenance.
 *
 * This is a CORRECTNESS requirement, not housekeeping. `instrument_telemetry_history`
 * is RANGE-partitioned by month, and PostgreSQL rejects a row that falls outside
 * every partition:
 *
 *   ERROR: no partition of relation "instrument_telemetry_history" found for row
 *
 * Ingestion therefore does not degrade when partitions run out — it stops dead,
 * at 00:00 on the 1st, and every reading is refused. Running ahead by several
 * months means one missed maintenance run cannot cause that.
 */
import { prisma } from '../lib/prisma.js';
import { configRepository } from '../modules/config/config.repository.js';

const PARENT = 'instrument_telemetry_history';

export interface RetentionSettings {
  monthsAhead: number;
  dropEnabled: boolean;
  retentionMonths: number;
}

/** Must match telemetry-retention.def.ts's declared defaults. */
const DEFAULTS: RetentionSettings = { monthsAhead: 3, dropEnabled: false, retentionMonths: 12 };

export async function retentionSettings(): Promise<RetentionSettings> {
  const stored = await configRepository.getSystemConfig('telemetry-retention');
  const value = (stored?.configValue as Partial<RetentionSettings> | null) ?? {};
  const merged = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as (keyof RetentionSettings)[]) {
    if (typeof value[key] === typeof DEFAULTS[key]) {
      (merged as Record<string, unknown>)[key] = value[key];
    }
  }
  // Below 2 months ahead, a single missed run can break inserts. Clamp rather
  // than trust a mis-set value.
  merged.monthsAhead = Math.max(2, Math.floor(merged.monthsAhead));
  merged.retentionMonths = Math.max(1, Math.floor(merged.retentionMonths));
  return merged;
}

/** UTC first-of-month, `offset` months from `from`. */
function monthStart(from: Date, offset = 0): Date {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + offset, 1));
}

const yyyymm = (d: Date) =>
  `${d.getUTCFullYear()}_${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

/**
 * Partition bound, anchored to UTC explicitly.
 *
 * `ts` is TIMESTAMPTZ (migration 20260804120000). A bare '2026-09-01' bound is
 * resolved against the SESSION's TimeZone, so on a non-UTC server the bounds
 * would sit hours away from the UTC month start — leaving a gap against the
 * migration's `+00`-anchored 2026_08 / 2026_09 partitions, and rejecting rows
 * that fall in it. The '+00' suffix is what makes this correct on any host.
 * (This code predates the TIMESTAMPTZ change and did not carry it.)
 */
const boundUtc = (d: Date) => `${d.toISOString().slice(0, 10)} 00:00:00+00`;

export const partitionName = (d: Date, parent = PARENT) => `${parent}_${yyyymm(d)}`;

/**
 * Create the current month plus `monthsAhead` following months.
 * Idempotent — CREATE TABLE IF NOT EXISTS, safe to run repeatedly.
 */
export async function ensurePartitions(
  monthsAhead: number, now = new Date(), parent = PARENT,
): Promise<string[]> {
  const created: string[] = [];
  for (let i = 0; i <= monthsAhead; i++) {
    const start = monthStart(now, i);
    const end = monthStart(now, i + 1);
    const name = partitionName(start, parent);
    // Identifiers cannot be parameterised. Every component here is derived from
    // a Date and formatted numerically, so nothing user-supplied reaches the SQL.
    await prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "${name}" PARTITION OF "${parent}" `
      + `FOR VALUES FROM ('${boundUtc(start)}') TO ('${boundUtc(end)}')`,
    );
    created.push(name);
  }
  return created;
}

/**
 * Partitions at BOOT (audit 2026-10-03, INGEST-2 / DATA-2). Until this
 * existed the only creator was the 1st/15th cron with `fill=0s`, and the
 * migrations ship only `2026_08` / `2026_09`: a customer installed on the 3rd
 * of a later month refused every reading until the 15th, and only if the
 * machine was up at 00:05 then. Called from `app.ts` right after the job
 * runner starts (and independently of whether it started), and from the
 * installers through the bootstrap migration. Idempotent; never throws — a
 * failure is logged loudly and the cron keeps trying.
 */
export async function ensurePartitionsAtBoot(
  log: { info: (o: unknown, m: string) => void; error: (o: unknown, m: string) => void },
): Promise<string[]> {
  try {
    const settings = await retentionSettings();
    const names = await ensurePartitions(settings.monthsAhead);
    log.info({ partitions: names }, 'telemetry partitions ensured at boot');
    return names;
  } catch (err) {
    log.error({ err }, 'telemetry partitions could NOT be ensured at boot — readings will be REFUSED once the last existing partition ends; the partition cron will retry');
    return [];
  }
}

/**
 * Drop partitions whose ENTIRE month is older than the retention window.
 *
 * Deliberately conservative. A partition covers [start, start+1month); it is
 * removed only when its upper bound is at or before the cutoff, so the current
 * month can never be dropped however the retention is configured. Dropping is
 * permanent, so the bar for touching a partition is "provably outside the
 * window", not "probably".
 */
export async function dropExpiredPartitions(
  retentionMonths: number, now = new Date(), parent = PARENT,
): Promise<string[]> {
  const cutoff = monthStart(now, -retentionMonths);
  const rows = await prisma.$queryRaw<{ name: string }[]>`
    SELECT c.relname AS name
    FROM pg_inherits i
    JOIN pg_class c  ON c.oid = i.inhrelid
    JOIN pg_class p  ON p.oid = i.inhparent
    WHERE p.relname = ${parent}`;

  const dropped: string[] = [];
  for (const { name } of rows) {
    const m = /_(\d{4})_(\d{2})$/.exec(name);
    if (!m) continue;                       // not a month partition — leave it alone
    const start = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
    const end = new Date(Date.UTC(Number(m[1]), Number(m[2]), 1));
    if (end.getTime() > cutoff.getTime()) continue;   // still (partly) in window
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${name}"`);
    dropped.push(name);
    void start;
  }
  return dropped;
}

/** graphile-worker task. Registered as `telemetry_partition_maintenance`. */
export const telemetryPartitionTask = async (
  _payload: unknown,
  helpers?: { logger?: { info: (m: string) => void; error: (m: string) => void } },
): Promise<void> => {
  const log = helpers?.logger;
  const settings = await retentionSettings();

  try {
    const created = await ensurePartitions(settings.monthsAhead);
    log?.info(`telemetry partitions ensured through ${created[created.length - 1]}`);
  } catch (err) {
    // Loud on purpose. A failure here is not cosmetic — when the last partition
    // is passed, every insert is rejected and telemetry stops arriving.
    log?.error(
      `FAILED to ensure telemetry partitions — ingestion will STOP once the last `
      + `existing partition is passed: ${(err as Error).message}`,
    );
    throw err;
  }

  if (!settings.dropEnabled) return;
  try {
    const dropped = await dropExpiredPartitions(settings.retentionMonths);
    if (dropped.length > 0) log?.info(`dropped expired telemetry partitions: ${dropped.join(', ')}`);
  } catch (err) {
    // Non-fatal: failing to reclaim space is far less serious than failing to
    // create partitions, and must not mask a successful ensure above.
    log?.error(`failed to drop expired telemetry partitions: ${(err as Error).message}`);
  }
};
