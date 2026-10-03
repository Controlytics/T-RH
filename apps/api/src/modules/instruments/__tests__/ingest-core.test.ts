import { describe, it, expect, vi, beforeEach } from 'vitest';

const writeBatch = vi.fn(); const writeDeadLetters = vi.fn();
const childMapFor = vi.fn(); const stampLastSeen = vi.fn();
vi.mock('../telemetry.repository.js', () => ({
  writeBatch: (...a: unknown[]) => writeBatch(...a),
  writeDeadLetters: (...a: unknown[]) => writeDeadLetters(...a),
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

