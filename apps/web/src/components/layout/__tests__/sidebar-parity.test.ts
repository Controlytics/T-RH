import { describe, it, expect } from 'vitest';
import { SIDEBAR_ITEMS } from '@digilog/shared';
import { allNavItems } from '../sidebar';

describe('sidebar list parity', () => {
  it('SIDEBAR_ITEMS and allNavItems hold the same ids', () => {
    const configured = SIDEBAR_ITEMS.map(i => i.id).sort();
    const rendered = allNavItems.map(i => i.id).sort();

    // These two lists are independent. SIDEBAR_ITEMS drives the Roles & Access
    // toggles; allNavItems renders the nav. Updating only the first ships a
    // feature that is grantable but has no link; updating only the second
    // ships a link that no role can be granted.
    expect(rendered).toEqual(configured);
  });
});
