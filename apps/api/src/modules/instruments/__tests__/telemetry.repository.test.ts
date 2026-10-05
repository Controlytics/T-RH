import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { prisma } from '../../../lib/prisma.js';
import { writeBatch, getLatest, getHistory, writeDeadLetters, getDistinctKeys, lastPerInstant } from '../telemetry.repository.js';

/**
 * Ported from pre-data-injection-drop:apps/api/src/modules/data-injection/__tests__/telemetry.repository.test.ts
 * and adapted to the CURRENT repository signatures/schema:
 *  - writeBatch takes a flat `(Reading & {instrumentId})[]`, not
 *    `{instrumentId, readings}[]` plus a separate `receivedAt` — see
 *    telemetry.repository.ts's header comment for why.
 *  - dead_letters has no `topic` column, so writeDeadLetters rows and
 *    lookups use `instrumentId`/`reason` instead of `topic`.
 *  - Neither telemetry table nor dead_letters has an FK to `instruments`, so
 *    these tests use synthetic instrument ids without creating Instrument
 *    rows — same as the original.
 *
 * Unique instrument ids per run (timestamp suffix) so concurrent/repeat runs
 * never collide; each test cleans up only the rows it created (no table
 * truncation — this DB carries other suites' data too).
 */
const RUN = Date.now();
const INST = `test-instrument-repo-${RUN}`;
const OTHER = `test-instrument-repo-${RUN}-2`;
const AT = new Date('2026-08-15T10:00:00.000Z');

async function cleanup(id: string) {
  await prisma.$executeRawUnsafe(`DELETE FROM instrument_telemetry_latest WHERE instrument_id = '${id}'`);
  await prisma.$executeRawUnsafe(`DELETE FROM instrument_telemetry_history WHERE instrument_id = '${id}'`);
}

