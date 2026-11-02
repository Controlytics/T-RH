import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../../../lib/prisma.js';
import { logger } from '../../../lib/logger.js';
import { startFakeSlave, type FakeSlave } from '../../../test-support/fake-modbus-slave.js';

/**
 * TCP/IP instruments, Task 9 — the Reader (spec §7). Drives `readOnce` (the
 * exact path the scheduler runs) against an in-process fake slave on the TEST
 * database, the scheduler core with an injected clock, and `startModbusReader`
 * with its real timers once.
 *
 * Isolation: the `modbus-reader` row is set with device networks
 * `192.0.2.0/24` (TEST-NET-1, a documentation range no real device has), so
 * any TCP/IP instrument another suite left behind is outside the networks and
 * never read; this file's instruments sit on 127.0.0.1, which only
 * `allowLoopbackForTests` admits. The row is restored FIRST in afterAll.
 * The alarm enqueue is a spy: the shared test DB may already hold a pending
 * job under the same key, so the queue table cannot say whether THIS read
 * enqueued one.
 */

const { enqueueSpy } = vi.hoisted(() => ({ enqueueSpy: vi.fn(async () => true) }));
vi.mock('../../alarms/enqueue-evaluation.js', () => ({
  ALARM_EVALUATION_JOB_KEY: 'alarm_evaluation:on-ingest',
  enqueueAlarmEvaluation: (...a: unknown[]) => enqueueSpy(...(a as [])),
}));

// The ingest core, passed through — except when a test sets `ingestOutcome`
// to make this server's STORAGE fail while the device answers (Ruling T9-1).
// A test-file seam only: production code has no way to ask for a failure.
const { ingestOutcome } = vi.hoisted(() => ({ ingestOutcome: { next: null as null | Record<string, unknown> } }));
vi.mock('../../instruments/ingest-core.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../instruments/ingest-core.js')>();
  return {
    ...actual,
    ingestPayload: (args: Parameters<typeof actual.ingestPayload>[0]) =>
      (ingestOutcome.next ? Promise.resolve(ingestOutcome.next) : actual.ingestPayload(args)),
  };
});

import {
  readOnce, createModbusReader, startModbusReader, pickDue, phaseFor, firstSlotAtOrAfter,
  NOT_ANSWERING_AFTER, MAX_READS_IN_FLIGHT, type ScheduleEntry,
} from '../reader.js';

const s = Date.now();
const C = (n: string) => `MBR-${s}-${n}`;
const TEST_NETWORKS = '192.0.2.0/24';
const CONFIG_KEY = 'modbus-reader';

let profileId = '';
let profile10Id = '';
let badProfileId = '';
let readerRowBefore: { configValue: unknown; configType: string; requiresReauth: boolean; updatedAt: Date; updatedBy: string | null } | null = null;
const slaves: FakeSlave[] = [];
const instrumentIds: string[] = [];

const f32 = (v: number): [number, number] => {
  const b = Buffer.alloc(4);
  b.writeFloatBE(v);
  return [b.readUInt16BE(0), b.readUInt16BE(2)];
};
const [tHi, tLo] = f32(22.4);
const HOLDING: Record<number, number> = { 0: tHi, 1: tLo, 2: 553, 3: 1013, 4: 0, 5: 1500, 6: 1, 10: 0x7fc0, 11: 0x0000, 12: 0x7f80, 13: 0x0000 };
const INPUT: Record<number, number> = { 0: 2301 };
const SIX = [
  { key: 'Temperature', register: '40001', dataType: 'FLOAT32', byteOrder: 'ABCD', scale: 1 },
  { key: 'Humidity', register: '40003', dataType: 'UINT16', scale: 0.1 },
  { key: 'Pressure', register: '40004', dataType: 'INT16', scale: 1 },
  { key: 'Voltage', register: '30001', dataType: 'UINT16', scale: 0.1 },
  { key: 'Power', register: '40005', dataType: 'UINT32', byteOrder: 'ABCD', scale: 1 },
  { key: 'Switch', register: '40007', dataType: 'UINT16', scale: 1 },
];
const SIX_KEYS = ['Humidity', 'Power', 'Pressure', 'Switch', 'Temperature', 'Voltage'];
const EXPECTED: Record<string, number> = { Temperature: 22.4, Humidity: 55.3, Pressure: 1013, Voltage: 230.1, Power: 1500, Switch: 1 };

