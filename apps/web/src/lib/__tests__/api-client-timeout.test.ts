import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Performance audit 2026-11-17, P-03: no request had a time limit. With the
 * database hung, every page sat on "Loading…" for as long as the connection
 * lived (76.5 s measured, and counting).
 *
 * A READ is now abandoned after its bound — headers AND body — and fails with
 * `code: 'TIMEOUT'`. A WRITE is not bounded in the browser on purpose (an
 * aborted POST may still commit; the server must bound it). A timeout never
 * ends the session.
 *
 * `fetch` here honours the abort signal exactly as the browser's does.
 */

const originalFetch = globalThis.fetch;
const calls: Array<{ url: string; init: RequestInit }> = [];

function abortable<T>(signal: AbortSignal | null | undefined, never = new Promise<T>(() => undefined)): Promise<T> {
  if (!signal) return never;
  return new Promise<T>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
  });
}

/** A server that accepts the request and never sends the headers. */
const silentServer = vi.fn((url: string, init: RequestInit = {}) => {
  calls.push({ url, init });
  return abortable<Response>(init.signal);
});

/** A server that sends the headers, then never finishes the body. */
const stalledBody = vi.fn((url: string, init: RequestInit = {}) => {
  calls.push({ url, init });
  return Promise.resolve({
    ok: true, status: 200,
    text: () => abortable<string>(init.signal),
    json: () => abortable<unknown>(init.signal),
  } as unknown as Response);
});

beforeEach(() => {
  calls.length = 0;
  vi.clearAllMocks();
  sessionStorage.setItem('access_token', 'tok');
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  // A spy left behind by a FAILING assertion must not leak into the next test.
  vi.restoreAllMocks();
});

describe('P-03: a read that does not finish in time is abandoned', () => {
  it('no headers within the bound → TIMEOUT', async () => {
    globalThis.fetch = silentServer as never;
    const { apiClient } = await import('../api-client');
    const err = await apiClient.get('/api/config/pagination', { timeoutMs: 40 }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).toBe('TIMEOUT');
    expect((err as Error).message).toMatch(/did not answer within/);
  });

  it('headers in time but a body that never ends → TIMEOUT (the bound covers the body)', async () => {
    globalThis.fetch = stalledBody as never;
    const { apiClient } = await import('../api-client');
    const err = await apiClient.get('/api/config/pagination', { timeoutMs: 40 }).catch((e) => e);
    expect((err as { code?: string }).code).toBe('TIMEOUT');
  });

  it('getBlob bounds the body too', async () => {
    globalThis.fetch = vi.fn((url: string, init: RequestInit = {}) => Promise.resolve({
      ok: true, status: 200, blob: () => abortable<Blob>(init.signal),
    } as unknown as Response)) as never;
    const { apiClient } = await import('../api-client');
    const err = await apiClient.getBlob('/api/x', {}, { timeoutMs: 40 }).catch((e) => e);
    expect((err as { code?: string }).code).toBe('TIMEOUT');
  });

  it('a timeout does NOT end the session (the token stays, no redirect)', async () => {
    globalThis.fetch = silentServer as never;
    const { apiClient } = await import('../api-client');
    const before = window.location.href;
    await apiClient.get('/api/auth/me', { timeoutMs: 40 }).catch(() => undefined);
    expect(sessionStorage.getItem('access_token')).toBe('tok');
    expect(window.location.href).toBe(before);
  });

  it('a read that answers in time is untouched', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{"limit":100}' })) as never;
    const { apiClient } = await import('../api-client');
    await expect(apiClient.get('/api/config/pagination', { timeoutMs: 40 })).resolves.toEqual({ limit: 100 });
  });
});

describe('P-03: which calls carry which bound', () => {
  it('every SWR read (a page load) is bounded at READ_TIMEOUT_MS', async () => {
    const { apiClient, READ_TIMEOUT_MS } = await import('../api-client');
    const { swrConfig } = await import('../swr-config');
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue({} as never);
    await (swrConfig.fetcher as (u: string) => Promise<unknown>)('/api/config/pagination');
    expect(get).toHaveBeenCalledWith('/api/config/pagination', { timeoutMs: READ_TIMEOUT_MS });
  });

  it('an explicit read with no option carries a signal (the long bound)', async () => {
    globalThis.fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => '{}' } as unknown as Response;
    }) as never;
    const { apiClient } = await import('../api-client');
    await apiClient.get('/api/report-reviews/1');
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('a WRITE is not bounded in the browser: no signal, and it is still waiting after the read bound', async () => {
    globalThis.fetch = silentServer as never;
    const { apiClient } = await import('../api-client');
    let settled = false;
    void apiClient.put('/api/config/pagination', { limit: 50 }).finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 120));
    expect(settled).toBe(false);
    expect(calls[0]!.init.signal).toBeUndefined();
  });

  it('`timeoutMs: 0` means no limit (the backup download)', async () => {
    globalThis.fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return { ok: true, status: 200 } as unknown as Response;
    }) as never;
    const { apiClient } = await import('../api-client');
    await apiClient.getRaw('/api/backup/export?format=json', {}, { timeoutMs: 0 });
    expect(calls[0]!.init.signal).toBeUndefined();
  });
});
