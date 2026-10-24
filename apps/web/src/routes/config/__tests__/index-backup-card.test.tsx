import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * 2026-10-24 (operator chose: "Backup toggles suffice"): Export / Restore
 * Backup alone opens Configuration → Backup. Until then the role also needed
 * CONFIG_READ (the page guard) AND a Configuration Access entry (the card).
 * A role holding only a Backup toggle has no CONFIG_READ, so the page must not
 * ask for the access matrix — that 403 would read as "could not load".
 */
const requested: string[] = [];
const MANIFEST: unknown[] = [];
const MATRIX: Record<string, string[]> = {};
vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (key) requested.push(key);
    if (key === '/api/config/registry/manifest') return { data: MANIFEST };
    if (key === '/api/config/access-matrix') return { data: MATRIX };
    return { data: undefined };
  },
}));
const user = { current: { id: 'u', username: 'u', fullName: 'U Ser', role: 'OPS', permissions: [] as string[] } };
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: user.current }) }));

const { ConfigIndexPage } = await import('../index');

const renderPage = () => render(<MemoryRouter><ConfigIndexPage /></MemoryRouter>);

beforeEach(() => { requested.length = 0; });

describe('Configuration → Backup by its own toggles', () => {
  it('a role holding only Export Backup sees the Backup card alone, and never asks for the access matrix', () => {
    user.current = { ...user.current, permissions: ['BACKUP_EXPORT'] };
    renderPage();
    expect(screen.getByText('Backup & Restore')).toBeInTheDocument();
    expect(screen.queryByText('General & Password Settings')).not.toBeInTheDocument();
    expect(requested).not.toContain('/api/config/access-matrix');
  });

  it('Restore Backup alone does the same', () => {
    user.current = { ...user.current, permissions: ['BACKUP_RESTORE'] };
    renderPage();
    expect(screen.getByText('Backup & Restore')).toBeInTheDocument();
  });

  it('a CONFIG_READ role without a Backup toggle still needs Configuration Access for the card', () => {
    user.current = { ...user.current, permissions: ['CONFIG_READ'] };
    renderPage();
    expect(requested).toContain('/api/config/access-matrix');
    expect(screen.queryByText('Backup & Restore')).not.toBeInTheDocument();
  });
});