const logs: Array<{ level: string; args: unknown[] }> = [];
const capture = (level: string) => (...args: unknown[]) => { logs.push({ level, args }); };
const log = {
  debug: capture('debug'), info: capture('info'), warn: capture('warn'), error: capture('error'),
  fatal: capture('fatal'), trace: capture('trace'), silent: () => undefined, child: () => log, level: 'debug',
} as unknown as FastifyBaseLogger;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 5000, label = 'condition'): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function setReading(on: boolean, deviceNetworks = TEST_NETWORKS) {
  const configValue = { serverReadingEnabled: on, deviceNetworks };
  await prisma.systemConfig.upsert({
    where: { configKey: CONFIG_KEY },
    create: { configKey: CONFIG_KEY, configValue, configType: 'system', requiresReauth: false, updatedAt: new Date() },
    update: { configValue, updatedAt: new Date() },
  });
}
async function slave(opts: Parameters<typeof startFakeSlave>[0] = { holding: HOLDING, input: INPUT }) {
  const sl = await startFakeSlave(opts);
  slaves.push(sl);
  return sl;
}
/** A port nothing listens on: a slave started and closed (REFUSED comes back at once). */
async function deadPort(): Promise<number> {
  const sl = await startFakeSlave();
  await sl.close();
  return sl.port;
}
async function inst(n: string, port: number, map: unknown = SIX, extra: Record<string, unknown> = {}) {
  const row = await prisma.instrument.create({
    data: {
      name: C(n), code: C(n), profileId, modbusHost: '127.0.0.1', modbusPort: port,
      modbusRegisters: map as never, ...extra,
    },
  });
  instrumentIds.push(row.id);
  return row;
}

const history = (id: string) => prisma.$queryRaw<Array<{ key: string; value: unknown; ts: Date }>>`
  SELECT key, value, ts FROM instrument_telemetry_history WHERE instrument_id = ${id} ORDER BY key`;
const latest = (id: string) => prisma.$queryRaw<Array<{ key: string; value: unknown; ts: Date }>>`
  SELECT key, value, ts FROM instrument_telemetry_latest WHERE instrument_id = ${id} ORDER BY key`;
const status = (id: string) => prisma.modbusPollStatus.findUnique({ where: { instrumentId: id } });
const audits = (id: string) => prisma.auditTrail.findMany({
  where: { targetId: id, action: { startsWith: 'MODBUS_' } }, orderBy: { chainPosition: 'asc' },
});
const ON = { allowLoopbackForTests: true };

beforeAll(async () => {
  const row = await prisma.systemConfig.findUnique({ where: { configKey: CONFIG_KEY } });
  readerRowBefore = row
    ? { configValue: row.configValue, configType: row.configType, requiresReauth: row.requiresReauth, updatedAt: row.updatedAt, updatedBy: row.updatedBy }
    : null;
  profileId = (await prisma.instrumentProfile.create({ data: { name: `MBR Modbus ${s}`, connection: 'MODBUS_TCP', modbusIntervalSec: 60, modbusUnitId: 1 } })).id;
  profile10Id = (await prisma.instrumentProfile.create({ data: { name: `MBR Modbus 10s ${s}`, connection: 'MODBUS_TCP', modbusIntervalSec: 10, modbusUnitId: 1 } })).id;
  badProfileId = (await prisma.instrumentProfile.create({ data: { name: `MBR Modbus bad ${s}`, connection: 'MODBUS_TCP', modbusIntervalSec: 60, modbusUnitId: 300 } })).id;
});

afterAll(async () => {
  const failures: unknown[] = [];
  const step = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { failures.push(e); } };
  // The config row FIRST: a suite must hand back what it touched even while failing.
  await step(async () => {
    if (readerRowBefore) await prisma.systemConfig.update({ where: { configKey: CONFIG_KEY }, data: readerRowBefore as never });
    else await prisma.systemConfig.deleteMany({ where: { configKey: CONFIG_KEY } });
  });
  for (const sl of slaves) await step(() => sl.close());
  await step(() => prisma.$executeRaw`DELETE FROM instrument_telemetry_history WHERE instrument_id = ANY(${instrumentIds}::text[])`);
  await step(() => prisma.$executeRaw`DELETE FROM instrument_telemetry_latest WHERE instrument_id = ANY(${instrumentIds}::text[])`);
  await step(() => prisma.deadLetter.deleteMany({ where: { instrumentId: { in: instrumentIds } } }));
  await step(() => prisma.instrument.deleteMany({ where: { id: { in: instrumentIds } } }));
  await step(() => prisma.instrumentProfile.deleteMany({ where: { id: { in: [profileId, profile10Id, badProfileId].filter(Boolean) } } }));
  if (failures.length > 0) throw new AggregateError(failures, 'reader teardown failed');
});

