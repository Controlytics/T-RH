import { randomUUID } from 'node:crypto';
import { setMaxListeners } from 'node:events';
import type { FastifyBaseLogger } from 'fastify';
import type { Prisma } from '@prisma/client';
import { coerceModbusRegisterMap, MODBUS_INTERVAL, MODBUS_UNIT_ID, type ModbusRegisterMap } from '@digilog/shared';
import { prisma } from '../../lib/prisma.js';
import { auditLog, type AuditTx } from '../../lib/audit.js';
import { logger } from '../../lib/logger.js';
import { ingestPayload, safeWriteDeadLetters } from '../instruments/ingest-core.js';
import type { IngestIdentity } from '../instruments/ingest-auth.js';
import { loadModbusReaderConfig, MODBUS_READER_CONFIG_KEY, type ModbusReaderConfig } from './config.js';
import { checkModbusAddressAllowed } from './address.js';
import { readDevice, type ReadResult } from './protocol/index.js';

/**
 * THE READER (TCP/IP instruments, Part 2 — spec §7): this server reads every
 * TCP/IP (Modbus) instrument on its profile's interval and feeds the readings
 * into the SAME ingest path a pushing device uses.
 *
 * Two halves, deliberately separate:
 *
 *  - `readOnce(instrumentId)` is ONE read, start to finish, and it decides
 *    everything afresh: it loads the instrument, its profile and Configuration
 *    → TCP/IP Reading from the database on EVERY call, so an instrument
 *    disabled, a map emptied, an address moved out of the device networks or
 *    reading switched OFF is refused BEFORE a socket is opened — whatever the
 *    schedule still says. It is what the scheduler runs, and what the tests run.
 *
 *  - The scheduler only decides WHEN: a one-second tick, each instrument on
 *    its own slot (`phaseFor` spreads them across the interval, so a hundred
 *    devices on one interval are not read in the same second), at most
 *    `MAX_READS_IN_FLIGHT` reads at once and ONE per host:port, and an
 *    instrument whose previous read is still running skips that tick (no queue
 *    builds up). A device that is "not answering" is tried only every
 *    `max(interval, FAILING_RETRY_SEC)` until a read is stored, so dead devices
 *    cannot hold the slots healthy ones need. Every `RELOAD_CHECK_MS` it asks
 *    the database whether anything it reads from changed, and rebuilds the
 *    schedule only then.
 *
 * Failures (§7.5): a failed read stores nothing. The status row counts the run
 * of failures; the THIRD in a row sets `failingSince` (= the first of them) and
 * writes the SYSTEM audit row MODBUS_DEVICE_NOT_ANSWERING; the first success
 * after that clears it and writes MODBUS_DEVICE_ANSWERING. One or two misses
 * write no audit row — a lossy link must not write thousands of chained rows a
 * day. The status change and its audit row are ONE transaction.
 *
 * Only the DEVICE's failures count (ledger Ruling T9-1). When the device
 * answered but this server could not store the readings (`ingestPayload` not
 * ok — WRITE_FAILED and the like) that is a server fault: logged at ERROR and
 * recorded as the status row's last error, never a transition row — "stopped
 * answering" would be a false §11 statement about a device that did answer.
 * Because it DID answer, it resets a run of device failures that has not yet
 * reached "not answering" (final review F-4, overturning Ruling T9-3); once
 * the device is "not answering", only a stored read ends that.
 *
 * `stop()` is the only path that abandons a read: it aborts the socket, and a
 * read that finishes after the abort writes nothing — no telemetry, no status,
 * no audit row. Switching reading OFF empties the schedule at the next reload
 * but lets a read already in flight finish and be stored.
 */

/** Consecutive failed reads that make a device "not answering" (§7.5). */
export const NOT_ANSWERING_AFTER = 3;
/** Reads in flight at once across every device (§7.3). */
export const MAX_READS_IN_FLIGHT = 16;
/** The scheduler's tick. */
export const TICK_MS = 1000;
/** How often the Reader asks whether its inputs changed (§7.3). */
export const RELOAD_CHECK_MS = 5000;
/**
 * A device that is "not answering" (`failingSince` set) is read every
 * `max(interval, FAILING_RETRY_SEC)` seconds until it answers (final review
 * F-5). A dead device holds a read slot for the whole connect timeout (3 s), so
 * at the 10 s minimum about 54 of them would fill all 16 slots and healthy
 * devices on other switches would queue behind them. The debounce needs three
 * consecutive misses, not a full-rate stream of them; the cost is that a
 * recovery is noticed up to a minute later.
 */
