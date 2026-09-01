import { describe, it, expect } from 'vitest';
import { expandLocations, targetMatches } from '../target-scope.js';
import type { AlarmWebhookTargetShape } from '@digilog/shared';

// BLOCK-1 has two areas; AREA-3 belongs to another block.
const NODES = [
  { id: 'BLOCK-1', parentId: null, type: 'BLOCK' as const, name: 'CWH' },
  { id: 'AREA-1', parentId: 'BLOCK-1', type: 'AREA' as const, name: 'QC-3' },
  { id: 'AREA-2', parentId: 'BLOCK-1', type: 'AREA' as const, name: 'Stability' },
  { id: 'BLOCK-2', parentId: null, type: 'BLOCK' as const, name: 'Module E' },
  { id: 'AREA-3', parentId: 'BLOCK-2', type: 'AREA' as const, name: 'Cold room' },
];

const target = (over: Partial<AlarmWebhookTargetShape> = {}): AlarmWebhookTargetShape => ({
  id: 'T1',
  isActive: true,
  fireOnRaised: true,
  fireOnCleared: true,
  fireOnAcknowledged: true,
  severities: null,
  scopeLocationIds: [],
  scopeInstrumentIds: [],
  ...over,
});

const ctx = (over: Partial<Parameters<typeof targetMatches>[1]> = {}) => ({
  event: 'RAISED' as const,
  severity: 'MAJOR',
  instrumentId: 'INST-1',
  functionalLocationId: 'AREA-1',
  locations: new Set<string>(),
  ...over,
});

describe('expandLocations', () => {
  it('expands a Block to itself plus its Areas', () => {
    expect([...expandLocations(['BLOCK-1'], NODES)].sort()).toEqual(['AREA-1', 'AREA-2', 'BLOCK-1']);
  });

  it('leaves an Area as itself', () => {
    expect([...expandLocations(['AREA-3'], NODES)]).toEqual(['AREA-3']);
  });

  it('ignores an id that is not in the tree', () => {
    expect([...expandLocations(['GONE'], NODES)]).toEqual([]);
  });

  it('is empty for an empty scope', () => {
    expect(expandLocations([], NODES).size).toBe(0);
  });
});

describe('targetMatches', () => {
  // THE most important assertion in this file.
  it('matches NOTHING when both scope lists are empty', () => {
    expect(targetMatches(target(), ctx())).toBe(false);
  });

  it('matches an explicitly listed instrument', () => {
    expect(targetMatches(target({ scopeInstrumentIds: ['INST-1'] }), ctx())).toBe(true);
  });

  it('matches an instrument inside a scoped Block', () => {
    const t = target({ scopeLocationIds: ['BLOCK-1'] });
    const locations = expandLocations(t.scopeLocationIds, NODES);
    expect(targetMatches(t, ctx({ locations }))).toBe(true);
  });

  it('does not match an instrument in a different block', () => {
    const t = target({ scopeLocationIds: ['BLOCK-2'] });
    const locations = expandLocations(t.scopeLocationIds, NODES);
    expect(targetMatches(t, ctx({ locations }))).toBe(false);
  });

  it('unions the two lists', () => {
    const t = target({ scopeLocationIds: ['BLOCK-2'], scopeInstrumentIds: ['INST-1'] });
    const locations = expandLocations(t.scopeLocationIds, NODES);
    expect(targetMatches(t, ctx({ locations }))).toBe(true);
  });

  it('reaches an unassigned instrument only through the explicit list', () => {
    const t = target({ scopeLocationIds: ['BLOCK-1'] });
    const locations = expandLocations(t.scopeLocationIds, NODES);
    expect(targetMatches(t, ctx({ functionalLocationId: null, locations }))).toBe(false);
    expect(targetMatches(target({ scopeInstrumentIds: ['INST-1'] }), ctx({ functionalLocationId: null }))).toBe(true);
  });

  it('respects isActive', () => {
    expect(targetMatches(target({ isActive: false, scopeInstrumentIds: ['INST-1'] }), ctx())).toBe(false);
  });

  it('respects the per-event fire flags', () => {
    const t = target({ scopeInstrumentIds: ['INST-1'], fireOnCleared: false });
    expect(targetMatches(t, ctx({ event: 'RAISED' }))).toBe(true);
    expect(targetMatches(t, ctx({ event: 'CLEARED' }))).toBe(false);
  });

  it('a TEST fire ignores the fire flags and the scope', () => {
    const t = target({ fireOnRaised: false, fireOnCleared: false, fireOnAcknowledged: false });
    expect(targetMatches(t, ctx({ event: 'TEST' }))).toBe(true);
  });

  // The two severity-narrowing cases that stood here were DELETED on 2026-09-01,
  // not rewritten: `targetMatches` no longer reads severity at all, so there is no
  // new behaviour for them to assert. The column survives (see target-scope.ts).
});
