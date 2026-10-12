import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Rule-driven in-app ALARM notifications (stored since migration
 * 20261012140000_notification_type_alarm_events) render with their own colour
 * and icon, not the grey fallback for an unknown type.
 */
const mutate = vi.fn();
const RESPONSE = {
  data: [
    { id: 'n-1', title: 'Alarms to QA', message: 'Alarm on X: above 25 (read 30)', type: 'ALARM_RAISED', isRead: false, createdAt: '2026-10-12T10:00:00.000Z' },
    { id: 'n-2', title: 'Alarms to QA', message: 'Alarm on X cleared after 5 min', type: 'ALARM_CLEARED', isRead: false, createdAt: '2026-10-12T10:05:00.000Z' },
  ],
  total: 2, page: 1, totalPages: 1, unreadCount: 2,
};
vi.mock('swr', () => ({
  default: () => ({ data: RESPONSE, mutate }),
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));
vi.mock('@/hooks/use-can', () => ({ useCan: () => () => true }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }) }));
vi.mock('@/hooks/use-datetime-format', () => ({
  // The page hands `formatDate` a DATE for anything older than a week (the
  // fixture's createdAt ages past that), so the mock must return a string for
  // either input — a Date returned as-is is not a valid React child.
  useDatetimeFormat: () => ({
    formatDateTime: (d: string | Date) => String(d),
    formatDate: (d: string | Date) => (d instanceof Date ? d.toISOString() : d),
    formatTime: (d: string | Date) => String(d),
  }),
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

describe('NotificationsPage — alarm notification types', () => {
  it('renders ALARM_RAISED and ALARM_CLEARED with their own badge, not the grey fallback', () => {
    render(<MemoryRouter><NotificationsPage /></MemoryRouter>);
    for (const type of ['ALARM_RAISED', 'ALARM_CLEARED']) {
      const icon = screen.getByTestId(`notification-icon-${type}`);
      expect(icon.className).not.toMatch(/bg-slate-500/);
      expect(icon.querySelector('svg')).not.toBeNull();
      expect(screen.getByText(type.replace(/_/g, ' '))).toBeInTheDocument();
    }
    expect(screen.getByTestId('notification-icon-ALARM_RAISED').className).toMatch(/from-red-/);
    expect(screen.getByTestId('notification-icon-ALARM_CLEARED').className).toMatch(/from-emerald-/);
  });
});