export const FAILING_RETRY_SEC = 60;

const TRANSPORT = 'modbus';
const READ_BY_SERVER = 'server';

/**
 * Why an instrument is not read. `SERVER_READING_OFF`, `INSTRUMENT_DISABLED`,
 * `NO_REGISTER_MAP` and `NO_ADDRESS` are the status route's `notReadReason`
 * words (spec §9); `INVALID_CONFIG` is a stored row no route could have
 * written (a unit id, port, interval or map outside its rules — hand-edited),
 * logged as a warning; `STOPPED` is a read abandoned by `stop()`.
 */
export type ReaderSkipCode =
  | 'SERVER_READING_OFF' | 'NOT_FOUND' | 'NOT_TCPIP' | 'INSTRUMENT_DISABLED' | 'PROFILE_DISABLED'
  | 'NO_ADDRESS' | 'NO_REGISTER_MAP' | 'INVALID_CONFIG' | 'ADDRESS_NOT_ALLOWED' | 'STOPPED';

/**
 * `failing: true` (present only when true) = after this read the status row says
 * the device is "not answering" (`failingSince` set) — what the scheduler backs
 * off on (FAILING_RETRY_SEC). A stored read is never failing.
 */
export type ReadOnceResult = { outcome: 'stored' | 'failed' | 'skipped'; code?: string; failing?: true };

const INSTRUMENT_SELECT = {
  id: true,
  code: true,
  isActive: true,
  deviceCertIssueId: true,
  modbusHost: true,
  modbusPort: true,
  modbusRegisters: true,
  // The Slave ID and read interval are the INSTRUMENT's (CR-1, 2026-11-02); the
  // profile says only whether it is a TCP/IP one and whether it is enabled.
  modbusUnitId: true,
  modbusIntervalSec: true,
  profile: { select: { isActive: true, connection: true } },
} satisfies Prisma.InstrumentSelect;

type InstrumentRow = Prisma.InstrumentGetPayload<{ select: typeof INSTRUMENT_SELECT }>;

type ReadTarget =
  | { ok: true; host: string; port: number; unitId: number; intervalSec: number; map: ModbusRegisterMap }
  | { ok: false; code: ReaderSkipCode; detail: string };

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/**
 * A unit (Slave) id this server may send (0..255) — the Reader's rule for the
 * STORED value (final review F-6), also applied by Test connection to the one it
 * is sent, so nothing outside the range reaches a socket. The stored value is
 * the INSTRUMENT's since 2026-11-02 (CR-1).
 */
export const isSendableUnitId = (v: unknown): v is number => isInt(v, MODBUS_UNIT_ID.min, MODBUS_UNIT_ID.max);
const unitIdRefusal = (v: unknown): string =>
  `The instrument's Slave ID ${String(v)} is not ${MODBUS_UNIT_ID.min} to ${MODBUS_UNIT_ID.max}.`;
/** A STORED read interval the Reader reads at (10..3600 s) — also the status route's rule for an expected count. */
export const isReadInterval = (v: unknown): v is number => isInt(v, MODBUS_INTERVAL.min, MODBUS_INTERVAL.max);

/**
 * Is this instrument read, and with what? The ONE answer to spec §7.1, used by
 * `readOnce` before every read and by the scheduler at every reload. Nothing
 * here trusts the row: a value a route could never have stored (unit id 300,
 * port 0, a map that fails the shared schema) is `INVALID_CONFIG`, never passed
 * to `readDevice` — which would reject it (final review F-6) and the read would
 * be logged as a thrown error instead of the stored row being named.
 */