beforeEach(async () => {
  enqueueSpy.mockClear();
  ingestOutcome.next = null;
  logs.length = 0;
  await setReading(true);
  // Each test reads only its own instrument: the earlier ones are switched off,
  // so a scheduler test's reload never picks them up.
  if (instrumentIds.length > 0) {
    await prisma.instrument.updateMany({ where: { id: { in: instrumentIds } }, data: { isActive: false } });
  }
});

describe('readOnce — the read the scheduler runs', () => {
  it('a successful read stores every key at the read START, polled, enqueues an evaluation and marks the device healthy', async () => {
    const sl = await slave();
    const i = await inst('ok', sl.port);
    const before = Date.now();
    const r = await readOnce(i.id, ON);
    const after = Date.now();
    expect(r).toEqual({ outcome: 'stored' });

    const st = await status(i.id);
    expect(st).not.toBeNull();
    expect(st!.readBy).toBe('server');
    expect(st!.consecutiveFailures).toBe(0);
    expect(st!.failingSince).toBeNull();
    expect(st!.lastSuccessAt).not.toBeNull();
    const at = st!.lastSuccessAt!.getTime();
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(after);
    expect(st!.lastAttemptAt!.getTime()).toBe(at);

    const h = await history(i.id);
    expect(h.map((x) => x.key)).toEqual(SIX_KEYS);
    for (const row of h) {
      expect(row.ts.getTime(), row.key).toBe(at);
      expect(row.value, row.key).toBe(EXPECTED[row.key]);
    }
    const l = await latest(i.id);
    expect(l.map((x) => x.key)).toEqual(SIX_KEYS);
    expect(l.find((x) => x.key === 'Temperature')!.value).toBe(22.4);

    const row = await prisma.instrument.findUniqueOrThrow({ where: { id: i.id } });
    expect(row.lastSeenVia).toBe('polled');
    expect(enqueueSpy).toHaveBeenCalled();
    expect(sl.connections()).toBe(1);
    await until(() => sl.closedConnections() === 1, 2000, 'socket closed');
    expect(await audits(i.id)).toEqual([]);
  });

  it('refused keys (NaN, infinity) are ONE dead letter per read naming each, and the other keys are stored', async () => {
    const sl = await slave();
    const i = await inst('nan', sl.port, [
      SIX[0],
      { key: 'Broken', register: '40011', dataType: 'FLOAT32', byteOrder: 'ABCD', scale: 1 },
      { key: 'Endless', register: '40013', dataType: 'FLOAT32', byteOrder: 'ABCD', scale: 1 },
    ]);
    const r = await readOnce(i.id, ON);
    expect(r.outcome).toBe('stored');
    expect((await history(i.id)).map((x) => x.key)).toEqual(['Temperature']);
    const dl = await prisma.deadLetter.findMany({ where: { instrumentId: i.id } });
    expect(dl).toHaveLength(1);
    expect(dl[0]!.transport).toBe('modbus');
    expect(dl[0]!.reason).toContain('2 Modbus keys not stored');
    expect(dl[0]!.reason).toContain('"Broken"');
    expect(dl[0]!.reason).toContain('NaN');
    expect(dl[0]!.reason).toContain('0x7FC0 0x0000');
    expect(dl[0]!.reason).toContain('"Endless"');
    expect(dl[0]!.reason).toContain('infinite');
    expect(dl[0]!.reason).toContain('0x7F80 0x0000');
    expect((await status(i.id))!.consecutiveFailures).toBe(0);

    // A second read: one more row, not two.
    await readOnce(i.id, ON);
    expect(await prisma.deadLetter.count({ where: { instrumentId: i.id } })).toBe(2);
  });

  it(`failures: ${NOT_ANSWERING_AFTER - 1} misses change nothing but the count, the ${NOT_ANSWERING_AFTER}rd writes ONE "not answering" row, the next success ONE "answering" row`, async () => {
    expect(NOT_ANSWERING_AFTER).toBe(3);
    const i = await inst('fail', await deadPort());

    const r1 = await readOnce(i.id, ON);
    expect(r1).toEqual({ outcome: 'failed', code: 'REFUSED' });
    const st1 = (await status(i.id))!;
    expect(st1.consecutiveFailures).toBe(1);
    expect(st1.failingSince).toBeNull();
    expect(st1.lastErrorCode).toBe('REFUSED');
    expect(st1.lastErrorMessage).toContain('refused port');
    expect(st1.lastSuccessAt).toBeNull();
    const firstFailure = st1.lastAttemptAt!;
    expect(st1.lastErrorAt!.getTime()).toBe(firstFailure.getTime());
    expect(await audits(i.id)).toEqual([]);

    await sleep(5); // distinct instants
    expect((await readOnce(i.id, ON)).outcome).toBe('failed');
    const st2 = (await status(i.id))!;
    expect(st2.consecutiveFailures).toBe(2);
    expect(st2.failingSince).toBeNull();
    expect(await audits(i.id)).toEqual([]);

    await sleep(5);
    expect((await readOnce(i.id, ON)).outcome).toBe('failed');
    const st3 = (await status(i.id))!;
    expect(st3.consecutiveFailures).toBe(3);
    expect(st3.failingSince!.getTime()).toBe(firstFailure.getTime());
    const a3 = await audits(i.id);
    expect(a3).toHaveLength(1);
    expect(a3[0]!.action).toBe('MODBUS_DEVICE_NOT_ANSWERING');
    expect(a3[0]!.userId).toBeNull();
    expect(a3[0]!.targetType).toBe('Instrument');
    const after3 = a3[0]!.afterValue as Record<string, unknown>;
    expect(after3.code).toBe(i.code);
    expect(after3.host).toBe('127.0.0.1');
    expect(after3.port).toBe(i.modbusPort);
    expect(after3.reason).toBe(st3.lastErrorMessage);
    expect(after3.failingSince).toBe(firstFailure.toISOString());

    await sleep(5);
    expect((await readOnce(i.id, ON)).outcome).toBe('failed');
    const st4 = (await status(i.id))!;
    expect(st4.consecutiveFailures).toBe(4);
    expect(st4.failingSince!.getTime()).toBe(firstFailure.getTime());
    expect(await audits(i.id)).toHaveLength(1);
    // A failed read stores nothing.
    expect(await history(i.id)).toEqual([]);
    expect(await latest(i.id)).toEqual([]);
    expect(enqueueSpy).not.toHaveBeenCalled();
    const lastFailure = st4.lastErrorAt!;

    // The device comes back (its address now answers).
    const sl = await slave();
    await prisma.instrument.update({ where: { id: i.id }, data: { modbusPort: sl.port } });
    expect(await readOnce(i.id, ON)).toEqual({ outcome: 'stored' });
    const st5 = (await status(i.id))!;
    expect(st5.consecutiveFailures).toBe(0);
    expect(st5.failingSince).toBeNull();
    const a5 = await audits(i.id);
    expect(a5.map((a) => a.action)).toEqual(['MODBUS_DEVICE_NOT_ANSWERING', 'MODBUS_DEVICE_ANSWERING']);
    expect(a5[1]!.userId).toBeNull();
    const after5 = a5[1]!.afterValue as Record<string, unknown>;
    expect(after5.code).toBe(i.code);
    expect(after5.missed).toBe(4);
    // The gap: from the first missed read to the read that answered.
    expect(after5.from).toBe(firstFailure.toISOString());
    expect(after5.to).toBe(st5.lastSuccessAt!.toISOString());
    expect(st5.lastSuccessAt!.getTime()).toBeGreaterThan(lastFailure.getTime());
    expect((await history(i.id)).map((x) => x.key)).toEqual(SIX_KEYS);
  });

  it('a STORAGE failure (the device answered) is recorded as the last error but is never "not answering" (Ruling T9-1)', async () => {
    const error = vi.spyOn(logger, 'error');
    try {
      const sl = await slave();
      const i = await inst('wf', sl.port);
      ingestOutcome.next = { ok: false, code: 'WRITE_FAILED', message: 'Readings could not be stored: disk full (test)' };
      for (let n = 1; n <= NOT_ANSWERING_AFTER; n++) {
        expect(await readOnce(i.id, ON)).toEqual({ outcome: 'failed', code: 'WRITE_FAILED' });
        await sleep(5);
      }
      const st = (await status(i.id))!;
      expect(st.consecutiveFailures).toBe(0);
      expect(st.failingSince).toBeNull();
      expect(st.failureRunStartedAt).toBeNull();
      expect(st.lastSuccessAt).toBeNull();
      expect(st.lastErrorCode).toBe('WRITE_FAILED');
      expect(st.lastErrorMessage).toContain('disk full (test)');
      expect(st.lastErrorAt!.getTime()).toBe(st.lastAttemptAt!.getTime());
      expect(await audits(i.id)).toEqual([]);
      expect(error).toHaveBeenCalled();
      expect(sl.connections()).toBe(NOT_ANSWERING_AFTER); // the device WAS read each time

      // Storage back: a stored read, still no audit row (nothing transitioned).
      ingestOutcome.next = null;
      expect(await readOnce(i.id, ON)).toEqual({ outcome: 'stored' });
      expect((await status(i.id))!.consecutiveFailures).toBe(0);
      expect(await audits(i.id)).toEqual([]);
    } finally {
      error.mockRestore();
    }
  });

  it('a mixed run — miss, miss, a storage failure, miss — does NOT transition: the device answered, so the run starts again (final review F-4, overturning T9-3)', async () => {
    const sl = await slave(); // live first, so the dead port cannot be the live one
    const dead = await deadPort();
    const i = await inst('mixed', dead);

    expect((await readOnce(i.id, ON)).code).toBe('REFUSED');
    await sleep(5);
    expect((await readOnce(i.id, ON)).code).toBe('REFUSED');
    expect((await status(i.id))!.consecutiveFailures).toBe(2);

    // The device answers; this server cannot store it. The device's run of misses is broken.
    await prisma.instrument.update({ where: { id: i.id }, data: { modbusPort: sl.port } });
    ingestOutcome.next = { ok: false, code: 'WRITE_FAILED', message: 'Readings could not be stored: (test)' };
    await sleep(5);
    expect(await readOnce(i.id, ON)).toMatchObject({ outcome: 'failed', code: 'WRITE_FAILED' });
    const st = (await status(i.id))!;
    expect(st.consecutiveFailures).toBe(0);
    expect(st.failureRunStartedAt).toBeNull();
    expect(st.failingSince).toBeNull();
    expect(st.lastErrorCode).toBe('WRITE_FAILED');
    expect(await audits(i.id)).toEqual([]);

    // The next DEVICE miss is the FIRST of a new run - not the third of the old one.
    ingestOutcome.next = null;
    await prisma.instrument.update({ where: { id: i.id }, data: { modbusPort: dead } });
    await sleep(5);
    expect((await readOnce(i.id, ON)).code).toBe('REFUSED');
    const st1 = (await status(i.id))!;
    expect(st1.consecutiveFailures).toBe(1);
    expect(st1.failingSince).toBeNull();
    expect(st1.failureRunStartedAt!.getTime()).toBe(st1.lastAttemptAt!.getTime());
    expect(await audits(i.id)).toEqual([]);

    // Two more misses make the NEW run's third: the transition names the new run's first miss.
    const newRunStart = st1.failureRunStartedAt!;
    for (let n = 0; n < 2; n++) {
      await sleep(5);
      expect((await readOnce(i.id, ON)).code).toBe('REFUSED');
    }
    const st3 = (await status(i.id))!;
    expect(st3.consecutiveFailures).toBe(3);
    expect(st3.failingSince!.getTime()).toBe(newRunStart.getTime());
    const a3 = await audits(i.id);
    expect(a3.map((a) => a.action)).toEqual(['MODBUS_DEVICE_NOT_ANSWERING']);
    expect((a3[0]!.afterValue as Record<string, unknown>).failingSince).toBe(newRunStart.toISOString());
  });

  it('a storage failure while ALREADY not answering leaves the failing state as it is and writes no "answering" row (final review F-4)', async () => {
    const sl = await slave();
    const dead = await deadPort();
    const i = await inst('mixed-failing', dead);
    for (let n = 0; n < NOT_ANSWERING_AFTER; n++) {
      await sleep(5);
      expect((await readOnce(i.id, ON)).code).toBe('REFUSED');
    }
    const failing = (await status(i.id))!;
    expect(failing.failingSince).not.toBeNull();
    expect(await audits(i.id)).toHaveLength(1);

    // The device answers, nothing is stored: no reading came in, so nothing recovered.
    await prisma.instrument.update({ where: { id: i.id }, data: { modbusPort: sl.port } });
    ingestOutcome.next = { ok: false, code: 'WRITE_FAILED', message: 'Readings could not be stored: (test)' };
    await sleep(5);
    expect(await readOnce(i.id, ON)).toMatchObject({ outcome: 'failed', code: 'WRITE_FAILED' });
    const st = (await status(i.id))!;
    expect(st.failingSince!.getTime()).toBe(failing.failingSince!.getTime());
    expect(st.consecutiveFailures).toBe(NOT_ANSWERING_AFTER);
    expect(st.failureRunStartedAt!.getTime()).toBe(failing.failureRunStartedAt!.getTime());
    expect(st.lastErrorCode).toBe('WRITE_FAILED');
    expect((await audits(i.id)).map((a) => a.action)).toEqual(['MODBUS_DEVICE_NOT_ANSWERING']);

    // A STORED read is what ends it.
    ingestOutcome.next = null;
    expect(await readOnce(i.id, ON)).toEqual({ outcome: 'stored' });
    expect((await status(i.id))!.failingSince).toBeNull();
    const after = await audits(i.id);
    expect(after.map((a) => a.action)).toEqual(['MODBUS_DEVICE_NOT_ANSWERING', 'MODBUS_DEVICE_ANSWERING']);
    expect((after[1]!.afterValue as Record<string, unknown>).missed).toBe(NOT_ANSWERING_AFTER);
  });

  it('reading switched OFF: skipped, and the device sees NO connection', async () => {
    await setReading(false);
    const sl = await slave();
    const i = await inst('off', sl.port);
    expect(await readOnce(i.id, ON)).toEqual({ outcome: 'skipped', code: 'SERVER_READING_OFF' });
    await sleep(50);
    expect(sl.connections()).toBe(0);
    expect(await status(i.id)).toBeNull();
    expect(await history(i.id)).toEqual([]);
  });

  it('an invalid stored config (unit id 300) is skipped with a warning and never read; an empty map is skipped quietly', async () => {
    const warn = vi.spyOn(logger, 'warn');
    try {
      const sl = await slave();
      const bad = await inst('badunit', sl.port, SIX, { profileId: badProfileId });
      expect(await readOnce(bad.id, ON)).toEqual({ outcome: 'skipped', code: 'INVALID_CONFIG' });
      expect(warn).toHaveBeenCalled();

      const sl2 = await slave();
      const brokenMap = await inst('badmap', sl2.port, [{ key: 'Temperature' }]);
      warn.mockClear();
      expect(await readOnce(brokenMap.id, ON)).toEqual({ outcome: 'skipped', code: 'INVALID_CONFIG' });
      expect(warn).toHaveBeenCalled();

      const sl3 = await slave();
      const empty = await inst('nomap', sl3.port, []);
      warn.mockClear();
      expect(await readOnce(empty.id, ON)).toEqual({ outcome: 'skipped', code: 'NO_REGISTER_MAP' });
      expect(warn).not.toHaveBeenCalled();

      await sleep(50);
      expect(sl.connections() + sl2.connections() + sl3.connections()).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('the schedule — Review Focus 3: configuration changes apply at the next reload', () => {
  it('disabled, map emptied, host outside the networks, networks narrowed, interval changed, reading OFF', async () => {
    const sl = await slave();
    const i = await inst('cfg', sl.port);
    let clock = Date.now();
    const core = createModbusReader({ log, allowLoopbackForTests: true, now: () => clock });
    const entry = () => core.schedule().find((e) => e.instrumentId === i.id);
    try {
      expect(await core.reload()).toBe(true);
      expect(entry()?.intervalSec).toBe(60);
      expect(entry()?.address).toBe(`127.0.0.1:${sl.port}`);
      // Nothing changed: no rebuild.
      expect(await core.reload()).toBe(false);

      // The profile's interval: the next schedule is on the new grid.
      await prisma.instrumentProfile.update({ where: { id: profileId }, data: { modbusIntervalSec: 120 } });
      clock += 1000;
      expect(await core.reload()).toBe(true);
      expect(entry()?.intervalSec).toBe(120);
      expect(entry()!.nextDueAt).toBe(firstSlotAtOrAfter(clock, 120, phaseFor(i.id, 120)));
      await prisma.instrumentProfile.update({ where: { id: profileId }, data: { modbusIntervalSec: 60 } });
      await core.reload();
      expect(entry()?.intervalSec).toBe(60);

      // Disabled.
      await prisma.instrument.update({ where: { id: i.id }, data: { isActive: false } });
      await core.reload();
      expect(entry()).toBeUndefined();
      expect(await readOnce(i.id, ON)).toEqual({ outcome: 'skipped', code: 'INSTRUMENT_DISABLED' });
      await prisma.instrument.update({ where: { id: i.id }, data: { isActive: true } });
      await core.reload();
      expect(entry()).toBeDefined();

      // Map emptied.
      await prisma.instrument.update({ where: { id: i.id }, data: { modbusRegisters: [] } });
      await core.reload();
      expect(entry()).toBeUndefined();
      expect(await readOnce(i.id, ON)).toEqual({ outcome: 'skipped', code: 'NO_REGISTER_MAP' });
      await prisma.instrument.update({ where: { id: i.id }, data: { modbusRegisters: SIX as never } });
      await core.reload();
      expect(entry()).toBeDefined();

      // Host moved outside the device networks.
      await prisma.instrument.update({ where: { id: i.id }, data: { modbusHost: '10.20.30.40' } });
      await core.reload();
      expect(entry()).toBeUndefined();
      expect(await readOnce(i.id, ON)).toEqual({ outcome: 'skipped', code: 'ADDRESS_NOT_ALLOWED' });

      // Inside the networks, then the networks narrowed past it.
      await prisma.instrument.update({ where: { id: i.id }, data: { modbusHost: '192.0.2.10' } });
      await core.reload();
      expect(entry()?.address).toBe(`192.0.2.10:${sl.port}`);
      await setReading(true, '192.0.2.128/25');
      await core.reload();
      expect(entry()).toBeUndefined();
      expect(await readOnce(i.id, ON)).toEqual({ outcome: 'skipped', code: 'ADDRESS_NOT_ALLOWED' });

      // Reading OFF: nothing is scheduled at all.
      await prisma.instrument.update({ where: { id: i.id }, data: { modbusHost: '127.0.0.1' } });
      await setReading(true);
      await core.reload();
      expect(entry()).toBeDefined();
      await setReading(false);
      await core.reload();
      expect(core.schedule()).toEqual([]);

      expect(sl.connections()).toBe(0);
      expect(await status(i.id)).toBeNull();
    } finally {
      await core.stop();
    }
  });
});

describe('the schedule — one read at a time', () => {
  const E = (id: string, address: string, nextDueAt = 0): ScheduleEntry =>
    ({ instrumentId: id, address, intervalSec: 60, phaseSec: 0, nextDueAt });
  const none = { ids: new Set<string>(), addresses: new Set<string>() };

  it('two due entries on one host:port: one starts, the other WAITS (stays due, not skipped)', () => {
    const { start, skip } = pickDue([E('a', 'h:1'), E('b', 'h:1'), E('c', 'h:2')], 1000, none, MAX_READS_IN_FLIGHT);
    expect(start.map((e) => e.instrumentId)).toEqual(['a', 'c']);
    expect(skip).toEqual([]);
  });

  it('an address already being read waits; a still-running instrument SKIPS its tick', () => {
    const running = { ids: new Set(['x']), addresses: new Set(['h:1']) };
    const { start, skip } = pickDue([E('a', 'h:1'), E('x', 'h:9')], 1000, running, MAX_READS_IN_FLIGHT);
    expect(start).toEqual([]);
    expect(skip.map((e) => e.instrumentId)).toEqual(['x']);
  });

  it(`at most ${MAX_READS_IN_FLIGHT} reads in flight; entries not yet due are left alone`, () => {
    expect(MAX_READS_IN_FLIGHT).toBe(16);
    const many = Array.from({ length: 20 }, (_, n) => E(`i${n}`, `h:${n}`));
    expect(pickDue(many, 1000, none, MAX_READS_IN_FLIGHT).start).toHaveLength(16);
    const busy = { ids: new Set(['r1', 'r2', 'r3']), addresses: new Set(['q:1', 'q:2', 'q:3']) };
    expect(pickDue(many, 1000, busy, MAX_READS_IN_FLIGHT).start).toHaveLength(13);
    expect(pickDue([E('later', 'h:1', 5000)], 1000, none, MAX_READS_IN_FLIGHT)).toEqual({ start: [], skip: [] });
  });

  it('phase: inside the interval, stable per id; the first slot is the next one on the grid', () => {
    const id = randomUUID();
    const p = phaseFor(id, 60);
    expect(p).toBe(phaseFor(id, 60));
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThan(60);
    const now = 1_790_000_000_123;
    const slot = firstSlotAtOrAfter(now, 60, p);
    expect(slot).toBeGreaterThanOrEqual(now);
    expect(slot).toBeLessThan(now + 60_000);
    expect(((slot / 1000 - p) % 60 + 60) % 60).toBe(0);
  });

  it('a slow device and two forced ticks: one connection; the still-running instrument skips the second tick', async () => {
    const sl = await slave({ holding: HOLDING, input: INPUT, delayMs: 500 });
    const i = await inst('busy', sl.port);
    let clock = Date.now();
    const core = createModbusReader({ log, allowLoopbackForTests: true, now: () => clock });
    try {
      await core.reload();
      const e = core.schedule().find((x) => x.instrumentId === i.id)!;
      expect(e).toBeDefined();
      const first = e.nextDueAt;
      clock = first;
      core.tick();
      await until(() => sl.requests().length >= 1, 3000, 'first request');
      clock = first + e.intervalSec * 1000;
      core.tick();
      await sleep(100);
      expect(sl.connections()).toBe(1);
      expect(core.schedule().find((x) => x.instrumentId === i.id)!.nextDueAt).toBe(first + 2 * e.intervalSec * 1000);
      await until(() => core.inFlight() === 0, 3000, 'read finished');
      expect(sl.connections()).toBe(1);
      expect((await history(i.id)).map((x) => x.key)).toEqual(SIX_KEYS);
    } finally {
      await core.stop();
    }
  });
});

describe('Review Focus 2 — the Reader stopped mid-read', () => {
  it('stop() resolves at once, the read in flight writes nothing, and no tick runs after it', async () => {
    const sl = await slave({ holding: HOLDING, input: INPUT, delayMs: 800 });
    const i = await inst('stop', sl.port);
    let clock = Date.now();
    const core = createModbusReader({ log, allowLoopbackForTests: true, now: () => clock });
    await core.reload();
    const e = core.schedule().find((x) => x.instrumentId === i.id)!;
    clock = e.nextDueAt;
    core.tick();
    await until(() => sl.requests().length >= 1, 3000, 'request sent');

    const t = Date.now();
    await core.stop();
    expect(Date.now() - t).toBeLessThan(400);
    expect(core.inFlight()).toBe(0);
    await until(() => sl.closedConnections() === 1, 2000, 'socket closed');

    await sleep(1000); // past the device's 800 ms answer
    expect(await history(i.id)).toEqual([]);
    expect(await latest(i.id)).toEqual([]);
    expect(await status(i.id)).toBeNull();
    expect(await audits(i.id)).toEqual([]);
    expect((await prisma.instrument.findUniqueOrThrow({ where: { id: i.id } })).lastSeenAt).toBeNull();

    clock = e.nextDueAt + 3_600_000;
    core.tick();
    expect(await core.reload()).toBe(false);
    await sleep(100);
    expect(sl.connections()).toBe(1);
  });

  it('startModbusReader: real unref\'d timers read on the profile interval, and stop() clears every timer', async () => {
    // An id whose first slot on a 10 s interval is 2-5 s away.
    let id = randomUUID();
    for (let n = 0; n < 1000; n++) {
      const ahead = firstSlotAtOrAfter(Date.now(), 10, phaseFor(id, 10)) - Date.now();
      if (ahead >= 2000 && ahead <= 5000) break;
      id = randomUUID();
    }
    const sl = await slave();
    const i = await inst('timers', sl.port, SIX, { id, profileId: profile10Id });

    const setSpy = vi.spyOn(globalThis, 'setInterval');
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    try {
      const handle = startModbusReader({ log, allowLoopbackForTests: true });
      const timers = setSpy.mock.results.map((r) => r.value as NodeJS.Timeout);
      expect(timers.length).toBeGreaterThan(0);
      for (const t of timers) expect(t.hasRef()).toBe(false);

      // The status row is written AFTER the readings: wait for it, not for history.
      await until(async () => Boolean((await status(i.id))?.lastSuccessAt), 15_000, 'the scheduled read');
      expect((await status(i.id))!.consecutiveFailures).toBe(0);
      expect((await history(i.id)).map((x) => x.key)).toEqual(SIX_KEYS);
      await handle.stop();
      for (const t of timers) expect(clearSpy).toHaveBeenCalledWith(t);
      expect(sl.connections()).toBe(1);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });
});
