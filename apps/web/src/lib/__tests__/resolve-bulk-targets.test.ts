import { describe, expect, it } from 'vitest';
import { resolveBulkTargets } from '../resolve-bulk-targets';

// Regression guard for M86: bulk retire/replace/status acted on the RAW selection
// Set while the confirm dialog only listed the search-narrowed filters, so a
// destructive action could hit filters the operator could not see.
describe('resolveBulkTargets', () => {
  const row1 = { id: 'f1', name: 'PROBE-1' };
  const row2 = { id: 'f2', name: 'PROBE-2' };

  it('returns only the selected filters that are currently visible', () => {
    const selected = new Set(['f1', 'f2']);
    expect(resolveBulkTargets(selected, [row1, row2])).toEqual([row1, row2]);
  });

  // The core of the bug: select under one search term, then retype another.
  it('EXCLUDES a selected filter that the search box has hidden', () => {
    // Operator searched "PROBE-1", selected it, then retyped "PROBE-2".
    const selected = new Set(['f1', 'f2']);
    const visibleAfterRetypingSearch = [row2];

    const targets = resolveBulkTargets(selected, visibleAfterRetypingSearch);

    expect(targets).toEqual([row2]);
    expect(targets.map(f => f.id)).not.toContain('f1');
  });

  it('returns nothing when every selected filter is hidden', () => {
    expect(resolveBulkTargets(new Set(['f1']), [row2])).toEqual([]);
  });

  it('ignores visible filters that were never selected', () => {
    expect(resolveBulkTargets(new Set(['f1']), [row1, row2])).toEqual([row1]);
  });

  it('returns nothing for an empty selection', () => {
    expect(resolveBulkTargets(new Set<string>(), [row1, row2])).toEqual([]);
  });

  // The dialog list, the dialog count and the action all read this one value,
  // so what the operator is told is exactly what gets acted on.
  it('yields a count that matches the acted-on list', () => {
    const targets = resolveBulkTargets(new Set(['f1', 'f2']), [row1]);
    expect(targets.length).toBe(1);
    expect(targets).toEqual([row1]);
  });
});

// Regression guard for M69: the same bug class on the Audit Trail page, where the
// blast radius is an irreversible, hash-chain-breaking delete on a 21 CFR Part 11
// log. There the rendered rows are one server-paginated page, and the selection
// Set outlives a re-sort or a page-size change — `toggleSort` only called
// setPage(1), a no-op on page 1, so nothing cleared the Set while the rows
// underneath it were swapped.
describe('resolveBulkTargets — audit trail selection', () => {
  const oldest = { id: 'r1', action: 'LOGIN_SUCCESS' };
  const newest = { id: 'r2', action: 'USER_DELETED' };

  it('EXCLUDES a selected record that a re-sort pushed off the page', () => {
    // Sorted desc, page 1 shows r2 + r1; operator selects both, then flips to asc
    // and page 1 now shows an entirely different slice.
    const selected = new Set(['r1', 'r2']);
    const pageAfterResort = [{ id: 'r9', action: 'CONFIG_CHANGED' }];

    expect(resolveBulkTargets(selected, pageAfterResort)).toEqual([]);
  });

  it('EXCLUDES records dropped by a smaller page size', () => {
    // Select 2 rows at 20/page, then switch to 1/page.
    const targets = resolveBulkTargets(new Set(['r1', 'r2']), [newest]);

    expect(targets).toEqual([newest]);
    expect(targets.map(r => r.id)).not.toContain('r1');
  });

  it('keeps records that survive the re-sort', () => {
    // Same rows, reversed order: both are still on screen, so both stay targets.
    const targets = resolveBulkTargets(new Set(['r1', 'r2']), [oldest, newest]);
    expect(targets.map(r => r.id).sort()).toEqual(['r1', 'r2']);
  });
});
