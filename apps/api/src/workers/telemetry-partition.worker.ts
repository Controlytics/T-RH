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
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { auditLog } from '../lib/audit.js';
import { configRepository } from '../modules/config/config.repository.js';
import { TELEMETRY_RETENTION_DEFAULTS, type TelemetryRetentionSettings } from '../modules/config/defs/telemetry-retention.def.js';

const PARENT = 'instrument_telemetry_history';

export type RetentionSettings = TelemetryRetentionSettings;

/** The def's declared defaults — ONE definition (audit 2026-10-03, DATA-9:
 *  this comment used to say "must match telemetry-retention.def.ts", and that
 *  def did not exist, so the switch could only be flipped by editing
 *  system_config by hand). */
const DEFAULTS: RetentionSettings = TELEMETRY_RETENTION_DEFAULTS;

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
 * The DDL for ONE month's partition, for a caller that must run it inside its
 * own transaction (the backup restore, audit 2026-10-03 DATA-12 — an archive
 * holding a month whose partition the target lacks used to roll the whole
 * restore back with "no partition … found for row"). Same statement
 * `ensurePartitions` runs; one definition.
 */
export function partitionDdl(monthOf: Date, parent = PARENT): { name: string; sql: string } {
  const start = monthStart(monthOf, 0);
  const end = monthStart(monthOf, 1);
  const name = partitionName(start, parent);
  return {
    name,
    sql: `CREATE TABLE IF NOT EXISTS "${name}" PARTITION OF "${parent}" `
      + `FOR VALUES FROM ('${boundUtc(start)}') TO ('${boundUtc(end)}')`,
  };
}

/**
 * Create the current month plus `monthsAhead` following months.
 * Idempotent — CREATE TABLE IF NOT EXISTS, safe to run repeatedly.
 */
export async function ensurePartitions(
  monthsAhead: number, now = new Date(), parent = PARENT,
): Promise<string[]> {
  const created: string[] = [];
  for (let i = 0; i <= monthsAhead; i++) {
    // Identifiers cannot be parameterised. Every component here is derived from
    // a Date and formatted numerically, so nothing user-supplied reaches the SQL.
    const { name, sql } = partitionDdl(monthStart(now, i), parent);
    await prisma.$executeRawUnsafe(sql);
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
    // ONE `RETENTION_EXECUTED` audit row per partition, in the SAME transaction
    // as the DROP (audit 2026-10-03, DATA-9). Until then a month of readings
    // left with only a log line, and the action was registered but never
    // written. The row count is taken inside the transaction so the number
    // recorded is the number destroyed; a SYSTEM action (no user — see
    // SYSTEM_AUDIT_ACTIONS in lib/audit.ts), the partition and its bounds in
    // the before-value, as a deletion's record should be.
    await prisma.$transaction(async (tx) => {
      const [{ n }] = await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM "${name}"`);
      const rowCount = Number(n);
      await tx.$executeRawUnsafe(`DROP TABLE IF EXISTS "${name}"`);
      await auditLog({
        action: 'RETENTION_EXECUTED',
        targetType: 'telemetry_partition',
        targetId: name,
        beforeValue: {
          name, parent, rowCount,
          from: start.toISOString(), to: end.toISOString(),
          retentionMonths, cutoff: cutoff.toISOString(),
        },
        reason: `Telemetry retention: partition entirely older than ${retentionMonths} month(s) dropped by the scheduled maintenance task`,
        signatureMeaning: `Telemetry partition ${name} (${rowCount} readings) dropped by retention`,
      }, tx);
    });
    dropped.push(name);
  }
  return dropped;
}

/**
 * Dead-letter retention (audit 2026-10-03, INGEST-10). Nothing ever deleted a
 * `dead_letters` row: the only reader is `GET /:id/dead-letters`, capped at
 * 200, and every unparseable payload writes up to 4 KB. Two bounds, both
 * applied by this task and neither a setting — a dead letter is a diagnostic
 * about a failure, not a §11 record, and a retention knob here would invite
 * the comparison with `telemetry-retention`, whose dropping ships OFF because
 * readings ARE the record:
 *
 *  - AGE: rows older than DEAD_LETTER_RETENTION_DAYS go. Thirty days is long
 *    past any investigation of a device that is still misbehaving — it will
 *    have written a fresher row by then.
 *  - COUNT: no instrument keeps more than DEAD_LETTER_MAX_PER_INSTRUMENT, the
 *    NEWEST kept. One broken device must not hold the table hostage for the
 *    rest of the fleet; the listeners' rate caps bound what it can write per
 *    minute, this bounds what survives.
 *
 * Runs on this task's cron (the 1st and 15th), so a flood is bounded between
 * runs only by the rate caps — the TCP cap added with this is what closed the
 * unbounded case. `scope` is a TEST seam: the suite shares its database with
 * every other suite's dead letters, and the count bound would otherwise prune
 * rows another file is asserting on.
 */
export const DEAD_LETTER_RETENTION_DAYS = 30;
export const DEAD_LETTER_MAX_PER_INSTRUMENT = 2_000;

export async function pruneDeadLetters(opts: {
  now?: Date; retentionDays?: number; maxPerInstrument?: number;
  /** Test seam — limit the sweep to these instruments. Omitted = the whole table. */
  scope?: string[];
} = {}): Promise<{ expired: number; overflow: number }> {
  const now = opts.now ?? new Date();
  const retentionDays = opts.retentionDays ?? DEAD_LETTER_RETENTION_DAYS;
  const maxPerInstrument = opts.maxPerInstrument ?? DEAD_LETTER_MAX_PER_INSTRUMENT;
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  const scopeSql = opts.scope
    ? Prisma.sql`WHERE instrument_id IN (${Prisma.join(opts.scope)})`
    : Prisma.empty;

  const expired = await prisma.$executeRaw`
    DELETE FROM dead_letters
    WHERE received_at < ${cutoff}
      ${opts.scope ? Prisma.sql`AND instrument_id IN (${Prisma.join(opts.scope)})` : Prisma.empty}`;

  // Newest first within each instrument; everything past the cap goes. A NULL
  // instrument_id (a row filed against no instrument) forms its own group and
  // is capped like any other.
  const overflow = await prisma.$executeRaw`
    DELETE FROM dead_letters WHERE id IN (
      SELECT id FROM (
        SELECT id, row_number() OVER (PARTITION BY instrument_id ORDER BY received_at DESC, id DESC) AS rn
        FROM dead_letters ${scopeSql}
      ) ranked
      WHERE rn > ${maxPerInstrument})`;

  return { expired, overflow };
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

  // Dead letters are swept on every run, whatever the partition settings say:
  // this is housekeeping of a diagnostic table, not retention of readings.
  // Non-fatal, like the partition drop below, and for the same reason.
  try {
    const { expired, overflow } = await pruneDeadLetters();
    if (expired > 0 || overflow > 0) log?.info(`pruned dead letters: ${expired} expired, ${overflow} over the per-instrument cap`);
  } catch (err) {
    log?.error(`failed to prune dead letters: ${(err as Error).message}`);
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
