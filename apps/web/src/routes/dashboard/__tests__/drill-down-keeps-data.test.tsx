import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, renderHook } from '@testing-library/react';

/**
 * Drilling into a location (the entry cards, the Block/Area picker) changes the
 * key of every selection-driven fetch. Left to SWR's default, `data` drops to
 * `undefined` on the key change, so every panel collapsed to a skeleton, the
 * auto-height grid shrank, and then grew again when the responses landed —
 * reported by the operator (2026-09-16) as widgets taking "2-3 sec to align
 * properly" after clicking All instruments. Keeping the previous data across
 * the change means the panels hold their rows until the new ones arrive and
 * the grid moves ONCE. Rows carry their own instrument codes, so a brief
 * stale set is not mislabeled.
 */
const calls: { key: string | null; opts: Record<string, unknown> | undefined }[] = [];
vi.mock('swr', () => ({
  default: (key: string | null, opts?: Record<string, unknown>) => {
    calls.push({ key, opts });
    return { data: undefined, error: undefined, isLoading: true, mutate: vi.fn() };
  },
}));
vi.mock('@/hooks/use-datetime-format', () => ({
  useDatetimeFormat: () => ({ formatDateTime: (v: string) => v, formatDate: (v: string) => v, formatTime: () => '' }),
}));

const { useTelemetryOverview } = await import('../use-telemetry');
const { AggregateTrendCard } = await import('../aggregate-trend-card');

beforeEach(() => { calls.length = 0; });

const optionsFor = (part: string) => calls.find((c) => c.key?.includes(part))?.opts;

describe('drill-down fetches keep the previous selection\'s data while the next loads', () => {
  it('the readings overview', () => {
    renderHook(() => useTelemetryOverview({ functionalLocationId: 'a1' }));
    expect(optionsFor('/telemetry-overview')).toMatchObject({ keepPreviousData: true });
  });

  it('the aggregate trend', () => {
    render(<AggregateTrendCard functionalLocationId="a1" window="24h" onWindowChange={() => undefined} />);
    expect(optionsFor('/telemetry-aggregate')).toMatchObject({ keepPreviousData: true });
  });
});
