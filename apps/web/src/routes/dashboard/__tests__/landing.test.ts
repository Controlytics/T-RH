import { describe, it, expect } from 'vitest';
import { landingRoute } from '../landing';

/**
 * Audit 2026-10-03, WEB-4: `/` is where every login lands and it was
 * unguarded, so a role without DASHBOARD_VIEW saw an empty, erroring
 * dashboard. The landing rule: the dashboard when the role may see it, else
 * the first sidebar page the role can see, else the profile page.
 */
describe('landingRoute', () => {
  it('is the dashboard for SUPER_ADMIN whatever the permission list says', () => {
    expect(landingRoute([], 'SUPER_ADMIN')).toBe('/');
  });

  it('is the dashboard for a role holding DASHBOARD_VIEW', () => {
    expect(landingRoute(['DASHBOARD_VIEW'], 'VIEWER')).toBe('/');
  });

  it('is the first visible sidebar page for a role without it', () => {
    // A user-admin role: Users is the first item it can see.
    expect(landingRoute(['USER_READ', 'USER_CREATE'], 'ADMIN')).toBe('/users');
  });

  it('is the profile page when the role can see no sidebar item at all', () => {
    expect(landingRoute([], 'VIEWER')).toBe('/profile');
  });
});
