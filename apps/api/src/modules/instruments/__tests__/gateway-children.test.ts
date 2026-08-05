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

  it('invalidating one gateway does not clear another', async () => {
    findMany.mockResolvedValue([]);
    await childMapFor('gw-1');
    await childMapFor('gw-2');
    invalidateChildMapCache('gw-1');
    await childMapFor('gw-2');
    expect(findMany).toHaveBeenCalledTimes(2);
  });
});
