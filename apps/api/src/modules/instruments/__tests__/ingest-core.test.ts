import { describe, it, expect, vi, beforeEach } from 'vitest';

const writeBatch = vi.fn(); const writeDeadLetters = vi.fn();
const childMapFor = vi.fn(); const stampLastSeen = vi.fn();
const earliestPartitionStart = vi.fn(); const enqueueAlarmEvaluation = vi.fn();
vi.mock('../telemetry.repository.js', () => ({
  writeBatch: (...a: unknown[]) => writeBatch(...a),
  writeDeadLetters: (...a: unknown[]) => writeDeadLetters(...a),
  earliestPartitionStart: (...a: unknown[]) => earliestPartitionStart(...a),
}));
vi.mock('../../alarms/enqueue-evaluation.js', () => ({
  enqueueAlarmEvaluation: (...a: unknown[]) => enqueueAlarmEvaluation(...a),
}));
vi.mock('../gateway-children.js', () => ({ childMapFor: (...a: unknown[]) => childMapFor(...a) }));
vi.mock('../last-seen.js', () => ({ stampLastSeen: (...a: unknown[]) => stampLastSeen(...a) }));

import { ingestPayload } from '../ingest-core.js';

const plain = { id: 'i1', code: 'P-1', transport: 'http', isGateway: false };
const gw = { id: 'g1', code: 'GW-1', transport: 'http', isGateway: true };
const buf = (o: unknown) => Buffer.from(JSON.stringify(o));

beforeEach(() => {
  writeBatch.mockReset(); writeDeadLetters.mockReset();
  childMapFor.mockReset(); stampLastSeen.mockReset();
  writeBatch.mockResolvedValue(undefined); writeDeadLetters.mockResolvedValue(undefined);
  stampLastSeen.mockResolvedValue(undefined);
  earliestPartitionStart.mockReset(); enqueueAlarmEvaluation.mockReset();
  earliestPartitionStart.mockResolvedValue(null); enqueueAlarmEvaluation.mockResolvedValue(undefined);
  childMapFor.mockResolvedValue(new Map([['CH-A', { id: 'a1', isActive: true }]]));
});

