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
