import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

/**
 * audit 2026-10-03, WEB-3 — the MUTATION CHECK for `safeStorage`.
 *
 * A browser set to block site data throws a SecurityError on ACCESS to
 * `window.sessionStorage`. `useAuth` reads the token DURING RENDER and
 * `useSingleTab` mints its tab id from `useRef(getTabId())` during render, so a
 * bare `sessionStorage.getItem` in either took the whole application shell
 * down to the root error boundary — while `AppLayout` carefully wrapped its own
 * one read a few lines later. Revert either hook's read to the bare accessor
 * and this file fails.
 */

vi.mock('swr', () => ({
  default: () => ({ data: undefined, error: undefined, isLoading: false, mutate: vi.fn() }),
}));
vi.mock('../../lib/api-client', () => ({
  apiClient: { post: vi.fn(), refreshToken: vi.fn().mockResolvedValue(false) },
}));

const { useAuth } = await import('../use-auth');
const { useSingleTab, checkExistingUserSession } = await import('../use-single-tab');

const realLocal = Object.getOwnPropertyDescriptor(window, 'localStorage');
const realSession = Object.getOwnPropertyDescriptor(window, 'sessionStorage');

function blockStorage() {
  const throwing = {
    configurable: true,
    get() { throw new DOMException('Access is denied for this document.', 'SecurityError'); },
  };
  Object.defineProperty(window, 'localStorage', throwing);
  Object.defineProperty(window, 'sessionStorage', throwing);
}

const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter>{children}</MemoryRouter>;

beforeEach(blockStorage);
afterEach(() => {
  if (realLocal) Object.defineProperty(window, 'localStorage', realLocal);
  if (realSession) Object.defineProperty(window, 'sessionStorage', realSession);
});

describe('the shell survives a browser that blocks web storage', () => {
  it('useAuth renders signed-out instead of throwing', () => {
    expect(() => window.sessionStorage).toThrow();
    const { result } = renderHook(() => useAuth(), { wrapper });
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.user).toBeUndefined();
  });

  it('useSingleTab renders (and mints a tab id) instead of throwing', () => {
    const { result } = renderHook(() => useSingleTab(false));
    expect(result.current.isDuplicateTab).toBe(false);
  });

  it('the login page\'s existing-session probe answers "none" instead of throwing', () => {
    expect(checkExistingUserSession()).toBeNull();
  });
});