function readTarget(row: InstrumentRow, config: ModbusReaderConfig, opts: { allowLoopbackForTests?: boolean }): ReadTarget {
  const p = row.profile;
  if (!config.serverReadingEnabled) return { ok: false, code: 'SERVER_READING_OFF', detail: 'Reading devices from this server is off.' };
  if (p.connection !== 'MODBUS_TCP') return { ok: false, code: 'NOT_TCPIP', detail: 'The instrument\'s profile is not a TCP/IP profile.' };
  if (!row.isActive) return { ok: false, code: 'INSTRUMENT_DISABLED', detail: 'The instrument is disabled.' };
  if (!p.isActive) return { ok: false, code: 'PROFILE_DISABLED', detail: 'The instrument\'s profile is disabled.' };
  if (row.modbusHost === null || row.modbusPort === null) return { ok: false, code: 'NO_ADDRESS', detail: 'The instrument has no IP address or port.' };
  if (!isInt(row.modbusPort, 1, 65535)) return { ok: false, code: 'INVALID_CONFIG', detail: `Stored port ${row.modbusPort} is not 1 to 65535.` };
  if (!isSendableUnitId(row.modbusUnitId)) return { ok: false, code: 'INVALID_CONFIG', detail: unitIdRefusal(row.modbusUnitId) };
  if (!isReadInterval(row.modbusIntervalSec)) {
    return { ok: false, code: 'INVALID_CONFIG', detail: `The instrument's read interval ${String(row.modbusIntervalSec)} s is not ${MODBUS_INTERVAL.min} to ${MODBUS_INTERVAL.max} s.` };
  }
  const stored = row.modbusRegisters;
  const map = coerceModbusRegisterMap(stored);
  if (map.length === 0) {
    // Empty is a normal state (an instrument created before its map is known);
    // anything else that reads as no map is a stored value the schema refuses.
    if (stored === null || (Array.isArray(stored) && stored.length === 0)) {
      return { ok: false, code: 'NO_REGISTER_MAP', detail: 'The instrument has no register map.' };
    }
    return { ok: false, code: 'INVALID_CONFIG', detail: 'The stored register map does not pass the register-map rules.' };
  }
  const address = checkModbusAddressAllowed(row.modbusHost, row.modbusPort, config.deviceNetworks, opts);
  if (!address.ok) return { ok: false, code: 'ADDRESS_NOT_ALLOWED', detail: address.message };
  return { ok: true, host: row.modbusHost, port: row.modbusPort, unitId: row.modbusUnitId, intervalSec: row.modbusIntervalSec, map };
}

/**
 * Is this STORED instrument read right now, and if not, why? The status route's
 * answer (spec §9) from the one rule (`readTarget`) the Reader itself runs —
 * never a second copy. `null` = no such instrument.
 */
export async function explainReadTarget(
  instrumentId: string,
  opts: { allowLoopbackForTests?: boolean } = {},
): Promise<{ ok: true } | { ok: false; code: ReaderSkipCode; detail: string } | null> {
  const config = await loadModbusReaderConfig();
  const row = await prisma.instrument.findUnique({ where: { id: instrumentId }, select: INSTRUMENT_SELECT });
  if (!row) return null;
  const target = readTarget(row, config, opts);
  return target.ok ? { ok: true } : { ok: false, code: target.code, detail: target.detail };
}

const isAbortError = (err: unknown): boolean => err instanceof Error && err.name === 'AbortError';
/** Keeps a code inside `signature_meaning`'s VARCHAR(255) next to the fixed text. */
const clip = (s: string) => (s.length <= 60 ? s : `${s.slice(0, 60)}…`);

/**
 * Read one instrument once — the exact path the scheduler runs.
 *
 * `skipped` = nothing was attempted (the code says why; no socket was opened,
 * nothing was written). `failed` = the device (or the write of its readings)
 * failed; the status row has the failure. `stored` = the device answered and
 * its readings went through `ingestPayload` (`code: 'NO_VALUE_STORED'` when it
 * answered but the decoder refused every value — each refusal is a dead letter).
 *
 * Throws only on a programming error or a database failure of the status
 * write; the scheduler logs those. `signal` is the scheduler's stop(): an abort
 * before the first write means nothing is written at all.
 */
