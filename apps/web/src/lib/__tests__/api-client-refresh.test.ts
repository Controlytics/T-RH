import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Audit 2026-11-07, S2-H7: `refreshToken()` shares one in-flight promise between
 * concurrent callers and clears it in a `finally`. The no-token early return sat
 * OUTSIDE that `try`, so the guard was never cleared: one call made before a token
 * existed (the interval firing on the login page) left a resolved `false` behind,
 * and every refresh after login returned that `false` without trying — the
 * session then expired mid-shift with no silent renewal.
 */

const mockFetch = vi.fn();
const originalFetch = globalThis.fetch;

vi.mock('../themes', () => ({}));

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.fetch = mockFetch as never;
  if (typeof globalThis.sessionStorage === 'undefined') {
    const storage = new Map<string, string>();
    globalThis.sessionStorage = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => { storage.set(k, v); },
      removeItem: (k: string) => { storage.delete(k); },
      clear: () => storage.clear(),
      key: () => null,
      length: 0,
    } as never;
  }
  if (typeof globalThis.window === 'undefined') {
    (globalThis as { window?: unknown }).window = { location: { pathname: '/', search: '', href: '/' } };
  }
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('apiClient.refreshToken', () => {
  it('a call made with NO token does not poison the next one', async () => {
    const { apiClient } = await import('../api-client');
    const { safeStorage } = await import('../safe-storage');
    safeStorage.session.remove('access_token');

    expect(await apiClient.refreshToken()).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
    // The guard is cleared on a microtask.
    await Promise.resolve();

    safeStorage.session.set('access_token', 'old-token');
    const body = JSON.stringify({ token: 'new-token' });
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200, headers: { get: () => 'application/json' },
      text: async () => body,
      json: async () => JSON.parse(body),
    });
    expect(await apiClient.refreshToken()).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(safeStorage.session.get('access_token')).toBe('new-token');
  });
});
