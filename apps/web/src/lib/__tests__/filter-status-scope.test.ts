import { describe, expect, test } from 'vitest';
import {
  ALL,
  countByStage,
  scopeFiltersToCascade,
  type FilterAncestry,
} from '../filter-status-scope';

type Row = { id: string; name: string; currentLifecycleState?: string | null };

const rows: Row[] = [
  { id: 'f1', name: 'HF-1', currentLifecycleState: 'WASH_IN' },
  { id: 'f2', name: 'HF-2', currentLifecycleState: 'WASH_IN' },
  { id: 'f3', name: 'HF-3', currentLifecycleState: 'DRY_IN' },
  { id: 'f4', name: 'HF-4', currentLifecycleState: 'CLEANING_CYCLE_COMPLETED' },
  { id: 'f5', name: 'HF-5', currentLifecycleState: null },
];

// f1,f2 -> ahu1/area1/blockA ; f3,f4 -> ahu2/area2/blockB ; f5 -> ahu1/area1/blockA
const ancestors = new Map<string, FilterAncestry>([
  ['f1', { ahuId: 'ahu1', areaId: 'area1', blockId: 'blockA' }],
  ['f2', { ahuId: 'ahu1', areaId: 'area1', blockId: 'blockA' }],
  ['f3', { ahuId: 'ahu2', areaId: 'area2', blockId: 'blockB' }],
  ['f4', { ahuId: 'ahu2', areaId: 'area2', blockId: 'blockB' }],
  ['f5', { ahuId: 'ahu1', areaId: 'area1', blockId: 'blockA' }],
]);

const noSelection = { blockId: ALL, areaId: ALL, ahuId: ALL, filterId: ALL };
const idsOf = (r: Row[]) => r.map((x) => x.id);

describe('scopeFiltersToCascade', () => {
  test('returns everything when nothing is selected', () => {
    expect(idsOf(scopeFiltersToCascade(rows, ancestors, noSelection))).toEqual([
      'f1',
      'f2',
      'f3',
      'f4',
      'f5',
    ]);
  });

  test('scopes to the selected block', () => {
    const result = scopeFiltersToCascade(rows, ancestors, { ...noSelection, blockId: 'blockA' });

    expect(idsOf(result)).toEqual(['f1', 'f2', 'f5']);
  });

  test('scopes to the selected area', () => {
    const result = scopeFiltersToCascade(rows, ancestors, { ...noSelection, areaId: 'area2' });

    expect(idsOf(result)).toEqual(['f3', 'f4']);
  });

  test('scopes to the selected AHU', () => {
    const result = scopeFiltersToCascade(rows, ancestors, { ...noSelection, ahuId: 'ahu1' });

    expect(idsOf(result)).toEqual(['f1', 'f2', 'f5']);
  });

  test('scopes to a single selected filter', () => {
    const result = scopeFiltersToCascade(rows, ancestors, { ...noSelection, filterId: 'f3' });

    expect(idsOf(result)).toEqual(['f3']);
  });

  test('applies every level of the selection together', () => {
    const result = scopeFiltersToCascade(rows, ancestors, {
      blockId: 'blockA',
      areaId: 'area1',
      ahuId: 'ahu1',
      filterId: 'f2',
    });

    expect(idsOf(result)).toEqual(['f2']);
  });

  test('drops a filter whose ancestry is unknown rather than leaking it', () => {
    const orphan: Row[] = [{ id: 'ghost', name: 'GHOST', currentLifecycleState: 'WASH_IN' }];

    expect(scopeFiltersToCascade(orphan, ancestors, noSelection)).toEqual([]);
  });

  test('returns nothing when the selection matches no filter', () => {
    const result = scopeFiltersToCascade(rows, ancestors, { ...noSelection, blockId: 'blockZ' });

    expect(result).toEqual([]);
  });
});

describe('countByStage', () => {
  test('counts each lifecycle state present', () => {
    expect(countByStage(rows)).toEqual({
      WASH_IN: 2,
      DRY_IN: 1,
      CLEANING_CYCLE_COMPLETED: 1,
    });
  });

  test('ignores filters with no lifecycle state', () => {
    expect(countByStage([{ currentLifecycleState: null }, { currentLifecycleState: undefined }])).toEqual(
      {},
    );
  });

  test('counts nothing for an empty list', () => {
    expect(countByStage([])).toEqual({});
  });

  test('counts agree with the scoped list — the tile/list mismatch guard', () => {
    // The 2026-07-17 bug: counts were computed over ALL filters while the list
    // was cascade-scoped, so a tile read 2 while the list showed 1. Deriving
    // both from the same scoped array is what makes them agree.
    const scoped = scopeFiltersToCascade(rows, ancestors, { ...noSelection, blockId: 'blockA' });

    expect(countByStage(scoped).WASH_IN).toBe(2);
    expect(scoped.filter((f) => f.currentLifecycleState === 'WASH_IN')).toHaveLength(2);
    expect(countByStage(scoped).DRY_IN).toBeUndefined();
  });
});
