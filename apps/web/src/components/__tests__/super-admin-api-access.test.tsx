import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

/**
 * Audit 2026-10-03, WEB-1: the two password boxes on the Super Admin API
 * access card were bare `<input type="password" autoComplete="current-password">`
 * in no form — the one combination that makes Chrome fill the saved login
 * password, so whoever sat at an unlocked super-admin workstation could press
 * Enter and flip privileged APIs under the super admin's name. Every §11
 * password box is `SignaturePasswordInput`; these are now too. Read out of the
 * DOM: no `current-password`, the signature input's `one-time-code`.
 */
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { id: 'u1', username: 'superadmin', role: 'SUPER_ADMIN' }, logout: vi.fn() }) }));
const lock = { current: { isSuperAdmin: true, enabled: true, isLoading: false, mutate: vi.fn(), setEnabled: vi.fn(async () => undefined) } };
vi.mock('@/hooks/use-super-admin-lock', () => ({ useSuperAdminLock: () => lock.current }));

const { SuperAdminApiAccessCard, SuperAdminLockdownScreen } = await import('../super-admin-api-access');

const passwordBoxes = () => Array.from(document.querySelectorAll('input')).filter((i) => i.placeholder === 'Enter your password');

describe('Super Admin API access password boxes are signature inputs', () => {
  it('the card (enabled → disabling) carries no current-password box', async () => {
    render(<SuperAdminApiAccessCard />);
    // The box appears once the operator starts the disable flow.
    const trigger = Array.from(document.querySelectorAll('button')).find((b) => /disable|turn off|switch/i.test(b.textContent ?? ''));
    expect(trigger).toBeDefined();
    fireEvent.click(trigger!);
    const boxes = passwordBoxes();
    expect(boxes.length).toBeGreaterThan(0);
    for (const b of boxes) {
      expect(b.getAttribute('autocomplete')).toBe('one-time-code');
      expect(b.getAttribute('autocomplete')).not.toBe('current-password');
    }
  });

  it('the lockdown screen (disabled → re-enable) carries no current-password box', async () => {
    lock.current = { ...lock.current, enabled: false };
    render(<SuperAdminLockdownScreen />);
    const boxes = passwordBoxes();
    expect(boxes.length).toBeGreaterThan(0);
    for (const b of boxes) expect(b.getAttribute('autocomplete')).toBe('one-time-code');
  });
});