export async function readOnce(
  instrumentId: string,
  opts: { allowLoopbackForTests?: boolean; signal?: AbortSignal } = {},
): Promise<ReadOnceResult> {
  const { signal } = opts;
  const skipped = (code: ReaderSkipCode): ReadOnceResult => ({ outcome: 'skipped', code });
  if (signal?.aborted) return skipped('STOPPED');

  const config = await loadModbusReaderConfig();
  const row = await prisma.instrument.findUnique({ where: { id: instrumentId }, select: INSTRUMENT_SELECT });
  if (!row) return skipped('NOT_FOUND');
  // Every "is it read?" rule — reading OFF included — is readTarget's, the one
  // place the reload asks too.
  const target = readTarget(row, config, opts);
  if (!target.ok) {
    if (target.code === 'INVALID_CONFIG') {
      logger.warn({ instrumentId, code: row.code, reason: target.detail },
        '[modbus-reader] stored TCP/IP configuration is not valid — instrument not read');
    }
    return skipped(target.code);
  }
  if (signal?.aborted) return skipped('STOPPED');

  const startedAt = new Date();
  let result: ReadResult;
  try {
    result = await readDevice({ host: target.host, port: target.port, unitId: target.unitId, map: target.map, signal });
  } catch (err) {
    if (isAbortError(err)) return skipped('STOPPED');
    throw err; // a programming error: surfaced, never turned into a quiet failure
  }
  // stop() abandons: a read that came back after it writes nothing.
  if (signal?.aborted) return skipped('STOPPED');

  if (!result.ok) {
    const failing = await recordFailure(row, target, startedAt, result.code, result.message);
    return { outcome: 'failed', code: result.code, ...(failing ? { failing: true as const } : {}) };
  }

  if (result.rejected.length > 0) {
    // ONE dead letter per read, naming every refused key with its reason and
    // raw words (Ruling T9-2) — the ingest core's per-request rule. One row
    // per key per read would be ~8,640 rows a day for a single dead FLOAT32
    // probe at the 10 s minimum interval.
    const n = result.rejected.length;
    await safeWriteDeadLetters([{
      id: randomUUID(), instrumentId: row.id, transport: TRANSPORT,
      reason: `${n} Modbus key${n === 1 ? '' : 's'} not stored: `
        + result.rejected.map((r) => `"${r.key}" — ${r.reason}`).join('; '),
      rawPayload: null,
    }]);
  }

  // The readings, as a device would have sent them: a PROTOTYPE-LESS object so
  // a key named `__proto__` stays a key, and `ts` = the moment the read began
  // (spec §10 — a reading's time is when it was taken, not when it was stored).
  const payload: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(result.values)) payload[key] = value;
  payload.ts = startedAt.getTime();
  const identity: IngestIdentity = {
    id: row.id, code: row.code,
    isGateway: false, // a TCP/IP instrument is never a gateway; hard-coded so no stored flag can reach the fan-out
    deviceCert: { required: false, issueId: row.deviceCertIssueId },
  };
  const ingested = await ingestPayload({
    identity, raw: Buffer.from(JSON.stringify(payload), 'utf8'), transport: TRANSPORT, lastSeenVia: 'polled',
  });
  if (!ingested.ok) {
    // The device answered; this server could not store what it said. A server
    // fault (spec §7.4), logged and recorded as the last error — NOT a device
    // failure (Ruling T9-1, departing from §7.4's "counted as a failed read").
    logger.error({ instrumentId: row.id, code: row.code, outcome: ingested.code, message: ingested.message },
      '[modbus-reader] the device answered but its readings were not stored');
    const failing = await recordStorageFailure(row, startedAt, ingested.code, ingested.message);
    return { outcome: 'failed', code: ingested.code, ...(failing ? { failing: true as const } : {}) };
  }
  await recordSuccess(row, target, startedAt);
  if (ingested.accepted === 0) {
    logger.warn({ instrumentId: row.id, code: row.code, rejected: result.rejected.length },
      '[modbus-reader] the device answered but every value was refused — see its dead letters');
    return { outcome: 'stored', code: 'NO_VALUE_STORED' };
  }
  return { outcome: 'stored' };
}

interface StatusBefore {
  consecutiveFailures: number;
  failingSince: Date | null;
  failureRunStartedAt: Date | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
}

/** The status row, created if missing, LOCKED for the rest of the transaction. */
async function lockStatus(tx: AuditTx, instrumentId: string): Promise<StatusBefore> {
  await tx.$executeRaw`
    INSERT INTO modbus_poll_status (instrument_id, updated_at) VALUES (${instrumentId}, now())
    ON CONFLICT (instrument_id) DO NOTHING`;
  const rows = await tx.$queryRaw<StatusBefore[]>`
    SELECT consecutive_failures AS "consecutiveFailures", failing_since AS "failingSince",
           failure_run_started_at AS "failureRunStartedAt",
           last_error_code AS "lastErrorCode", last_error_message AS "lastErrorMessage"
    FROM modbus_poll_status WHERE instrument_id = ${instrumentId} FOR UPDATE`;
  const row = rows[0];
  if (!row) throw new Error(`modbus_poll_status row for ${instrumentId} vanished inside its own transaction`);
  return row;
}