describe('telemetry repository', () => {
  beforeEach(async () => {
    await cleanup(INST);
    await cleanup(OTHER);
    await prisma.deadLetter.deleteMany({ where: { instrumentId: INST } });
  });

  afterAll(async () => {
    await cleanup(INST);
    await cleanup(OTHER);
    await prisma.deadLetter.deleteMany({ where: { instrumentId: INST } });
  });

  it('writes latest and history in one batch', async () => {
    await writeBatch([
      { instrumentId: INST, key: 'temp', value: 21.5, valueType: 'float', ts: AT },
      { instrumentId: INST, key: 'on', value: true, valueType: 'boolean', ts: AT },
    ]);

    const latest = await getLatest(INST);
    expect(latest.map(r => r.key).sort()).toEqual(['on', 'temp']);
    expect(latest.find(r => r.key === 'temp')!.value).toBe(21.5);

    const hist = await getHistory({ instrumentId: INST, limit: 10 });
    expect(hist.rows).toHaveLength(2);
  });

  it('upserts latest on a repeat key but appends to history', async () => {
    const later = new Date(AT.getTime() + 60_000);
    await writeBatch([{ instrumentId: INST, key: 'temp', value: 1, valueType: 'int', ts: AT }]);
    await writeBatch([{ instrumentId: INST, key: 'temp', value: 2, valueType: 'int', ts: later }]);

    const latest = await getLatest(INST);
    expect(latest).toHaveLength(1);
    expect(latest[0].value).toBe(2);              // overwritten
    const hist = await getHistory({ instrumentId: INST, limit: 10 });
    expect(hist.rows).toHaveLength(2);            // both retained
  });

  it('preserves value types across a round trip', async () => {
    await writeBatch([
      { instrumentId: INST, key: 'b', value: true, valueType: 'boolean', ts: AT },
      { instrumentId: INST, key: 'i', value: 7, valueType: 'int', ts: AT },
      { instrumentId: INST, key: 'f', value: 1.5, valueType: 'float', ts: AT },
      { instrumentId: INST, key: 's', value: 'ok', valueType: 'string', ts: AT },
      { instrumentId: INST, key: 'j', value: { a: 1 }, valueType: 'json', ts: AT },
    ]);
    const byKey = Object.fromEntries((await getLatest(INST)).map(r => [r.key, r]));
    expect(byKey.b.value).toBe(true);
    expect(byKey.i.value).toBe(7);
    expect(byKey.f.value).toBe(1.5);
    expect(byKey.s.value).toBe('ok');
    expect(byKey.j.value).toEqual({ a: 1 });
    expect(byKey.i.valueType).toBe('int');
  });

  it('filters history by key and time window', async () => {
    const t1 = new Date('2026-08-10T00:00:00Z');
    const t2 = new Date('2026-08-20T00:00:00Z');
    await writeBatch([{ instrumentId: INST, key: 'temp', value: 1, valueType: 'int', ts: t1 }]);
    await writeBatch([{ instrumentId: INST, key: 'temp', value: 2, valueType: 'int', ts: t2 }]);
    await writeBatch([{ instrumentId: INST, key: 'rh', value: 9, valueType: 'int', ts: t2 }]);

    const onlyTemp = await getHistory({ instrumentId: INST, key: 'temp', limit: 10 });
    expect(onlyTemp.rows).toHaveLength(2);
    const windowed = await getHistory({
      instrumentId: INST, key: 'temp',
      from: new Date('2026-08-15T00:00:00Z'), limit: 10,
    });
    expect(windowed.rows).toHaveLength(1);
    expect(windowed.rows[0].value).toBe(2);
  });

  // The ingest route flushes a whole payload through ONE writeBatch call, so a
  // batch payload (or a device publishing twice within a flush) puts the same
  // (instrument, key) into the latest-upsert twice. Postgres rejects that with
  // "ON CONFLICT DO UPDATE command cannot affect row a second time", and
  // because the batch is one transaction it would discard every reading in the
  // flush — this is the bug the newest-per-key dedup in writeBatch exists to
  // prevent. This test would FAIL if that dedup were removed (verified below).
  it('accepts the same (instrument,key) twice in one batch, keeping the newest', async () => {
    const t1 = new Date('2026-08-15T10:00:00.000Z');
    const t2 = new Date('2026-08-15T10:00:05.000Z');
    await writeBatch([
      { instrumentId: INST, key: 'temp', value: 1, valueType: 'int', ts: t1 },
      { instrumentId: INST, key: 'temp', value: 2, valueType: 'int', ts: t2 },
    ]);

    const latest = await getLatest(INST);
    expect(latest).toHaveLength(1);
    expect(latest[0].value).toBe(2);                    // newest wins
    const hist = await getHistory({ instrumentId: INST, limit: 10 });
    expect(hist.rows).toHaveLength(2);                  // history keeps both
  });

  it('keeps the newest even when the duplicate arrives out of order', async () => {
    const t1 = new Date('2026-08-15T10:00:00.000Z');
    const t2 = new Date('2026-08-15T10:00:05.000Z');
    await writeBatch([
      { instrumentId: INST, key: 'temp', value: 2, valueType: 'int', ts: t2 },
      { instrumentId: INST, key: 'temp', value: 1, valueType: 'int', ts: t1 },
    ]);
    const latest = await getLatest(INST);
    expect(latest[0].value).toBe(2);
  });

  it('does not collapse the same key across DIFFERENT instruments', async () => {
    await writeBatch([
      { instrumentId: INST, key: 'temp', value: 1, valueType: 'int', ts: AT },
      { instrumentId: OTHER, key: 'temp', value: 2, valueType: 'int', ts: AT },
    ]);
    expect((await getLatest(INST))[0].value).toBe(1);
    expect((await getLatest(OTHER))[0].value).toBe(2);
  });

  it('returns one row per key, newest ts, ordered by recency', async () => {
    const t1 = new Date('2026-08-10T00:00:00Z');
    const t2 = new Date('2026-08-20T00:00:00Z');
    const t3 = new Date('2026-08-15T00:00:00Z');
    await writeBatch([
      { instrumentId: INST, key: 'temp', value: 1, valueType: 'int', ts: t1 },
      { instrumentId: INST, key: 'temp', value: 2, valueType: 'int', ts: t3 },
      { instrumentId: INST, key: 'rh', value: 9, valueType: 'int', ts: t2 },
    ]);

    const keys = await getDistinctKeys(INST);
    expect(keys).toHaveLength(2);
    // rh's newest (t2) is later than temp's newest (t3) — rh first.
    expect(keys.map((k) => k.key)).toEqual(['rh', 'temp']);
    expect(new Date(keys.find((k) => k.key === 'temp')!.lastSeen).getTime()).toBe(t3.getTime());
  });

  it('does not mix keys across different instruments', async () => {
    await writeBatch([
      { instrumentId: INST, key: 'temp', value: 1, valueType: 'int', ts: AT },
      { instrumentId: OTHER, key: 'co2', value: 400, valueType: 'int', ts: AT },
    ]);
    expect((await getDistinctKeys(INST)).map((k) => k.key)).toEqual(['temp']);
    expect((await getDistinctKeys(OTHER)).map((k) => k.key)).toEqual(['co2']);
  });

  /**
   * TWO READINGS AT ONE INSTANT (audit 2026-10-03, INGEST-14): history used to
   * keep the FIRST (`DO NOTHING`) while latest kept the LAST, so a device
   * stamping whole seconds showed one value on the dashboard and printed the
   * other in every report. The rule is now ONE: the last arrival wins in both.
   */
  describe('two readings at one instant', () => {
    it('in ONE batch: the last in arrival order wins in history AND latest', async () => {
      await writeBatch([
        { instrumentId: INST, key: 'temp', value: 1, valueType: 'int', ts: AT },
        { instrumentId: INST, key: 'temp', value: 2, valueType: 'int', ts: AT },
      ]);
      expect((await getLatest(INST))[0].value).toBe(2);
      const hist = await getHistory({ instrumentId: INST, limit: 10 });
      expect(hist.rows).toHaveLength(1);
      expect(hist.rows[0].value).toBe(2);
    });

    it('across TWO batches: the later arrival rewrites the instant in both tables', async () => {
      await writeBatch([{ instrumentId: INST, key: 'temp', value: 1, valueType: 'int', ts: AT }]);
      await writeBatch([{ instrumentId: INST, key: 'temp', value: 2, valueType: 'int', ts: AT }]);
      expect((await getLatest(INST))[0].value).toBe(2);
      const hist = await getHistory({ instrumentId: INST, limit: 10 });
      expect(hist.rows).toHaveLength(1);
      expect(hist.rows[0].value).toBe(2);
    });

    it('a redelivered IDENTICAL reading changes nothing — history stays idempotent under QoS 1', async () => {
      await writeBatch([{ instrumentId: INST, key: 'temp', value: 7, valueType: 'int', ts: AT }]);
      await writeBatch([{ instrumentId: INST, key: 'temp', value: 7, valueType: 'int', ts: AT }]);
      const hist = await getHistory({ instrumentId: INST, limit: 10 });
      expect(hist.rows).toHaveLength(1);
      expect(hist.rows[0].value).toBe(7);
      expect(await getLatest(INST)).toHaveLength(1);
    });

    it('lastPerInstant keeps the last of each (instrument, key, ts) and leaves distinct instants alone', () => {
      const later = new Date(AT.getTime() + 1000);
      const rows = [
        { instrumentId: INST, key: 'temp', value: 1, ts: AT },
        { instrumentId: INST, key: 'temp', value: 2, ts: AT },
        { instrumentId: INST, key: 'temp', value: 3, ts: later },
        { instrumentId: OTHER, key: 'temp', value: 4, ts: AT },
      ];
      expect(lastPerInstant(rows).map((r) => r.value).sort()).toEqual([2, 3, 4]);
    });
  });

  it('writes dead letters', async () => {
    await writeDeadLetters([
      { instrumentId: INST, transport: 'mqtt', reason: 'UNKNOWN_DEVICE_KEY', rawPayload: '{}' },
    ]);
    const n = await prisma.deadLetter.count({ where: { instrumentId: INST, reason: 'UNKNOWN_DEVICE_KEY' } });
    expect(n).toBe(1);
  });
});
