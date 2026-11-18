import { describe, it, expect, vi } from 'vitest';
import { createOverviewShare, overviewShareKey } from '../overview-share.js';

/**
 * Performance audit 2026-11-17, P-02 / G2-01: one overview computation per
 * selection per 5 s, shared by every viewer asking the same question.
 */
type Rows = Awaited<ReturnType<Parameters<typeof createOverviewShare>[0]>>;
const ROWS = (n: number) => Array.from({ length: n }, (_, i) => ({ instrumentId: `i${i}` })) as unknown as Rows;

function fixture(ttlMs = 5_000) {
  let t = 1_000_000;
  const build = vi.fn(async () => ROWS(2));
  const share = createOverviewShare(build, ttlMs, () => t);
  return { build, share, advance: (ms: number) => { t += ms; } };
}

describe('the overview share', () => {
  it('concurrent viewers with the same scope share ONE computation', async () => {
    const { build, share } = fixture();
    const [a, b, c] = await Promise.all([share({}), share({}), share({})]);
    expect(build).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('serves the result for the share window, then computes again', async () => {
    const { build, share, advance } = fixture(5_000);
    await share({});
    advance(4_999);
    await share({});
    expect(build).toHaveBeenCalledTimes(1);
    advance(2);
    await share({});
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('a different visibility scope, or a different selection, is a different question', async () => {
    const { build, share } = fixture();
    await share({});
    await share({ visibilityWhere: { OR: [{ functionalLocationId: { in: ['fl-1'] } }] } });
    await share({ profileId: 'p-1' });
    await share({ instrumentIds: ['a', 'b'] });
    await share({ functionalLocationId: 'fl-1' });
    await share({ functionalLocationId: 'fl-1', functionalLocationDirect: true });
    expect(build).toHaveBeenCalledTimes(6);
  });

  it('instrument ids in another order are the same question (rows come back ordered by code)', async () => {
    const { build, share } = fixture();
    await share({ instrumentIds: ['b', 'a'] });
    await share({ instrumentIds: ['a', 'b'] });
    expect(build).toHaveBeenCalledTimes(1);
    expect(overviewShareKey({ instrumentIds: ['b', 'a'] })).toBe(overviewShareKey({ instrumentIds: ['a', 'b'] }));
  });

  it('a FAILED computation is never kept — the next viewer asks again', async () => {
    let t = 0;
    const build = vi.fn()
      .mockRejectedValueOnce(new Error('database down'))
      .mockResolvedValueOnce(ROWS(1));
    const share = createOverviewShare(build, 5_000, () => t);
    await expect(share({})).rejects.toThrow('database down');
    t += 1;
    await expect(share({})).resolves.toHaveLength(1);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('with a share window of 0 only what is IN FLIGHT is shared', async () => {
    const { build, share } = fixture(0);
    await Promise.all([share({}), share({})]);
    expect(build).toHaveBeenCalledTimes(1);
    await share({});
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('the shared rows are frozen: a caller that mutated them would change another user\'s answer', async () => {
    const { share } = fixture();
    const rows = await share({});
    expect(Object.isFrozen(rows)).toBe(true);
    expect(() => { (rows[0] as unknown as { instrumentId: string }).instrumentId = 'x'; }).toThrow(TypeError);
  });
});