type ReadableTarget = Extract<ReadTarget, { ok: true }>;

/** Records a failed read; true when the device is "not answering" after it. */
async function recordFailure(row: InstrumentRow, target: ReadableTarget, at: Date, code: string, message: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const before = await lockStatus(tx, row.id);
    const failures = before.consecutiveFailures + 1;
    const runStartedAt = before.consecutiveFailures === 0 || !before.failureRunStartedAt ? at : before.failureRunStartedAt;
    const becomesFailing = before.failingSince === null && failures >= NOT_ANSWERING_AFTER;
    const failingSince = before.failingSince ?? (becomesFailing ? runStartedAt : null);
    await tx.modbusPollStatus.update({
      where: { instrumentId: row.id },
      data: {
        readBy: READ_BY_SERVER, lastAttemptAt: at, consecutiveFailures: failures,
        failureRunStartedAt: runStartedAt, failingSince,
        lastErrorCode: code, lastErrorMessage: message, lastErrorAt: at,
      },
    });
    if (becomesFailing) {
      await auditLog({
        action: 'MODBUS_DEVICE_NOT_ANSWERING', targetType: 'Instrument', targetId: row.id,
        afterValue: {
          code: row.code, host: target.host, port: target.port, unitId: target.unitId,
          reason: message, errorCode: code,
          failingSince: runStartedAt.toISOString(), consecutiveFailures: failures, readBy: READ_BY_SERVER,
        },
        reason: message,
        signatureMeaning: `TCP/IP instrument "${clip(row.code)}" stopped answering the server's reads`,
      }, tx);
    }
    return failingSince !== null;
  });
}

/**
 * The device answered and this server could not store its readings (Ruling
 * T9-1): the attempt and the error are recorded and no audit row is written —
 * it is not a device failure, so it never advances the run of failures.
 *
 * It BREAKS that run (final review F-4, overturning Ruling T9-3): the device
 * answered, so while it is not yet "not answering" the count and the run's
 * start go back to zero. Left alone, miss · miss · storage failure · miss
 * would have written "stopped answering" across a read the device answered —
 * a false §11 row. Once it IS "not answering" (`failingSince` set) nothing
 * moves: only a STORED read ends that state and writes "answering again", and
 * no reading was stored here. Returns true when the device is still "not
 * answering" — the scheduler keeps backing off until a stored read.
 */
async function recordStorageFailure(row: InstrumentRow, at: Date, code: string, message: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const before = await lockStatus(tx, row.id);
    await tx.modbusPollStatus.update({
      where: { instrumentId: row.id },
      data: {
        readBy: READ_BY_SERVER, lastAttemptAt: at, lastErrorCode: code, lastErrorMessage: message, lastErrorAt: at,
        ...(before.failingSince === null ? { consecutiveFailures: 0, failureRunStartedAt: null } : {}),
      },
    });
    return before.failingSince !== null;
  });
}

async function recordSuccess(row: InstrumentRow, target: ReadableTarget, at: Date): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const before = await lockStatus(tx, row.id);
    await tx.modbusPollStatus.update({
      where: { instrumentId: row.id },
      data: {
        readBy: READ_BY_SERVER, lastAttemptAt: at, lastSuccessAt: at,
        consecutiveFailures: 0, failingSince: null, failureRunStartedAt: null,
      },
    });
    if (before.failingSince !== null) {
      // The gap: `from` = the first missed read, `to` = this read, the one that
      // answered. (`to` is not "the last missed read": since Ruling T9-1 the
      // last error may be a storage failure, so `lastErrorAt` no longer marks
      // the device's last miss.)
      await auditLog({
        action: 'MODBUS_DEVICE_ANSWERING', targetType: 'Instrument', targetId: row.id,
        beforeValue: {
          code: row.code, failingSince: before.failingSince.toISOString(),
          consecutiveFailures: before.consecutiveFailures,
          lastErrorCode: before.lastErrorCode, lastErrorMessage: before.lastErrorMessage,
        },
        afterValue: {
          code: row.code, host: target.host, port: target.port,
          missed: before.consecutiveFailures,
          from: before.failingSince.toISOString(), to: at.toISOString(), readBy: READ_BY_SERVER,
        },
        signatureMeaning: `TCP/IP instrument "${clip(row.code)}" answering the server's reads again`,
      }, tx);
    }
  });
}

