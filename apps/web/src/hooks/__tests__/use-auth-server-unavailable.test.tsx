import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

/**
 * Performance audit 2026-11-17: a database outage sent every signed-in user to
 * /login — `/api/auth/me` failed with a 500 (now a 503 DATABASE_UNAVAILABLE, or
 * a read TIMEOUT), and `isAuthenticated` was false for any error that was not a
 * network failure, while the token stayed in storage and the login could not
 * succeed either. "The server cannot answer" says nothing about the session; a
 * 401 still does.
 */
const sessionError: { current: unknown } = { current: undefined };
const swrState: { isLoading: boolean; user: unknown } = { isLoading: false, user: undefined };
const CACHED_USER = { id: 'u1', username: 'op', fullName: 'Op', role: 'OPERATOR', permissions: [] };
vi.mock('swr', () => ({
  default: () => ({ data: swrState.user, error: sessionError.current, isLoading: swrState.isLoading, mutate: vi.fn() }),
}));
vi.mock('@/lib/api-client', () => ({ apiClient: { post: vi.fn(), refreshToken: vi.fn(async () => true) } }));

const { useAuth, isServerUnavailable } = await import('../use-auth');
const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter>{children}</MemoryRouter>;

beforeEach(() => {
  sessionStorage.setItem('access_token', 'tok');
  swrState.isLoading = false;
  swrState.user = CACHED_USER;
  sessionError.current = undefined;
});

describe('a session the server cannot CHECK is not a session that ended', () => {
  it.each([
    ['a read timeout', Object.assign(new Error('The server did not answer within 30 seconds.'), { code: 'TIMEOUT' })],
    ['a 503 DATABASE_UNAVAILABLE', Object.assign(new Error('The database is not answering right now.'), { status: 503, code: 'DATABASE_UNAVAILABLE' })],
  ])('%s keeps the signed-in user', (_label, err) => {
    sessionError.current = err;
    expect(isServerUnavailable(err)).toBe(true);
    const { result } = renderHook(() => useAuth(), { wrapper });
    expect(result.current.isAuthenticated).toBe(true);
  });

  it.each([
    ['a 401', Object.assign(new Error('Session expired'), { status: 401 })],
    ['a 403', Object.assign(new Error('Forbidden'), { status: 403 })],
    ['a 500', Object.assign(new Error('Internal server error'), { status: 500 })],
  ])('%s still does not', (_label, err) => {
    sessionError.current = err;
    expect(isServerUnavailable(err)).toBe(false);
    const { result } = renderHook(() => useAuth(), { wrapper });
    expect(result.current.isAuthenticated).toBe(false);
  });
});

/**
 * SWR sets `isLoading` at the start of EVERY revalidation while its cache holds no
 * data (the cached user is fallbackData, which it ignores for this). After a
 * TIMEOUT, each retry put the whole app back behind the shell's spinner for up to
 * another 30 s. SWR keeps the last error during the retry.
 */
describe('a retry after "the server could not answer" does not blank the app', () => {
  const TIMEOUT = Object.assign(new Error('The server did not answer within 30 seconds.'), { code: 'TIMEOUT' });

  it('a retry in flight after a TIMEOUT, with a cached user, is not "loading"', () => {
    sessionError.current = TIMEOUT;
    swrState.isLoading = true;
    const { result } = renderHook(() => useAuth(), { wrapper });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isAuthenticated).toBe(true);
  });

  it('the FIRST load (no error yet) is still "loading"', () => {
    swrState.isLoading = true;
    const { result } = renderHook(() => useAuth(), { wrapper });
    expect(result.current.isLoading).toBe(true);
  });

  it('with NO cached user it is still "loading" — nothing to show', () => {
    sessionError.current = TIMEOUT;
    swrState.isLoading = true;
    swrState.user = undefined;
    localStorage.removeItem('digilog_cached_user');
    const { result } = renderHook(() => useAuth(), { wrapper });
    expect(result.current.isLoading).toBe(true);
  });

  it('a retry after a 401 is still "loading" (the session may really have ended)', () => {
    sessionError.current = Object.assign(new Error('Session expired'), { status: 401 });
    swrState.isLoading = true;
    const { result } = renderHook(() => useAuth(), { wrapper });
    expect(result.current.isLoading).toBe(true);
  });
});
