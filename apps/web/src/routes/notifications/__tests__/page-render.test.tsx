import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The Notifications page had no render test before UI v3 (2026-09-21). This
 * pins its shape on the shared band: the title inside it, and Mark All as
 * Read as the band's action when there is something unread.
 */
const mutate = vi.fn();
const RESPONSE = {
  data: [{ id: 'n-1', title: 'Alarm raised', message: 'CWH/RDU/001-00 high temperature', type: 'ALARM', isRead: false, createdAt: '2026-09-21T10:00:00.000Z' }],
  total: 1, page: 1, totalPages: 1, unreadCount: 1,
};
vi.mock('swr', () => ({
  default: () => ({ data: RESPONSE, mutate }),
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));
vi.mock('@/hooks/use-can', () => ({ useCan: () => () => true }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }) }));
vi.mock('@/hooks/use-datetime-format', () => ({
  useDatetimeFormat: () => ({ formatDateTime: (d: string) => d, formatDate: (d: string) => d, formatTime: (d: string) => d }),
}));
vi.mock('@/hooks/use-pagination-config', () => ({
  usePaginationConfig: () => [25, 50, 100],
  usePaginationDefaults: () => ({ defaultLimit: 25, pageSizeOptions: [25, 50, 100] }),
}));
vi.mock('@/hooks/use-reauth', () => ({
  useReauth: () => ({
    execute: async (_a: string, cb: (p?: string) => Promise<void>) => { await cb(); },
    isOpen: false, password: '', error: '', isVerifying: false,
    setPassword: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), needsReauth: () => false,
  }),
}));
vi.mock('@/lib/api-client', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), postWithReauth: vi.fn(), putWithReauth: vi.fn(), deleteWithReauth: vi.fn() },
}));

const { NotificationsPage } = await import('../index');

describe('NotificationsPage — UI v3 shape', () => {
  it('opens with the hero band carrying the title and Mark All as Read', () => {
    render(<MemoryRouter><NotificationsPage /></MemoryRouter>);
    const hero = screen.getByTestId('page-hero');
    expect(hero.contains(screen.getByRole('heading', { level: 1, name: 'Notifications' }))).toBe(true);
    expect(hero.contains(screen.getByRole('button', { name: /mark all as read/i }))).toBe(true);
  });
});