// ─── the schedule ────────────────────────────────────────────────────────────

export interface ScheduleEntry {
  instrumentId: string;
  /** `host:port` — at most one read in flight per address. */
  address: string;
  intervalSec: number;
  /** Seconds into each interval this instrument is read at (`phaseFor`). */
  phaseSec: number;
  /** Epoch ms of its next read. */
  nextDueAt: number;
}

/** A stable offset of `id` inside the interval (FNV-1a), so reads spread across it. */
export function phaseFor(instrumentId: string, intervalSec: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < instrumentId.length; i++) {
    h ^= instrumentId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % intervalSec;
}

/** The first slot on the instrument's grid (whole seconds `k·interval + phase`) at or after `nowMs`. */
export function firstSlotAtOrAfter(nowMs: number, intervalSec: number, phaseSec: number): number {
  const k = Math.ceil((nowMs / 1000 - phaseSec) / intervalSec);
  return (k * intervalSec + phaseSec) * 1000;
}

/**
 * Which due entries start now, which skip — PURE, so the caps are tested
 * without a database (the partial unique index makes two instruments on one
 * host:port impossible with real rows).
 *
 *  - an instrument whose previous read is still running SKIPS this slot (the
 *    caller moves it to its next slot; no catch-up, no queue);
 *  - an entry blocked by the global cap or a busy address WAITS (stays due,
 *    tried again next tick) — it lost the race, not its turn;
 *  - the most overdue go first, so a saturated Reader cannot starve one device.
 */
export function pickDue(
  entries: readonly ScheduleEntry[],
  nowMs: number,
  running: { ids: ReadonlySet<string>; addresses: ReadonlySet<string> },
  maxInFlight: number,
): { start: ScheduleEntry[]; skip: ScheduleEntry[] } {
  const start: ScheduleEntry[] = [];
  const skip: ScheduleEntry[] = [];
  let free = maxInFlight - running.ids.size;
  const claimed = new Set<string>();
  const due = entries.filter((e) => e.nextDueAt <= nowMs).sort((a, b) => a.nextDueAt - b.nextDueAt);
  for (const e of due) {
    if (running.ids.has(e.instrumentId)) {
      skip.push(e);
      continue;
    }
    if (free <= 0 || running.addresses.has(e.address) || claimed.has(e.address)) continue;
    start.push(e);
    claimed.add(e.address);
    free--;
  }
  return { start, skip };
}

type ReaderLog = Pick<FastifyBaseLogger, 'debug' | 'info' | 'warn' | 'error'>;

export interface ModbusReaderCore {
  /** Rebuild the schedule if anything it reads from changed; true when it did. */
  reload(): Promise<boolean>;
  /** Start every read that is due now. */
  tick(): void;
  /** A copy of the schedule. */
  schedule(): ScheduleEntry[];
  /** Reads running now. */
  inFlight(): number;
  /** Abort every read in flight and wait for them; nothing runs afterwards. */
  stop(): Promise<void>;
}

/**
 * The scheduler without its timers: `now` and `read` are injectable so a test
 * can force a tick at a chosen instant. `startModbusReader` wraps it in real,
 * unref'd intervals. Exported for tests.
 */
