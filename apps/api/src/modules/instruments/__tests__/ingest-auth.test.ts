import { describe, it, expect, vi, beforeEach } from 'vitest';

const findMany = vi.fn();
vi.mock('../../../lib/prisma.js', () => ({
  prisma: { instrumentCredential: { findMany: (...a: unknown[]) => findMany(...a) } },
}));

import { generateToken, hashToken, tokenPrefix } from '../token.js';
import { resolveInstrumentByToken, invalidateIngestAuthCache } from '../ingest-auth.js';

const row = (token: string, over: Record<string, unknown> = {}) => ({
  id: 'cred-1',
  tokenHash: hashToken(token),
  tokenPrefix: tokenPrefix(token),
  revokedAt: null,
  instrument: { id: 'inst-1', code: 'TEMP-01', transport: 'http', isActive: true },
  ...over,
});

beforeEach(() => { findMany.mockReset(); invalidateIngestAuthCache(); });

describe('resolveInstrumentByToken', () => {
  it('resolves a valid token to its instrument', async () => {
    const t = generateToken();
    findMany.mockResolvedValue([row(t)]);
    await expect(resolveInstrumentByToken(t)).resolves.toMatchObject({ id: 'inst-1', code: 'TEMP-01' });
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
});
