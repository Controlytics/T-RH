import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * 2026-10-31, TCP/IP (Modbus) instruments: Configuration → TCP/IP Reading is a
 * SUPER_ADMIN card — whether this server reads devices at all, and the
 * networks their addresses must be in. One door to the setting: the
 * auto-discovered section must not offer the same module a second time, and no
 * Configuration Access grant may show it to another role.
 */
const MANIFEST = [
  { moduleKey: 'modbus-reader', moduleName: 'TCP/IP Reading', description: 'd', icon: 'network', category: 'system', sortOrder: 16, requiredRole: 'SUPER_ADMIN', requiresReauth: false, hasCustomPage: false, customPagePath: null, reauthAction: null, settings: [] },
];
const MATRIX: Record<string, string[]> = { 'modbus-reader': ['OPS'] };
vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (key === '/api/config/registry/manifest') return { data: MANIFEST };
    if (key === '/api/config/access-matrix') return { data: MATRIX };
    return { data: undefined };
  },
}));
const user = { current: { id: 'u', username: 'u', fullName: 'U Ser', role: 'SUPER_ADMIN', permissions: [] as string[] } };
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: user.current }) }));
vi.mock('@/components/super-admin-api-access', () => ({ SuperAdminApiAccessCard: () => null }));

const { ConfigIndexPage } = await import('../index');
const renderPage = () => render(<MemoryRouter><ConfigIndexPage /></MemoryRouter>);

describe('Configuration → TCP/IP Reading', () => {
  it('a super admin sees ONE TCP/IP Reading card, opening the modbus-reader settings', () => {
    user.current = { ...user.current, role: 'SUPER_ADMIN', permissions: [] };
    renderPage();
    const titles = screen.getAllByText('TCP/IP Reading');
    expect(titles).toHaveLength(1);
    expect(titles[0]!.closest('a')).toHaveAttribute('href', '/config/dynamic/modbus-reader');
    // In the Super Admin section, not the auto-discovered "Additional Modules".
    const section = titles[0]!.closest('section');
    expect(section?.querySelector('h2')?.textContent).toContain('Super Admin Settings');
  });

  it('another role never sees it, even granted the module under Configuration Access', () => {
    user.current = { ...user.current, role: 'OPS', permissions: ['CONFIG_READ'] };
    renderPage();
    expect(screen.queryByText('TCP/IP Reading')).not.toBeInTheDocument();
  });
});
