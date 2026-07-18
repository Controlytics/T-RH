import { describe, it, expect, vi } from 'vitest';
import { findNextPendingChecklist } from '../next-pending-checklist';
import type { PendingChecklist } from '../types';

/**
 * Regression tests for the multi-filter batch-checklist cycling helper —
 * fixes the bug documented in `PHASE_5_RECENT_WORK.md § 11` ("Multi-filter
 * batch checklist dialog — currently opens for first item only").
 *
 * The helper drives the post-advance cycle: after each filter's checklist is
 * submitted, the page calls this with the REMAINING batch + a resolver that
 * asks the action tape whether each filter still has a pending dialog. The
 * pre-fix code only looped to find the FIRST pending dialog and then
 * dropped the rest — these tests pin the new behavior.
 */

const mkRows = (n = 1): PendingChecklist[] =>
  Array.from({ length: n }, (_, i) => ({
    pipelineNodeId: `node-${i}`,
    checklistProfileId: `prof-${i}`,
    checklistProfileName: `Profile ${i}`,
    questions: [
      {
        id: `q-${i}`,
        question: `Q${i}`,
        questionType: 'TEXT',
        required: true,
        section: null,
        description: null,
        options: [],
        sortOrder: 0,
      },
    ],
  }));

describe('findNextPendingChecklist', () => {
  it('returns null on empty batch', async () => {
    const resolver = vi.fn();
    const result = await findNextPendingChecklist([], resolver);
    expect(result).toBeNull();
    expect(resolver).not.toHaveBeenCalled();
  });

  it('returns null when no filter has a pending checklist', async () => {
    const resolver = vi.fn().mockResolvedValue(null);
    const batch = [
      { filterId: 'a', filterName: 'A' },
      { filterId: 'b', filterName: 'B' },
      { filterId: 'c', filterName: 'C' },
    ];
    const result = await findNextPendingChecklist(batch, resolver);
    expect(result).toBeNull();
    expect(resolver).toHaveBeenCalledTimes(3);
  });

  it('returns the first pending filter and the remainder of the batch', async () => {
    const resolver = vi.fn().mockResolvedValue(mkRows());
    const batch = [
      { filterId: 'a', filterName: 'A' },
      { filterId: 'b', filterName: 'B' },
      { filterId: 'c', filterName: 'C' },
    ];
    const result = await findNextPendingChecklist(batch, resolver);
    expect(result).not.toBeNull();
    expect(result!.item.filterId).toBe('a');
    expect(result!.checklists).toHaveLength(1);
    expect(result!.remaining).toEqual([
      { filterId: 'b', filterName: 'B' },
      { filterId: 'c', filterName: 'C' },
    ]);
    // Stops at first match — does NOT call resolver for b/c.
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('skips filters that resolve to null and picks the next pending one', async () => {
    // Bug-pin: pre-fix code stopped at the first iteration regardless. The
    // new helper must walk PAST a null result and surface a later match.
    const resolver = vi
      .fn()
      .mockResolvedValueOnce(null) // a — already submitted on prior cycle
      .mockResolvedValueOnce(null) // b — never had one
      .mockResolvedValueOnce(mkRows()); // c — still needs dialog
    const batch = [
      { filterId: 'a', filterName: 'A' },
      { filterId: 'b', filterName: 'B' },
      { filterId: 'c', filterName: 'C' },
    ];
    const result = await findNextPendingChecklist(batch, resolver);
    expect(result!.item.filterId).toBe('c');
    expect(result!.remaining).toEqual([]); // c was last → nothing left after
    expect(resolver).toHaveBeenCalledTimes(3);
  });

  it('skips filters that resolve to an empty array (treated as "no dialog")', async () => {
    const resolver = vi
      .fn()
      .mockResolvedValueOnce([]) // empty array → not a real dialog
      .mockResolvedValueOnce(mkRows());
    const batch = [
      { filterId: 'a', filterName: 'A' },
      { filterId: 'b', filterName: 'B' },
    ];
    const result = await findNextPendingChecklist(batch, resolver);
    expect(result!.item.filterId).toBe('b');
  });

  it('skips filters whose resolver throws and continues with the rest', async () => {
    // A single resolver failure must not poison the whole cycle — the
    // operator can re-scan that filter individually if needed.
    const resolver = vi
      .fn()
      .mockRejectedValueOnce(new Error('cache read failed'))
      .mockResolvedValueOnce(mkRows());
    const batch = [
      { filterId: 'a', filterName: 'A' },
      { filterId: 'b', filterName: 'B' },
    ];
    const result = await findNextPendingChecklist(batch, resolver);
    expect(result!.item.filterId).toBe('b');
  });

  it('cycles correctly across multiple iterations (simulates full submit loop)', async () => {
    // End-to-end: the page would call findNextPendingChecklist, submit, then
    // call again with `result.remaining`. After the LAST pending filter is
    // submitted the helper must return null so the page clears the queue.
    const pending = new Set(['a', 'c']); // b has no checklist
    const resolver = vi.fn(async (id: string) => (pending.has(id) ? mkRows() : null));

    let queue: { filterId: string; filterName: string }[] = [
      { filterId: 'a', filterName: 'A' },
      { filterId: 'b', filterName: 'B' },
      { filterId: 'c', filterName: 'C' },
    ];
    const opened: string[] = [];

    // Iteration 1: opens for `a`, remaining = [b, c]
    let r = await findNextPendingChecklist(queue, resolver);
    expect(r).not.toBeNull();
    opened.push(r!.item.filterId);
    pending.delete(r!.item.filterId); // simulate submit
    queue = r!.remaining;

    // Iteration 2: skips `b` (null), opens for `c`, remaining = []
    r = await findNextPendingChecklist(queue, resolver);
    expect(r).not.toBeNull();
    opened.push(r!.item.filterId);
    pending.delete(r!.item.filterId);
    queue = r!.remaining;

    // Iteration 3: empty batch → null → page clears the cycle state
    r = await findNextPendingChecklist(queue, resolver);
    expect(r).toBeNull();

    expect(opened).toEqual(['a', 'c']);
  });
});
