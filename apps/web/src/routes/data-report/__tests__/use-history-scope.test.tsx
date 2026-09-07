import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * The page's selection hook (2026-09-07). Review finding: the selection used to
 * be reset by an EFFECT on the scope, which (a) committed one render with the
 * previous scope's ticks — firing the merged-history query for a set the
 * operator had just left — and (b) could not reset the widget's page when the
 * selection stayed `null` across two Blocks, so page 3's offset went to the new
 * scope and printed "No readings" under a live pagination bar. The reset now
 * happens IN the handlers, synchronously, and the hook exposes `scopeId` so the
 * widget can key its page reset on the scope itself.
 */
const tree = [{ id: 'b1', name: 'CWH Block', children: [{ id: 'a1', name: 'QC 3' }] }, { id: 'b2', name: 'Other', children: [] }];
const instruments = [{ id: 'i1', code: 'A', name: 'A', functionalLocationId: 'a1' }, { id: 'i2', code: 'B', name: 'B', functionalLocationId: 'a1' }];
const requested: string[] = [];

vi.mock('swr', () => ({
  default: (key: any) => {
    const k = typeof key === 'function' ? key() : key;
    if (typeof k === 'string') requested.push(k);
    if (typeof k === 'string' && k.includes('/api/functional-locations')) return { data: { data: tree } };
    if (typeof k === 'string' && k.startsWith('/api/instruments?')) return { data: { data: instruments, total: 2 } };
    if (typeof k === 'string' && k.includes('/telemetry-overview')) return { data: { data: [] } };
    return { data: undefined };
  },
}));
vi.mock('@/lib/api-client', () => ({ apiClient: { get: vi.fn(), post: vi.fn(), postWithReauth: vi.fn() } }));

const { useHistoryScope } = await import('../use-history-scope');

describe('useHistoryScope', () => {
  it('selects everything the moment a Block is chosen, in the SAME render — no effect, no intermediate state', () => {
    const { result } = renderHook(() => useHistoryScope());
    expect(result.current.selected).toEqual(new Set());
    expect(result.current.chosen).toEqual([]);
    act(() => result.current.setBlock('b1'));
    expect(result.current.selected).toBeNull();
    expect(result.current.scopeId).toBe('b1');
    expect(result.current.chosen.map((i) => i.code)).toEqual(['A', 'B']);
  });

  it('drops the previous scope\'s ticks when the scope changes, and clears to nothing when the scope is cleared', () => {
    const { result } = renderHook(() => useHistoryScope());
    act(() => result.current.setBlock('b1'));
    act(() => result.current.setSelected(new Set(['i1'])));
    expect(result.current.chosen.map((i) => i.code)).toEqual(['A']);
    // Area within the same Block: the ticks are stale for the new scope.
    act(() => result.current.setArea('a1'));
    expect(result.current.selected).toBeNull();
    expect(result.current.scopeId).toBe('a1');
    // Block cleared: no scope, nothing selected.
    act(() => result.current.setBlock(''));
    expect(result.current.selected).toEqual(new Set());
    expect(result.current.scopeId).toBeNull();
    expect(result.current.chosen).toEqual([]);
  });

  it('reads the overview through the administered-refresh hook, not a bare key', () => {
    // `useTelemetryOverview` polls on the administered interval and revalidates
    // on focus; a bare `useSWR` would freeze a limit changed while the page is
    // open into a signed document.
    const { result } = renderHook(() => useHistoryScope());
    expect(result.current.overviewById).toBeInstanceOf(Map);
    expect(requested.some((k) => k === '/api/instruments/telemetry-overview')).toBe(true);
  });
});