export function createModbusReader(opts: {
  log: ReaderLog;
  allowLoopbackForTests?: boolean;
  now?: () => number;
  read?: (instrumentId: string, signal: AbortSignal) => Promise<ReadOnceResult>;
}): ModbusReaderCore {
  const log = opts.log;
  const now = opts.now ?? Date.now;
  const read = opts.read
    ?? ((id: string, signal: AbortSignal) => readOnce(id, { allowLoopbackForTests: opts.allowLoopbackForTests, signal }));
  const controller = new AbortController();
  // Up to MAX_READS_IN_FLIGHT reads listen on the one signal at once.
  setMaxListeners(MAX_READS_IN_FLIGHT + 4, controller.signal);

  let stopped = false;
  let signature: string | null = null;
  let entries = new Map<string, ScheduleEntry>();
  let notRead = new Map<string, ReaderSkipCode>();
  let readingWasOn: boolean | null = null;
  let reloading: Promise<boolean> | null = null;
  const runningIds = new Set<string>();
  const runningAddresses = new Set<string>();
  const inFlight = new Set<Promise<void>>();

  /**
   * What the schedule is built from, in one string: the TCP/IP instruments'
   * count and newest `updated_at`, a hash of every TCP/IP instrument's Slave ID
   * and read interval, the TCP/IP profiles' newest `updated_at`, and the
   * `modbus-reader` row's `updated_at` AND value (`system_config.updated_at` is
   * a column default, not `@updatedAt`: a write that does not set it would
   * otherwise go unseen). The count catches a delete, which moves no max. The
   * hash (CR-1, 2026-11-02 — the two became the instrument's) catches a change
   * to either that did not go through Prisma, which `updated_at` would miss: they
   * decide what is read and how often. A successful read moves
   * `instruments.updated_at` (last-seen), so a rebuild after reads is normal —
   * it keeps every entry's slot unless its interval changed.
   */
  async function readSignature(): Promise<string> {
    const [inst, reading, prof, cfg] = await Promise.all([
      prisma.instrument.aggregate({ where: { profile: { connection: 'MODBUS_TCP' } }, _count: { _all: true }, _max: { updatedAt: true } }),
      prisma.$queryRaw<Array<{ h: string | null }>>`
        SELECT md5(string_agg(
                 i.id || ':' || coalesce(i.modbus_unit_id::text, '-') || ':' || coalesce(i.modbus_interval_sec::text, '-'),
                 ',' ORDER BY i.id)) AS h
          FROM instruments i JOIN instrument_profiles p ON p.id = i.profile_id
         WHERE p.connection = 'MODBUS_TCP'`,
      prisma.instrumentProfile.aggregate({ where: { connection: 'MODBUS_TCP' }, _count: { _all: true }, _max: { updatedAt: true } }),
      prisma.systemConfig.findUnique({ where: { configKey: MODBUS_READER_CONFIG_KEY }, select: { updatedAt: true, configValue: true } }),
    ]);
    return JSON.stringify([
      inst._count._all, inst._max.updatedAt?.toISOString() ?? null, reading[0]?.h ?? null,
      prof._count._all, prof._max.updatedAt?.toISOString() ?? null,
      cfg ? cfg.updatedAt.toISOString() : null, cfg ? cfg.configValue : null,
    ]);
  }

  async function rebuildIfChanged(): Promise<boolean> {
    // The signature is read BEFORE the data, so a change landing between the
    // two is seen again at the next check rather than lost.
    const sig = await readSignature();
    if (stopped || sig === signature) return false;
    const config = await loadModbusReaderConfig();
    // Reading OFF is decided by readTarget below, as in readOnce — one rule.
    const rows = await prisma.instrument.findMany({
      where: { isActive: true, profile: { connection: 'MODBUS_TCP', isActive: true } },
      select: INSTRUMENT_SELECT,
    });
    if (stopped) return false;

    const t = now();
    const next = new Map<string, ScheduleEntry>();
    const nextNotRead = new Map<string, ReaderSkipCode>();
    for (const row of rows) {
      const target = readTarget(row, config, { allowLoopbackForTests: opts.allowLoopbackForTests });
      if (!target.ok) {
        nextNotRead.set(row.id, target.code);
        // Said once per change, not at every rebuild: an instrument somebody
        // configured that this server will not read.
        if (notRead.get(row.id) !== target.code && (target.code === 'INVALID_CONFIG' || target.code === 'ADDRESS_NOT_ALLOWED')) {
          log.warn({ instrumentId: row.id, code: row.code, why: target.code, reason: target.detail },
            '[modbus-reader] TCP/IP instrument not read');
        }
        continue;
      }
      const address = `${target.host}:${target.port}`;
      const prev = entries.get(row.id);
      if (prev && prev.intervalSec === target.intervalSec) {
        next.set(row.id, { ...prev, address });
      } else {
        const phaseSec = phaseFor(row.id, target.intervalSec);
        next.set(row.id, {
          instrumentId: row.id, address, intervalSec: target.intervalSec, phaseSec,
          nextDueAt: firstSlotAtOrAfter(t, target.intervalSec, phaseSec),
        });
      }
    }
    if (readingWasOn !== config.serverReadingEnabled) {
      log.info({ instruments: next.size },
        config.serverReadingEnabled
          ? '[modbus-reader] reading TCP/IP instruments from this server'
          : '[modbus-reader] reading devices from this server is OFF — nothing is scheduled');
      readingWasOn = config.serverReadingEnabled;
    }
    entries = next;
    notRead = nextNotRead;
    signature = sig;
    return true;
  }

  function launch(e: ScheduleEntry, startedAt: number): void {
    runningIds.add(e.instrumentId);
    runningAddresses.add(e.address);
    const holder: { p?: Promise<void> } = {};
    holder.p = (async () => {
      try {
        const r = await read(e.instrumentId, controller.signal);
        if (r.outcome !== 'stored') log.debug({ instrumentId: e.instrumentId, ...r }, '[modbus-reader] read');
        if (r.failing && !stopped) {
          // "Not answering": the next attempt is max(interval, FAILING_RETRY_SEC)
          // after this one started (final review F-5), not the next slot — until
          // a read is stored, after which tick() puts it back on its own grid.
          // The entry is looked up AGAIN: a reload during the read replaced the
          // object this closure holds.
          const current = entries.get(e.instrumentId);
          if (current) current.nextDueAt = Math.max(current.nextDueAt, startedAt + Math.max(current.intervalSec, FAILING_RETRY_SEC) * 1000);
        }
      } catch (err) {
        log.error({ err, instrumentId: e.instrumentId }, '[modbus-reader] read threw — nothing was recorded for it');
      } finally {
        runningIds.delete(e.instrumentId);
        runningAddresses.delete(e.address);
        if (holder.p) inFlight.delete(holder.p);
      }
    })();
    inFlight.add(holder.p);
  }

  return {
    reload(): Promise<boolean> {
      if (stopped) return Promise.resolve(false);
      // One reload at a time: a check that finds one running shares its answer.
      if (reloading) return reloading;
      const p = rebuildIfChanged().finally(() => { reloading = null; });
      reloading = p;
      return p;
    },
    tick(): void {
      if (stopped) return;
      const t = now();
      const { start, skip } = pickDue([...entries.values()], t, { ids: runningIds, addresses: runningAddresses }, MAX_READS_IN_FLIGHT);
      for (const e of skip) {
        e.nextDueAt = firstSlotAtOrAfter(t + 1, e.intervalSec, e.phaseSec);
        log.debug({ instrumentId: e.instrumentId }, '[modbus-reader] previous read still running — this slot skipped');
      }
      for (const e of start) {
        e.nextDueAt = firstSlotAtOrAfter(t + 1, e.intervalSec, e.phaseSec);
        launch(e, t);
      }
    },
    schedule: () => [...entries.values()].map((e) => ({ ...e })),
    inFlight: () => inFlight.size,
    async stop(): Promise<void> {
      if (!stopped) {
        stopped = true;
        controller.abort();
      }
      await Promise.allSettled([...inFlight, ...(reloading ? [reloading] : [])]);
    },
  };
}

