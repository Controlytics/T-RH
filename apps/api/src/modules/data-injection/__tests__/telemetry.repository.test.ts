import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../../../lib/prisma.js';
import { writeBatch, getLatest, getHistory, writeDeadLetters } from '../telemetry.repository.js';

const INST = 'test-instrument-repo';
const AT = new Date('2026-08-15T10:00:00.000Z');

describe('telemetry repository', () => {
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM instrument_telemetry_latest WHERE instrument_id = '${INST}'`);
    await prisma.$executeRawUnsafe(`DELETE FROM instrument_telemetry_history WHERE instrument_id = '${INST}'`);
    await prisma.$executeRawUnsafe(`DELETE FROM dead_letters WHERE topic = 'repo/test'`);
  });

  it('writes latest and history in one batch', async () => {
    await writeBatch([{ instrumentId: INST, readings: [
      { key: 'temp', value: 21.5, valueType: 'float', ts: AT },
      { key: 'on', value: true, valueType: 'boolean', ts: AT },
    ] }], AT);

    const latest = await getLatest(INST);
    expect(latest.map(r => r.key).sort()).toEqual(['on', 'temp']);
    expect(latest.find(r => r.key === 'temp')!.value).toBe(21.5);

    const hist = await getHistory({ instrumentId: INST, limit: 10 });
    expect(hist.rows).toHaveLength(2);
  });

  it('upserts latest on a repeat key but appends to history', async () => {
    const later = new Date(AT.getTime() + 60_000);
    await writeBatch([{ instrumentId: INST, readings: [{ key: 'temp', value: 1, valueType: 'int', ts: AT }] }], AT);
    await writeBatch([{ instrumentId: INST, readings: [{ key: 'temp', value: 2, valueType: 'int', ts: later }] }], later);

    const latest = await getLatest(INST);
    expect(latest).toHaveLength(1);
    expect(latest[0].value).toBe(2);              // overwritten
    const hist = await getHistory({ instrumentId: INST, limit: 10 });
    expect(hist.rows).toHaveLength(2);            // both retained
  });

  it('preserves value types across a round trip', async () => {
    await writeBatch([{ instrumentId: INST, readings: [
      { key: 'b', value: true, valueType: 'boolean', ts: AT },
      { key: 'i', value: 7, valueType: 'int', ts: AT },
      { key: 'f', value: 1.5, valueType: 'float', ts: AT },
      { key: 's', value: 'ok', valueType: 'string', ts: AT },
      { key: 'j', value: { a: 1 }, valueType: 'json', ts: AT },
    ] }], AT);
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
    await writeBatch([{ instrumentId: INST, readings: [{ key: 'temp', value: 1, valueType: 'int', ts: t1 }] }], t1);
    await writeBatch([{ instrumentId: INST, readings: [{ key: 'temp', value: 2, valueType: 'int', ts: t2 }] }], t2);
    await writeBatch([{ instrumentId: INST, readings: [{ key: 'rh', value: 9, valueType: 'int', ts: t2 }] }], t2);

    const onlyTemp = await getHistory({ instrumentId: INST, key: 'temp', limit: 10 });
    expect(onlyTemp.rows).toHaveLength(2);
    const windowed = await getHistory({
      instrumentId: INST, key: 'temp',
      from: new Date('2026-08-15T00:00:00Z'), limit: 10,
    });
    expect(windowed.rows).toHaveLength(1);
    expect(windowed.rows[0].value).toBe(2);
  });

  // The ingestion service flushes many messages through ONE writeBatch call, so
  // an instrument publishing twice inside a flush window puts the same
  // (instrument, key) into the latest-upsert twice. Postgres rejects that with
  // "ON CONFLICT DO UPDATE command cannot affect row a second time", and because
  // the batch is one transaction it would discard every reading in the flush.
  it('accepts the same (instrument,key) twice in one batch, keeping the newest', async () => {
    const t1 = new Date('2026-08-15T10:00:00.000Z');
    const t2 = new Date('2026-08-15T10:00:05.000Z');
    await writeBatch([
      { instrumentId: INST, readings: [{ key: 'temp', value: 1, valueType: 'int', ts: t1 }] },
      { instrumentId: INST, readings: [{ key: 'temp', value: 2, valueType: 'int', ts: t2 }] },
    ], t2);

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
      { instrumentId: INST, readings: [{ key: 'temp', value: 2, valueType: 'int', ts: t2 }] },
      { instrumentId: INST, readings: [{ key: 'temp', value: 1, valueType: 'int', ts: t1 }] },
    ], t2);
    const latest = await getLatest(INST);
    expect(latest[0].value).toBe(2);
  });

  it('does not collapse the same key across DIFFERENT instruments', async () => {
    const OTHER = `${INST}-2`;
    await prisma.$executeRawUnsafe(`DELETE FROM instrument_telemetry_latest WHERE instrument_id = '${OTHER}'`);
    await prisma.$executeRawUnsafe(`DELETE FROM instrument_telemetry_history WHERE instrument_id = '${OTHER}'`);
    await writeBatch([
      { instrumentId: INST, readings: [{ key: 'temp', value: 1, valueType: 'int', ts: AT }] },
      { instrumentId: OTHER, readings: [{ key: 'temp', value: 2, valueType: 'int', ts: AT }] },
    ], AT);
    expect((await getLatest(INST))[0].value).toBe(1);
    expect((await getLatest(OTHER))[0].value).toBe(2);
    await prisma.$executeRawUnsafe(`DELETE FROM instrument_telemetry_latest WHERE instrument_id = '${OTHER}'`);
    await prisma.$executeRawUnsafe(`DELETE FROM instrument_telemetry_history WHERE instrument_id = '${OTHER}'`);
  });

  it('writes dead letters', async () => {
    await writeDeadLetters([
      { protocolKey: 'mqtt', topic: 'repo/test', payload: '{}', reason: 'UNKNOWN_DEVICE_KEY', detail: 'ghost' },
    ]);
    const n = await prisma.deadLetter.count({ where: { topic: 'repo/test' } });
    expect(n).toBe(1);
  });
});
