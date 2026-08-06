import { describe, it, expect, vi, beforeEach } from 'vitest';

const findMany = vi.fn();
vi.mock('../../../lib/prisma.js', () => ({
  prisma: { instrument: { findMany: (...a: unknown[]) => findMany(...a) } },
}));

import { childMapFor, invalidateChildMapCache } from '../gateway-children.js';

beforeEach(() => { findMany.mockReset(); invalidateChildMapCache(); });

describe('childMapFor', () => {
  it('maps code -> {id, isActive}', async () => {
    findMany.mockResolvedValue([{ id: 'id-a', code: 'SENSOR-A', isActive: true }]);
    const map = await childMapFor('gw-1');
    expect(map.get('SENSOR-A')).toEqual({ id: 'id-a', isActive: true });
  });

  it('queries only this gateway\'s children', async () => {
    findMany.mockResolvedValue([]);
    await childMapFor('gw-1');
    expect(findMany.mock.calls[0][0]).toMatchObject({ where: { gatewayId: 'gw-1' } });
  });

  it('caches within the TTL', async () => {
    findMany.mockResolvedValue([]);
    await childMapFor('gw-1');
    await childMapFor('gw-1');
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('re-queries after invalidation — an unlinked child must stop being writable', async () => {
    findMany.mockResolvedValue([]);
    await childMapFor('gw-1');
    invalidateChildMapCache('gw-1');
    await childMapFor('gw-1');
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  /**
   * The read and the `cache.set` straddle an `await`. An invalidation that
   * lands in that window finds no entry to delete, so without a generation
   * counter the in-flight read — taken BEFORE the unlink committed — is
   * published afterwards and the unlinked child stays writable for a full TTL.
   */
  it('discards a result invalidated while the read was in flight', async () => {
    let resolveFind!: (rows: unknown[]) => void;
    findMany.mockImplementation(() => new Promise((r) => { resolveFind = r; }));

    const pending = childMapFor('gw-1');
    await Promise.resolve(); // let childMapFor reach its await
    invalidateChildMapCache('gw-1');
    resolveFind([{ id: 'id-a', code: 'SENSOR-A', isActive: true }]);
    await pending;

    // Nothing was cached, so the next call must go back to the database.
    findMany.mockResolvedValue([]);
    const after = await childMapFor('gw-1');
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(after.has('SENSOR-A')).toBe(false);
  });

  it('a blanket invalidation also discards an in-flight read', async () => {
    let resolveFind!: (rows: unknown[]) => void;
    findMany.mockImplementation(() => new Promise((r) => { resolveFind = r; }));

    const pending = childMapFor('gw-1');
    await Promise.resolve();
    invalidateChildMapCache();
    resolveFind([{ id: 'id-a', code: 'SENSOR-A', isActive: true }]);
    await pending;

    findMany.mockResolvedValue([]);
    await childMapFor('gw-1');
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('invalidating one gateway does not clear another', async () => {
    findMany.mockResolvedValue([]);
    await childMapFor('gw-1');
    await childMapFor('gw-2');
    invalidateChildMapCache('gw-1');
    await childMapFor('gw-2');
    expect(findMany).toHaveBeenCalledTimes(2);
  });
});