export interface ModbusReaderHandle {
  stop(): Promise<void>;
}

/**
 * Start the Reader (app.ts, after the MQTT bridge; never in the e2e app). Its
 * two timers are unref'd — they never keep the process alive — and every async
 * path inside them is caught and logged: an unhandled rejection would take the
 * API down. `stop()` (shutdown(), before app.close()) clears both timers, then
 * aborts and awaits every read in flight.
 */
export function startModbusReader(opts: { log: FastifyBaseLogger; allowLoopbackForTests?: boolean }): ModbusReaderHandle {
  const log = opts.log;
  const core = createModbusReader({ log, allowLoopbackForTests: opts.allowLoopbackForTests });
  const reload = () => {
    core.reload().catch((err: unknown) => {
      log.error({ err }, '[modbus-reader] reload failed — the schedule stays as it was until the next check');
    });
  };
  reload();
  const reloadTimer = setInterval(reload, RELOAD_CHECK_MS);
  const tickTimer = setInterval(() => {
    try {
      core.tick();
    } catch (err) {
      log.error({ err }, '[modbus-reader] tick failed');
    }
  }, TICK_MS);
  reloadTimer.unref();
  tickTimer.unref();
  return {
    async stop(): Promise<void> {
      clearInterval(tickTimer);
      clearInterval(reloadTimer);
      await core.stop();
    },
  };
}
