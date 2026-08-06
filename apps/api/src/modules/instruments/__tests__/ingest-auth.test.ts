import { describe, it, expect, vi, beforeEach } from 'vitest';

const findMany = vi.fn();
// `update` stamps lastUsedAt on a cache miss — the source of the "Last seen"
// column on the instruments list.
const update = vi.fn();
vi.mock('../../../lib/prisma.js', () => ({
  prisma: {
    instrumentCredential: {
      findMany: (...a: unknown[]) => findMany(...a),
      update: (...a: unknown[]) => update(...a),
    },
  },
}));

import { generateToken, hashToken, tokenPrefix } from '../token.js';
import { resolveInstrumentByToken, invalidateIngestAuthCache } from '../ingest-auth.js';

const row = (token: string, over: Record<string, unknown> = {}) => ({
  id: 'cred-1',
  tokenHash: hashToken(token),
  tokenPrefix: tokenPrefix(token),
  revokedAt: null,
  instrument: { id: 'inst-1', code: 'TEMP-01', transport: 'http', isActive: true, isGateway: false },
  ...over,
});

beforeEach(() => { findMany.mockReset(); update.mockReset(); update.mockResolvedValue({}); invalidateIngestAuthCache(); });

describe('resolveInstrumentByToken', () => {
  it('resolves a valid token to its instrument', async () => {
    const t = generateToken();
    findMany.mockResolvedValue([row(t)]);
    await expect(resolveInstrumentByToken(t)).resolves.toMatchObject({ id: 'inst-1', code: 'TEMP-01' });
  });

  it('stamps lastUsedAt on the matched credential — but only on a cache MISS', async () => {
    const t = generateToken();
    findMany.mockResolvedValue([row(t)]);

    await resolveInstrumentByToken(t);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toMatchObject({ where: { id: 'cred-1' } });

    // Second call inside the TTL is served from cache. A device posting every
    // second must not cost a write per reading.
    await resolveInstrumentByToken(t);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('returns null for an unknown token', async () => {
    findMany.mockResolvedValue([]);
    expect(await resolveInstrumentByToken(generateToken())).toBeNull();
  });

  it('returns null when the stored hash belongs to a different token', async () => {
    findMany.mockResolvedValue([row(generateToken())]);
    expect(await resolveInstrumentByToken(generateToken())).toBeNull();
  });

  it('refuses a revoked credential', async () => {
    const t = generateToken();
    findMany.mockResolvedValue([row(t, { revokedAt: new Date() })]);
    expect(await resolveInstrumentByToken(t)).toBeNull();
  });

  it('refuses an inactive instrument', async () => {
    const t = generateToken();
    findMany.mockResolvedValue([row(t, { instrument: { id: 'i', code: 'C', transport: 'http', isActive: false } })]);
    expect(await resolveInstrumentByToken(t)).toBeNull();
  });

  it('caches so a hot device does not hit the DB every reading', async () => {
    const t = generateToken();
    findMany.mockResolvedValue([row(t)]);
    await resolveInstrumentByToken(t);
    await resolveInstrumentByToken(t);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('re-queries after the cache is invalidated — revocation must take effect', async () => {
    const t = generateToken();
    findMany.mockResolvedValue([row(t)]);
    await resolveInstrumentByToken(t);
    invalidateIngestAuthCache();
    findMany.mockResolvedValue([]);
    expect(await resolveInstrumentByToken(t)).toBeNull();
  });

  it('expires positive cache after TTL boundary', async () => {
    vi.useFakeTimers();
    const t = generateToken();
    findMany.mockResolvedValue([row(t)]);

    // First call: DB hit, cache stored with timestamp.
    await resolveInstrumentByToken(t);
    expect(findMany).toHaveBeenCalledTimes(1);

    // Advance to 9_999ms (just before TTL): cache hit.
    vi.advanceTimersByTime(9_999);
    await resolveInstrumentByToken(t);
    expect(findMany).toHaveBeenCalledTimes(1);

    // Advance to 10_001ms (past TTL): cache miss, DB queried again.
    vi.advanceTimersByTime(2);
    await resolveInstrumentByToken(t);
    expect(findMany).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('expires negative cache after TTL boundary', async () => {
    vi.useFakeTimers();
    const t = generateToken();
    findMany.mockResolvedValue([]);

    // First call: miss, negative cache stored with timestamp.
    expect(await resolveInstrumentByToken(t)).toBeNull();
    expect(findMany).toHaveBeenCalledTimes(1);

    // Advance to 9_999ms (just before TTL): negative cache hit, no DB query.
    vi.advanceTimersByTime(9_999);
    expect(await resolveInstrumentByToken(t)).toBeNull();
    expect(findMany).toHaveBeenCalledTimes(1);

    // Advance to 10_001ms (past TTL): negative cache miss, DB queried again.
    vi.advanceTimersByTime(2);
    expect(await resolveInstrumentByToken(t)).toBeNull();
    expect(findMany).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });
});
