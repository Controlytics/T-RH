import { describe, it, expect } from 'vitest';
import { REAUTH_ACTIONS, REAUTH_ACTION_CATEGORIES } from './reauth-actions.js';

describe('REAUTH_ACTION_CATEGORIES', () => {
  it('contains every category referenced by an action', () => {
    const declared = new Set<string>(REAUTH_ACTION_CATEGORIES);
    const orphans = Object.entries(REAUTH_ACTIONS)
      .filter(([, def]) => !declared.has(def.category))
      .map(([key, def]) => `${key} (category='${def.category}')`);

    // An action whose category is absent renders in NEITHER reauth editor —
    // action-reauth.tsx:67 and roles-components/reauth-tab.tsx:58 both build
    // their lists by mapping REAUTH_ACTION_CATEGORIES. Its policy can never
    // be set, so the reauth gate silently never applies.
    expect(orphans).toEqual([]);
  });
});
