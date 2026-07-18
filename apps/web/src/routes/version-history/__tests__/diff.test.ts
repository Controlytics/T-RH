/**
 * Regression suite for the snapshot diff engine in
 * `apps/web/src/routes/version-history/index.tsx` (added in commit d31ed37 —
 * "Version History v3 — interactive diff timeline").
 *
 * The engine is purely functional and is exported from the page module — no
 * React rendering needed here. Each test maps to a distinct branch in
 * `diffSnapshots()` so a regression in any branch surfaces as exactly one
 * failing case.
 *
 * Branches covered:
 *   1. Scalar field change                       → 'changed' diff
 *   2. Keyed-array item added                    → 'added' diff with context
 *   3. Keyed-array item removed                  → 'removed' diff with context
 *   4. Keyed-array item field change             → recursive 'changed' diff inside item
 *   5. Meta fields filtered out                  → empty diff when only meta differs
 *   6. No-change case (deep-equal snapshots)     → empty diff
 *   7. Cross-kind: checklist `questions` keyed-by id
 *   8. Cross-kind: equipment-group `instruments` keyed-by id
 */
import { describe, it, expect } from 'vitest';
import { diffSnapshots, type DiffChange } from '../index';

// Helpers — keep the test data small and the assertions specific.
const findByPath = (changes: DiffChange[], path: string) => changes.find(c => c.path === path);

describe('diffSnapshots() — cleaning-profile', () => {
  it('reports a scalar field change as a single `changed` diff', () => {
    const prev = { name: 'Profile A', flowMode: 'STRICT', stages: [], connections: [], cleaningReasons: [] };
    const curr = { name: 'Profile A', flowMode: 'LENIENT', stages: [], connections: [], cleaningReasons: [] };
    const changes = diffSnapshots('cleaning-profile', prev, curr);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: 'changed', path: 'flowMode', oldValue: 'STRICT', newValue: 'LENIENT' });
  });

  it('detects a keyed-array stage addition (keyed by id)', () => {
    const prev = { stages: [{ id: 'stage-1', stateKey: 'WASH_IN', sortOrder: 1 }] };
    const curr = {
      stages: [
        { id: 'stage-1', stateKey: 'WASH_IN', sortOrder: 1 },
        { id: 'stage-2-newly-added', stateKey: 'DRY_IN', sortOrder: 2 },
      ],
    };
    const changes = diffSnapshots('cleaning-profile', prev, curr);
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe('added');
    expect(changes[0].path).toMatch(/^stages\[/);
    expect(changes[0].context).toContain('id=stage-2-');
  });

  it('detects a keyed-array stage removal (keyed by id)', () => {
    const prev = {
      stages: [
        { id: 'stage-1', stateKey: 'WASH_IN', sortOrder: 1 },
        { id: 'stage-2-being-removed', stateKey: 'DRY_IN', sortOrder: 2 },
      ],
    };
    const curr = { stages: [{ id: 'stage-1', stateKey: 'WASH_IN', sortOrder: 1 }] };
    const changes = diffSnapshots('cleaning-profile', prev, curr);
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe('removed');
    expect(changes[0].path).toMatch(/^stages\[/);
    expect(changes[0].context).toContain('id=stage-2-');
  });

  it('recurses into a keyed-array item when its fields change (skipping meta keys like `id`)', () => {
    // The id stays the same — the engine pairs by id and recurses on fields.
    // META_FIELDS includes `id`, so even though both sides carry `id`, no
    // `stages[...].id` diff should appear. Only the changed field surfaces.
    const prev = { stages: [{ id: 'stage-1', stateKey: 'WASH_IN', sortOrder: 1 }] };
    const curr = { stages: [{ id: 'stage-1', stateKey: 'WASH_OUT', sortOrder: 1 }] };
    const changes = diffSnapshots('cleaning-profile', prev, curr);
    expect(changes).toHaveLength(1);
    const c = changes[0];
    expect(c.kind).toBe('changed');
    // Path is built from the item's labelFor() fallback; we don't pin the
    // exact label format, only that it lives under stages[...] and ends in
    // `.stateKey`.
    expect(c.path).toMatch(/^stages\[.+\]\.stateKey$/);
    if (c.kind === 'changed') {
      expect(c.oldValue).toBe('WASH_IN');
      expect(c.newValue).toBe('WASH_OUT');
    }
  });
});

