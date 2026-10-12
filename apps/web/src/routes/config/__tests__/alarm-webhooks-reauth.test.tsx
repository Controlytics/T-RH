import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Audit 2026-10-12, finding 6. The page drew its OWN password box before every
 * write. The server checks the password only when MANAGE_ALARM_WEBHOOK
 * re-auth is configured for the caller's role (`enforceReauth`); with it off the
 * server skipped verification, so whatever was typed was "accepted" — a
 * signature prompt that verified nothing. The page now uses the shared
 * `useReauth` hook: the dialog appears when the SERVER's policy asks for one,
 * and a write with no policy goes straight through.
 */
const TARGET = {
  id: 't-1', name: 'Hooter A', description: null, url: 'http://10.0.0.5/fire', method: 'POST',
  headers: {}, contentType: 'application/json', bodyTemplate: '{}', successRegex: null, timeoutMs: 5000,
  fireOnRaised: true, fireOnCleared: false, fireOnAcknowledged: false, cooldownSeconds: 0, isActive: true,
  scopeLocationIds: [], scopeInstrumentIds: [], instrumentCount: 3, lastDeliveryStatus: null,
  lastDeliveryAt: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
};
const RESPONSE = { data: [TARGET] };
const mutate = vi.fn(async () => undefined);
vi.mock('swr', () => ({
  default: (key: string | null) => (key === '/api/alarm-webhooks' ? { data: RESPONSE, mutate } : { data: undefined, mutate }),
}));
const executed: string[] = [];
const withPassword = { current: false };
vi.mock('@/hooks/use-reauth', () => ({
  useReauth: () => ({
    execute: async (action: string, cb: (p?: string) => Promise<void>, opts?: { onSuccess?: () => void; onError?: (e: unknown) => void }) => {
      executed.push(action);
      try { await cb(withPassword.current ? 'pw' : undefined); await opts?.onSuccess?.(); } catch (e) { opts?.onError?.(e); }
    },
    isOpen: false, password: '', error: '', isVerifying: false,
    setPassword: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), needsReauth: () => false,
  }),
}));
const put = vi.fn(async () => ({}));
const putWithReauth = vi.fn(async () => ({}));
vi.mock('@/lib/api-client', () => ({
  apiClient: {
    put: (...a: unknown[]) => put(...(a as [])),
    putWithReauth: (...a: unknown[]) => putWithReauth(...(a as [])),
    post: vi.fn(async () => ({})), postWithReauth: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})), deleteWithReauth: vi.fn(async () => ({})),
  },
}));
vi.mock('@/hooks/use-can', () => ({ useCan: () => () => true }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }) }));

beforeEach(() => { put.mockClear(); putWithReauth.mockClear(); executed.length = 0; withPassword.current = false; });

describe('Alarm Webhooks — re-authentication is the server policy, not a hardcoded box', () => {
  it('with no policy, a write goes straight out and no password box is drawn', async () => {
    const { AlarmWebhooksConfigPage } = await import('../alarm-webhooks');
    render(<MemoryRouter><AlarmWebhooksConfigPage /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: /^deactivate$/i }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/api/alarm-webhooks/t-1', { isActive: false }));
    expect(executed).toEqual(['MANAGE_ALARM_WEBHOOK']);
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
  });

  it('with a policy, the password the hook collected is sent', async () => {
    withPassword.current = true;
    const { AlarmWebhooksConfigPage } = await import('../alarm-webhooks');
    render(<MemoryRouter><AlarmWebhooksConfigPage /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: /^deactivate$/i }));
    await waitFor(() => expect(putWithReauth).toHaveBeenCalledWith('/api/alarm-webhooks/t-1', { isActive: false }, 'pw'));
    expect(put).not.toHaveBeenCalled();
  });
});