describe('ingestPayload', () => {
  it('records the transport it actually arrived on, not the instrument\'s', async () => {
    // The whole point of the field now that instruments no longer declare one.
    await ingestPayload({ identity: plain, raw: Buffer.from('not json'), transport: 'tcp' });
    expect(writeDeadLetters.mock.calls[0][0][0]).toMatchObject({ transport: 'tcp' });
  });

  it('accepts a flat payload and stamps the sender direct', async () => {
    const r = await ingestPayload({ identity: plain, raw: buf({ temperature: 21.5 }), transport: 'ws' });
    // `rejected` is ABSENT, not 0 — the flat path cannot reject anything, and
    // its HTTP body has never carried the key (gateway-ingest.test.ts pins
    // `{accepted: 1}` exactly). Normalising it in would change that body.
    expect(r).toEqual({ ok: true, accepted: 1 });
    expect(stampLastSeen).toHaveBeenCalledWith(['i1'], 'direct');
  });

  it('refuses a batch from a non-gateway', async () => {
    const r = await ingestPayload({ identity: plain, raw: buf({ devices: { 'CH-A': { t: 1 } } }), transport: 'mqtt' });
    expect(r).toMatchObject({ ok: false, code: 'NOT_A_GATEWAY' });
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it('fans a gateway batch out to its children and reports partial rejection', async () => {
    const r = await ingestPayload({
      identity: gw, raw: buf({ devices: { 'CH-A': { t: 1 }, 'NOPE': { t: 2 } } }), transport: 'tcp',
    });
    expect(r).toEqual({ ok: true, accepted: 1, rejected: 1 });
    expect(stampLastSeen).toHaveBeenCalledWith(['a1'], 'gateway');
    expect(stampLastSeen).toHaveBeenCalledWith(['g1'], 'direct');
  });

  it('dead-letters an unparseable payload rather than throwing', async () => {
    const r = await ingestPayload({ identity: plain, raw: Buffer.from('{oops'), transport: 'ws' });
    expect(r).toMatchObject({ ok: false, code: 'UNPARSEABLE' });
    expect(writeDeadLetters).toHaveBeenCalled();
  });

  it('never lets a dead-letter write failure lose an accepted reading', async () => {
    writeDeadLetters.mockRejectedValue(new Error('db down'));
    const r = await ingestPayload({
      identity: gw, raw: buf({ devices: { 'CH-A': { t: 1 }, 'NOPE': { t: 2 } } }), transport: 'http',
    });
    expect(r).toMatchObject({ ok: true, accepted: 1 });
    expect(writeBatch).toHaveBeenCalled();
  });
});

/**
 * The envelope shape, driven through the WRITE PATH (2026-09-03).
 *
 * The parser test alone would not have caught the original defect. When this was
 * first diagnosed I proved the FLAT payload parsed correctly and concluded the
 * pipeline worked — but the device was sending `{"values":{...}}`, and what
 * actually reached `writeBatch` was ONE json row keyed `values`. These assert on
 * the rows handed to the repository, which is the thing the dashboard reads.
 */
describe('ingestPayload — envelope payload', () => {
  const rows = () => writeBatch.mock.calls[0][0] as Array<{ key: string; value: unknown; valueType: string; instrumentId: string }>;

  it('writes the device\'s readings as their OWN keys, not one `values` blob', async () => {
    const r = await ingestPayload({
      identity: plain,
      raw: buf({ values: { h: '48.5', t: '33.2', id: 3, ty: 3 } }),
      transport: 'mqtt',
    });
    expect(r).toEqual({ ok: true, accepted: 4 });

    const byKey = Object.fromEntries(rows().map((x) => [x.key, x.value]));
    expect(byKey).toEqual({ h: '48.5', t: '33.2', id: 3, ty: 3 });
    // The defect, stated as an assertion: this key must not reach the database.
    expect(rows().map((x) => x.key)).not.toContain('values');
    expect(rows().every((x) => x.instrumentId === 'i1')).toBe(true);
  });

  it('keeps the quoted reading a string, so coerceReading judges it downstream', async () => {
    await ingestPayload({ identity: plain, raw: buf({ values: { t: '33.2' } }), transport: 'mqtt' });
    expect(rows()[0]).toMatchObject({ key: 't', value: '33.2', valueType: 'string' });
  });

  // The guard, at the write path: nothing is discarded when the shape is ambiguous.
  it('writes BOTH when the payload carries an envelope and its own reading', async () => {
    await ingestPayload({ identity: plain, raw: buf({ values: { t: 1 }, t: 25 }), transport: 'mqtt' });
    const byKey = Object.fromEntries(rows().map((x) => [x.key, x.value]));
    expect(byKey.t).toBe(25);
    expect(byKey.values).toEqual({ t: 1 });
  });

  it('still fans a gateway batch out when both keys are present', async () => {
    const r = await ingestPayload({
      identity: gw, raw: buf({ devices: { 'CH-A': { t: 1 } }, values: { t: 9 } }), transport: 'mqtt',
    });
    expect(r).toMatchObject({ ok: true, accepted: 1 });
    expect(rows()[0]).toMatchObject({ key: 't', value: 1, instrumentId: 'a1' });
  });
});

/**
 * Audit 2026-10-03, INGEST-1: a write the DATABASE refuses (a timestamp outside
 * every partition, an outage) used to escape `ingestPayload` — one bad row
 * failed the whole batch's single INSERT, the broker had already acked, and
 * nothing recorded the loss. Now the raw payload is dead-lettered with the
 * database's words and the caller gets WRITE_FAILED; nothing throws.
 */
describe('ingestPayload — a refused write is recorded, never lost silently', () => {
  it('flat path: dead-letters the raw payload with the DB error and returns WRITE_FAILED', async () => {
    writeBatch.mockRejectedValueOnce(new Error('no partition of relation "instrument_telemetry_history" found for row'));
    const r = await ingestPayload({ identity: plain, raw: buf({ temperature: 21.5, ts: '2019-01-01T00:00:00Z' }), transport: 'mqtt' });
    expect(r).toMatchObject({ ok: false, code: 'WRITE_FAILED' });
    expect((r as { message: string }).message).toContain('no partition');
    const row = writeDeadLetters.mock.calls[0][0][0];
    expect(row).toMatchObject({ instrumentId: 'i1', transport: 'mqtt' });
    expect(row.reason).toContain('Telemetry write failed');
    expect(row.reason).toContain('no partition');
    expect(row.rawPayload).toContain('2019-01-01');
    // The sender is not stamped as having delivered readings that were not stored.
    expect(stampLastSeen).not.toHaveBeenCalled();
  });

  it('gateway path: the whole batch is dead-lettered against the gateway and the children are not stamped', async () => {
    writeBatch.mockRejectedValueOnce(new Error('connection terminated'));
    const r = await ingestPayload({ identity: gw, raw: buf({ devices: { 'CH-A': { t: 1 } } }), transport: 'mqtt' });
    expect(r).toMatchObject({ ok: false, code: 'WRITE_FAILED' });
    const row = writeDeadLetters.mock.calls.at(-1)![0][0];
    expect(row).toMatchObject({ instrumentId: gw.id, transport: 'mqtt' });
    expect(row.reason).toContain('1 reading lost');
    expect(stampLastSeen).not.toHaveBeenCalled();
  });
});

/** Audit 2026-10-03, INGEST-8: a null reading is recorded, the other keys still land. */
describe('ingestPayload — a null reading is dead-lettered by key', () => {
  it('flat path: stores the other keys and records the null one', async () => {
    const r = await ingestPayload({ identity: plain, raw: buf({ t: null, h: 45.1 }), transport: 'mqtt' });
    expect(r).toMatchObject({ ok: true, accepted: 1 });
    const stored = writeBatch.mock.calls[0][0] as { key: string }[];
    expect(stored.map((x) => x.key)).toEqual(['h']);
    const row = writeDeadLetters.mock.calls[0][0][0];
    expect(row.reason).toContain('Null reading for "t"');
  });
});

/**
 * Audit 2026-10-12, finding 4: a payload that stores NOTHING (every key null,
 * or no keys at all) used to stamp last-seen and enqueue an evaluation, so a
 * dead probe sending `{"t":null}` never went INACTIVE.
 */
describe('ingestPayload — a payload that stores nothing is not a sign of life', () => {
  it('all-null flat payload: dead-lettered, not stamped, no evaluation', async () => {
    const r = await ingestPayload({ identity: plain, raw: buf({ t: null, h: null }), transport: 'mqtt' });
    expect(r).toMatchObject({ ok: true, accepted: 0 });
    expect(writeDeadLetters).toHaveBeenCalled();
    expect(stampLastSeen).not.toHaveBeenCalled();
    expect(enqueueAlarmEvaluation).not.toHaveBeenCalled();
  });

  it('empty flat payload: not stamped, no evaluation', async () => {
    const r = await ingestPayload({ identity: plain, raw: buf({}), transport: 'http' });
    expect(r).toMatchObject({ ok: true, accepted: 0 });
    expect(stampLastSeen).not.toHaveBeenCalled();
    expect(enqueueAlarmEvaluation).not.toHaveBeenCalled();
  });

  it('a payload with one real reading still stamps and enqueues', async () => {
    await ingestPayload({ identity: plain, raw: buf({ t: null, h: 40 }), transport: 'mqtt' });
    expect(stampLastSeen).toHaveBeenCalledWith(['i1'], 'direct');
    expect(enqueueAlarmEvaluation).toHaveBeenCalledTimes(1);
  });
});

/**
 * Audit 2026-10-12, finding 5: one block whose timestamp is older than every
 * partition failed the WHOLE multi-child batch — the good children's readings
 * were lost, and on HTTP the 503 made the gateway retry the same doomed batch
 * forever. Now the placeable readings are stored, only the unplaceable ones are
 * dead-lettered, and the unfixable part is reported as non-retryable.
 */
describe('ingestPayload — a reading older than every partition does not sink the batch', () => {
  const NO_PARTITION = 'no partition of relation "instrument_telemetry_history" found for row';
  const twoKids = new Map([['CH-A', { id: 'a1', isActive: true }], ['CH-B', { id: 'b1', isActive: true }]]);

  it('gateway path: stores the good child, dead-letters the old block, counts it rejected', async () => {
    childMapFor.mockResolvedValue(twoKids);
    earliestPartitionStart.mockResolvedValue(new Date('2026-08-01T00:00:00Z'));
    writeBatch.mockRejectedValueOnce(new Error(NO_PARTITION));
    const now = new Date().toISOString();
    const r = await ingestPayload({
      identity: gw,
      raw: buf({ devices: { 'CH-A': { t: 1, ts: '2019-06-01T00:00:00Z' }, 'CH-B': { t: 2, ts: now } } }),
      transport: 'http',
    });
    expect(r).toEqual({ ok: true, accepted: 1, rejected: 1 });
    const retried = writeBatch.mock.calls.at(-1)![0] as { instrumentId: string }[];
    expect(retried.map((x) => x.instrumentId)).toEqual(['b1']);
    const dl = writeDeadLetters.mock.calls.flatMap((c) => c[0] as { reason: string }[]);
    expect(dl.some((d) => /earliest stored partition/.test(d.reason))).toBe(true);
    expect(stampLastSeen).toHaveBeenCalledWith(['b1'], 'gateway');
    expect(enqueueAlarmEvaluation).toHaveBeenCalledTimes(1);
  });

  it('flat path: an unplaceable old reading is a NON-retryable refusal, not WRITE_FAILED', async () => {
    earliestPartitionStart.mockResolvedValue(new Date('2026-08-01T00:00:00Z'));
    writeBatch.mockRejectedValueOnce(new Error(NO_PARTITION));
    const r = await ingestPayload({ identity: plain, raw: buf({ t: 1, ts: '2019-06-01T00:00:00Z' }), transport: 'http' });
    expect(r).toMatchObject({ ok: false, code: 'TIMESTAMP_OUT_OF_RANGE' });
    expect(stampLastSeen).not.toHaveBeenCalled();
    expect(writeDeadLetters).toHaveBeenCalled();
  });

  it('a missing partition AHEAD of the oldest one (maintenance behind) stays retryable', async () => {
    earliestPartitionStart.mockResolvedValue(new Date('2019-01-01T00:00:00Z'));
    writeBatch.mockRejectedValue(new Error(NO_PARTITION));
    const r = await ingestPayload({ identity: plain, raw: buf({ t: 1, ts: '2019-06-01T00:00:00Z' }), transport: 'http' });
    expect(r).toMatchObject({ ok: false, code: 'WRITE_FAILED' });
  });
});

