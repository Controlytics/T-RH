import { describe, it, expect, vi, beforeEach } from 'vitest';

const updateMany = vi.fn();
vi.mock('../../../lib/prisma.js', () => ({
  prisma: { instrument: { updateMany: (...a: unknown[]) => updateMany(...a) } },
}));

import { stampLastSeen, resetLastSeenThrottle } from '../last-seen.js';

beforeEach(() => { updateMany.mockReset(); updateMany.mockResolvedValue({ count: 1 }); resetLastSeenThrottle(); });

describe('stampLastSeen', () => {
  it('records who reported and how', async () => {
    await stampLastSeen(['id-a'], 'gateway');
    expect(updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: { in: ['id-a'] } },
      data: { lastSeenVia: 'gateway' },
    });
  });

  it('throttles repeats within the window', async () => {
    await stampLastSeen(['id-a'], 'direct');
    await stampLastSeen(['id-a'], 'direct');
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it('does not throttle a different instrument', async () => {
    await stampLastSeen(['id-a'], 'direct');
    await stampLastSeen(['id-b'], 'direct');
    expect(updateMany).toHaveBeenCalledTimes(2);
  });

  it('stamps immediately when the source changes — direct vs gateway is the point', async () => {
    await stampLastSeen(['id-a'], 'direct');
    await stampLastSeen(['id-a'], 'gateway');
    expect(updateMany).toHaveBeenCalledTimes(2);
  });

  it('is a no-op for an empty list', async () => {
    await stampLastSeen([], 'direct');
    expect(updateMany).not.toHaveBeenCalled();
  });
});