describe('diffSnapshots() — meta-field filtering and no-change cases', () => {
  it('filters out META_FIELDS even when they differ between snapshots', () => {
    // Every meta key changes; nothing else does. Output must be empty.
    const prev = {
      createdAt: '2026-04-01T00:00:00Z',
      updatedAt: '2026-04-01T00:00:00Z',
      createdBy: 'user-alpha',
      updatedBy: 'user-alpha',
      versionNumber: 1,
      version: 1,
      changeNotes: null,
      profileId: 'p-old',
      groupId: 'g-old',
      id: 'row-old',
      lineageId: 'L-old',
      name: 'identical name',
    };
    const curr = {
      createdAt: '2026-05-01T00:00:00Z',
      updatedAt: '2026-05-02T00:00:00Z',
      createdBy: 'user-beta',
      updatedBy: 'user-beta',
      versionNumber: 2,
      version: 2,
      changeNotes: 'edited',
      profileId: 'p-new',
      groupId: 'g-new',
      id: 'row-new',
      lineageId: 'L-new',
      name: 'identical name',
    };
    const changes = diffSnapshots('cleaning-profile', prev, curr);
    expect(changes).toEqual([]);
  });

  it('returns an empty array when snapshots are deep-equal (no-change case)', () => {
    const snap = {
      name: 'Stable Profile',
      flowMode: 'STRICT',
      stages: [{ id: 's-1', stateKey: 'WASH_IN', sortOrder: 1 }],
      connections: [{ id: 'c-1', fromStageId: 's-1', toStageId: 's-1' }],
      cleaningReasons: [{ key: 'ROUTINE', name: 'Routine' }],
    };
    // Pass distinct object references with identical content — the engine
    // must not report any change.
    const changes = diffSnapshots('cleaning-profile', { ...snap }, { ...snap });
    expect(changes).toEqual([]);
  });
});

describe('diffSnapshots() — checklist-profile and equipment-group keyed arrays', () => {
  it('detects a checklist question added (keyed by id)', () => {
    const prev = { questions: [{ id: 'q-1', question: 'Did you wash?', sortOrder: 1 }] };
    const curr = {
      questions: [
        { id: 'q-1', question: 'Did you wash?', sortOrder: 1 },
        { id: 'q-2-new', question: 'Did you dry?', sortOrder: 2 },
      ],
    };
    const changes = diffSnapshots('checklist-profile', prev, curr);
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe('added');
    expect(changes[0].path).toMatch(/^questions\[/);
    expect(changes[0].context).toContain('id=q-2-new');
  });

  it('detects an equipment-group instrument field change (keyed by id)', () => {
    const prev = {
      instruments: [
        { id: 'inst-1', description: 'Pressure gauge', operatingMin: 0, operatingMax: 10, sortOrder: 1 },
      ],
    };
    const curr = {
      instruments: [
        { id: 'inst-1', description: 'Pressure gauge', operatingMin: 0, operatingMax: 20, sortOrder: 1 },
      ],
    };
    const changes = diffSnapshots('equipment-group', prev, curr);
    // Only `operatingMax` changed. `id` is in META_FIELDS so it is suppressed.
    const change = findByPath(changes, 'instruments[Pressure gauge].operatingMax');
    expect(change).toBeDefined();
    expect(change?.kind).toBe('changed');
    if (change?.kind === 'changed') {
      expect(change.oldValue).toBe(10);
      expect(change.newValue).toBe(20);
    }
    // Defensive: nothing else should slip through.
    expect(changes).toHaveLength(1);
  });
});
