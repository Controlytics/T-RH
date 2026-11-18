import { describe, it, expect, vi } from 'vitest';
import { createHistoryCountShare, historyCountKey, HISTORY_COUNT_SHARE_MS } from '../history-count-share.js';
import { envMs } from '../../../lib/shared-result.js';

/**
 * Performance audit G1-05 (2026-11-18): the merged history's instant count is computed ONCE per selection, never per
 * page. The single-flight / expiry / failure mechanics are `lib/shared-result.ts`'s (also pinned through
 * `overview-share.test.ts`); this pins what is the count's own — the key and the window.
 */
const FROM = new Date('2026-11-01T00:00:00.000Z');
const TO = new Date('2026-11-08T00:00:00.000Z');
const sel = (over: Record<string, unknown> = {}) => ({ instrumentIds: ['a', 'b'], from: FROM, to: TO, ...over });

function fixture(ttlMs = 60_000) {
  let t = 5_000_000;
  const count = vi.fn(async () => 1_252_831);
  const share = createHistoryCountShare(count, ttlMs, () => t);
  return { count, share, advance: (ms: number) => { t += ms; } };
}

describe('the history count share', () => {
  it('every page of one selection reuses ONE count', async () => {
    const { count, share } = fixture();
    const totals = await Promise.all([share(sel()), share(sel()), share(sel())]);
    expect(totals).toEqual([1_252_831, 1_252_831, 1_252_831]);
    expect(count).toHaveBeenCalledTimes(1);
  });

  it('holds it for the window, then counts again', async () => {
    const { count, share, advance } = fixture(60_000);
    await share(sel());
    advance(59_999);
    await share(sel());
    expect(count).toHaveBeenCalledTimes(1);
    advance(2);
    await share(sel());
    expect(count).toHaveBeenCalledTimes(2);
  });

  it('ids or keys in another order are the same selection', () => {
    expect(historyCountKey(sel({ instrumentIds: ['b', 'a'] }))).toBe(historyCountKey(sel()));
    expect(historyCountKey(sel({ keys: ['h', 't'] }))).toBe(historyCountKey(sel({ keys: ['t', 'h'] })));
    // No keys and an empty key list both mean "every key".
    expect(historyCountKey(sel({ keys: [] }))).toBe(historyCountKey(sel()));
  });

  it('another instrument set (another SCOPE), other keys or another period is another count', async () => {
    const { count, share } = fixture();
    await share(sel());
    await share(sel({ instrumentIds: ['a'] }));       // an OPERATOR who may see only `a` gets its own count
    await share(sel({ keys: ['t'] }));
    await share(sel({ from: new Date('2026-11-02T00:00:00.000Z') }));
    await share(sel({ to: new Date('2026-11-09T00:00:00.000Z') }));
    await share(sel({ from: undefined }));
    expect(count).toHaveBeenCalledTimes(6);
  });

  it('a failed count is not kept', async () => {
    let t = 0;
    const count = vi.fn().mockRejectedValueOnce(new Error('database down')).mockResolvedValueOnce(42);
    const share = createHistoryCountShare(count, 60_000, () => t);
    await expect(share(sel())).rejects.toThrow('database down');
    t += 1;
    await expect(share(sel())).resolves.toBe(42);
    expect(count).toHaveBeenCalledTimes(2);
  });

  it('the window comes from the environment: unset or unreadable = the default, 0 honoured (the test bootstrap sets 0)', () => {
    expect(HISTORY_COUNT_SHARE_MS).toBe(0);
    const NAME = 'HISTORY_COUNT_SHARE_MS_PROBE';
    try {
      delete process.env[NAME];
      expect(envMs(NAME, 60_000)).toBe(60_000);
      process.env[NAME] = 'not a number';
      expect(envMs(NAME, 60_000)).toBe(60_000);
      process.env[NAME] = '-5';
      expect(envMs(NAME, 60_000)).toBe(60_000);
      process.env[NAME] = '0';
      expect(envMs(NAME, 60_000)).toBe(0);
    } finally {
      delete process.env[NAME];
    }
  });
});
