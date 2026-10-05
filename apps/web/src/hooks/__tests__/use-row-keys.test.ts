import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useRowKeys } from '../use-row-keys';

/**
 * audit 2026-10-03, WEB-14. An index key reuses row 2's DOM node for the old
 * row 3 after a removal, and the caret lands in the wrong input. These keys
 * follow the ROW.
 */
describe('useRowKeys', () => {
  it('keeps a row\'s key when a row ABOVE it is removed, given remove(i) before the state update', () => {
    const { result, rerender } = renderHook(({ n }) => useRowKeys(n), { initialProps: { n: 3 } });
    const k0 = result.current.at(0);
    const k1 = result.current.at(1);
    const k2 = result.current.at(2);
    expect(new Set([k0, k1, k2]).size).toBe(3);

    result.current.remove(1);
    rerender({ n: 2 });
    expect(result.current.at(0)).toBe(k0);
    // The old row 2 is now row 1 and still has ITS key — not row 1's.
    expect(result.current.at(1)).toBe(k2);
    expect(result.current.at(1)).not.toBe(k1);
  });

  it('keeps existing keys and mints new ones when the list grows', () => {
    const { result, rerender } = renderHook(({ n }) => useRowKeys(n), { initialProps: { n: 1 } });
    const k0 = result.current.at(0);
    rerender({ n: 3 });
    expect(result.current.at(0)).toBe(k0);
    expect(result.current.at(1)).not.toBe(k0);
    expect(result.current.at(2)).not.toBe(result.current.at(1));
  });

  it('without remove(i), a shrink can only truncate the tail — the defect the call exists to avoid', () => {
    const { result, rerender } = renderHook(({ n }) => useRowKeys(n), { initialProps: { n: 3 } });
    const k1 = result.current.at(1);
    rerender({ n: 2 });
    expect(result.current.at(1)).toBe(k1);
  });
});
