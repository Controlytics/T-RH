import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('swr', () => ({ default: () => ({ data: undefined }) }));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ user: { id: 'u1', username: 'superadmin', fullName: 'Super Admin', role: 'SUPER_ADMIN', permissions: [] } }),
}));
vi.mock('@/hooks/use-branding', () => ({
  useBranding: () => ({ branding: {
    appName: 'T&RH-Monitoring', logoUrl: '', logoText: 'CC', companyName: 'Controlytics', primaryColor: '#0891b2',
    secondaryColor: '#0d9488', accentColor: '#14b8a6', loginBgStart: '#164e63',
  } }),
}));

// jsdom has no matchMedia; the sidebar's viewport hook calls it. Wide viewport.
window.matchMedia = window.matchMedia ?? ((query: string) => ({
  matches: true, media: query, onchange: null,
  addEventListener: () => {}, removeEventListener: () => {},
  addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
}) as MediaQueryList);

const { Sidebar } = await import('../sidebar');

/**
 * UI v3: the active item is a white pill with theme ink and a right-hand
 * dot (cc-dashboard.png). Asserted by data attribute and the class the pill
 * is built from, because a colour alone is invisible to a test.
 */
describe('Sidebar active item', () => {
  it('marks the current route as a white pill and leaves the others translucent', () => {
    render(<MemoryRouter initialEntries={['/alarms']}><Sidebar userRole="SUPER_ADMIN" open onClose={() => {}} /></MemoryRouter>);
    const active = screen.getByRole('link', { current: 'page' });
    // The exact class token, not `\bbg-white\b`: `/` is a word boundary, so
    // that regex also matches the inactive item's `hover:bg-white/10`.
    const pill = /(^|\s)bg-white(\s|$)/;
    expect(active).toHaveAttribute('data-active', 'true');
    expect(active.className).toMatch(pill);
    const other = screen.getByRole('link', { name: /users/i });
    expect(other).toHaveAttribute('data-active', 'false');
    expect(other.className).not.toMatch(pill);
  });
});
