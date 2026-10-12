import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Audit 2026-10-12, finding 1: `GET /api/notification-rules` answers
 * `{ data, total }` (apps/api/src/modules/notification-rules/routes.ts), but the
 * page read it as a bare array — so `rules.length` was undefined, the count read
 * "0 notification rules configured" and the empty state hid every saved rule.
 *
 * The SWR mock returns the REAL server shapes. Also pinned: the recipient role
 * list comes from `/api/roles/active` (no permission gate), not `/api/roles`,
 * which is ROLE_MANAGE-only and 403'd for a CONFIG_READ operator.
 */
const RULE = {
  id: 'r-1', name: 'Alarm raised to QA', eventType: 'ALARM_RAISED', eventTypes: ['ALARM_RAISED'],
  conditions: {}, emailEnabled: true, smsEnabled: false, inAppEnabled: true, cooldownMinutes: 0,
  isActive: true, priority: 0, createdAt: '2026-10-01T00:00:00.000Z',
  recipients: [{ id: 'rc-1', recipientType: 'ROLE', roleValue: 'QA', displayName: 'QA' }],
  eventTypeMeta: { value: 'ALARM_RAISED', label: 'Alarm raised', module: 'Alarms', variables: [] },
  eventTypesMeta: [{ value: 'ALARM_RAISED', label: 'Alarm raised', module: 'Alarms', variables: [] }],
};
const requested: string[] = [];
const mutate = vi.fn();
vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (key) requested.push(key);
    if (key === '/api/notification-rules') return { data: { data: [RULE], total: 1 }, mutate };
    if (key === '/api/roles/active') return { data: [{ name: 'QA', displayName: 'Quality' }], mutate };
    return { data: undefined, mutate };
  },
}));
vi.mock('@/lib/api-client', () => ({ apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }) }));

const consoleError = vi.spyOn(console, 'error');
afterEach(() => { requested.length = 0; });

describe('Notification Rules — the saved rules are listed', () => {
  it('reads the { data, total } envelope the server returns', async () => {
    const { NotificationRulesPage } = await import('../index');
    render(<MemoryRouter><NotificationRulesPage /></MemoryRouter>);
    expect(screen.getByText('Alarm raised to QA')).toBeInTheDocument();
    expect(screen.getByText('1 notification rules configured')).toBeInTheDocument();
    expect(screen.queryByText('No notification rules yet')).not.toBeInTheDocument();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('reads recipient roles from the ungated /api/roles/active', async () => {
    const { NotificationRulesPage } = await import('../index');
    render(<MemoryRouter><NotificationRulesPage /></MemoryRouter>);
    expect(requested).toContain('/api/roles/active');
    expect(requested).not.toContain('/api/roles');
  });
});
