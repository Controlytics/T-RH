import { describe, it, expect } from 'vitest';
import { scopeIdFor, areasOf, effectiveSelection, toggleSelection } from '../history-selection';

const tree = [
  { id: 'b1', name: 'CWH Block', children: [{ id: 'a1', name: 'QC 3' }, { id: 'a2', name: 'Stability' }] },
  { id: 'b2', name: 'Other Block', children: [{ id: 'a3', name: 'QC 3' }] },
];
const inScope = [
  { id: 'i1', code: 'CWH/RDU/001-00', name: 'CWH/RDU/001-00', functionalLocationId: 'a1' },
  { id: 'i2', code: 'CWH/RDU/002-00', name: 'CWH/RDU/002-00', functionalLocationId: 'a1' },
  { id: 'i3', code: 'CWH/RDU/003-00', name: 'CWH/RDU/003-00', functionalLocationId: 'a1' },
];

describe('the history widget selection', () => {
  it('asks the list route for the Area, else the Block, else everything', () => {
    expect(scopeIdFor('b1', 'a1')).toBe('a1');
    expect(scopeIdFor('b1', '')).toBe('b1');
    expect(scopeIdFor('', '')).toBeNull();
  });

  it('lists the Areas of the chosen Block only', () => {
    expect(areasOf(tree, 'b1').map((a) => a.id)).toEqual(['a1', 'a2']);
    expect(areasOf(tree, '')).toEqual([]);
    expect(areasOf(tree, 'nope')).toEqual([]);
  });

  it('selects everything in scope until something is unticked', () => {
    expect(effectiveSelection(inScope, null).map((i) => i.id)).toEqual(['i1', 'i2', 'i3']);
    const one = toggleSelection(inScope, null, 'i2');
    expect(one).not.toBeNull();
    expect(effectiveSelection(inScope, one).map((i) => i.id)).toEqual(['i1', 'i3']);
  });

  it('collapses back to "all" when every instrument in scope is ticked again', () => {
    const minusOne = toggleSelection(inScope, null, 'i2')!;
    expect(toggleSelection(inScope, minusOne, 'i2')).toBeNull();
  });

  it('drops a tick for an instrument that has left the scope', () => {
    // Ticks from a previous Area must not drive a download from this one.
    const stale = new Set(['i1', 'gone']);
    const next = toggleSelection(inScope, stale, 'i3')!;
    expect([...next].sort()).toEqual(['i1', 'i3']);
    expect(effectiveSelection(inScope, stale).map((i) => i.id)).toEqual(['i1']);
  });

  it('an empty scope never collapses to "all"', () => {
    expect(toggleSelection([], new Set(), 'x')).toEqual(new Set());
  });
});
