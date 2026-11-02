import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * 2026-11-02: Configuration → Report Templates is a SUPER_ADMIN card (spec §9) —
 * template writes are SUPER_ADMIN by role on the server, so no other role is
 * offered the door. It has no config def and no `system_config` row.
 */
vi.mock('swr', () => ({ default: () => ({ data: undefined }) }));
const user = { current: { id: 'u', username: 'u', fullName: 'U Ser', role: 'SUPER_ADMIN', permissions: [] as string[] } };
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: user.current }) }));
vi.mock('@/components/super-admin-api-access', () => ({ SuperAdminApiAccessCard: () => null }));

const { ConfigIndexPage } = await import('../index');
const renderPage = () => render(<MemoryRouter><ConfigIndexPage /></MemoryRouter>);

describe('Configuration → Report Templates card', () => {
  it('a super admin sees ONE Report Templates card in the Super Admin section, opening /config/report-templates', () => {
    user.current = { ...user.current, role: 'SUPER_ADMIN', permissions: [] };
    renderPage();
    const titles = screen.getAllByText('Report Templates');
    expect(titles).toHaveLength(1);
    expect(titles[0]!.closest('a')).toHaveAttribute('href', '/config/report-templates');
    expect(titles[0]!.closest('section')?.querySelector('h2')?.textContent).toContain('Super Admin Settings');
  });

  it('another role never sees it', () => {
    user.current = { ...user.current, role: 'OPS', permissions: ['CONFIG_READ'] };
    renderPage();
    expect(screen.queryByText('Report Templates')).not.toBeInTheDocument();
  });
});
