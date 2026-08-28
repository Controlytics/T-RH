import { describe, it, expect } from 'vitest';
import { pickPanels } from '../panel-access.js';

/**
 * `pickPanels` is the pure half of the resolver — the database read lives in
 * `resolvePanelsFor`. Split so the rule is testable without a database, exactly as
 * `visibility.ts` splits `effectiveScope` from `resolveVisibility`.
 */
describe('pickPanels', () => {
  it('reads a stored user list, overriding the role', () => {
    expect(pickPanels('OPERATOR', ['trend_charts'], ['trend_alarms'])).toEqual(['trend_alarms']);
  });

  it('treats a stored EMPTY user list as NO panels, not as inherit', () => {
    expect(pickPanels('OPERATOR', ['trend_charts'], [])).toEqual([]);
  });

  it('treats a malformed stored value as inherit rather than as deny', () => {
    expect(pickPanels('OPERATOR', 'nonsense', null)).toBeNull();
  });

  it('drops keys that are no longer in the catalogue', () => {
    expect(pickPanels('OPERATOR', ['trend_charts', 'total_users'], null)).toEqual(['trend_charts']);
  });

  it('gives SUPER_ADMIN every panel whatever is stored', () => {
    expect(pickPanels('SUPER_ADMIN', [], [])).toBeNull();
  });
});
