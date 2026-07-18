import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Deep-review fix D6 verification (2026-05-17).
 *
 * Mobile's handleSubmitQueue per-item catch reads `e?.error ?? e?.code` to
 * detect REAUTH errors and re-throw them so the reauth dialog stays open
 * instead of being swallowed into the batch's `failed[]` list.
 *
 * This test locks the api-client error shape that contract depends on:
 *   - REAUTH_REQUIRED / REAUTH_FAILED responses are thrown RAW (the parsed
 *     JSON body), so `.error === 'REAUTH_REQUIRED'` is the discriminator.
 *   - Other 4xx errors are wrapped in `new Error(...)` with `.code` set to
 *     the body's `error` field.
 *
 * If either path changes shape, mobile's D6 catch will silently start
 * swallowing REAUTH again. This test breaks first.
 */

const mockFetch = vi.fn();
const originalFetch = globalThis.fetch;

vi.mock('../themes', () => ({}));

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.fetch = mockFetch as any;
  // Stub sessionStorage / localStorage for the Node test env so the
  // 401-side-effects branch doesn't blow up.
  if (typeof globalThis.sessionStorage === 'undefined') {
    const storage = new Map<string, string>();
    globalThis.sessionStorage = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => { storage.set(k, v); },
      removeItem: (k: string) => { storage.delete(k); },
      clear: () => storage.clear(),
      key: () => null,
      length: 0,
    } as any;
  }
  if (typeof globalThis.localStorage === 'undefined') {
    const storage = new Map<string, string>();
    globalThis.localStorage = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => { storage.set(k, v); },
      removeItem: (k: string) => { storage.delete(k); },
      clear: () => storage.clear(),
      key: () => null,
      length: 0,
    } as any;
  }
  // window for the location-redirect branch
  if (typeof globalThis.window === 'undefined') {
    (globalThis as any).window = { location: { pathname: '/', search: '', href: '/' } };
  }
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('D6 — api-client REAUTH error shape contract', () => {
  it('throws raw REAUTH_REQUIRED body so mobile catch sees e.error === "REAUTH_REQUIRED"', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      headers: { get: () => null },
      json: async () => ({
        error: 'REAUTH_REQUIRED',
        message: 'Re-authentication required',
        details: { action: 'START_CLEANING_CYCLE' },
      }),
    });

    const { apiClient } = await import('../api-client');
    let thrown: any = null;
    try {
      await apiClient.post('/api/filters/x/start-cycle', {});
    } catch (e) {
      thrown = e;
    }

    expect(thrown).not.toBeNull();
    // Mobile D6 catch reads `e?.error ?? e?.code` — must match the raw body shape.
    expect(thrown?.error).toBe('REAUTH_REQUIRED');
    expect(thrown?.message).toBe('Re-authentication required');
  });

  it('throws raw REAUTH_FAILED body so mobile catch sees e.error === "REAUTH_FAILED"', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      headers: { get: () => null },
      json: async () => ({
        error: 'REAUTH_FAILED',
        message: 'Incorrect password',
      }),
    });

    const { apiClient } = await import('../api-client');
    let thrown: any = null;
    try {
      await apiClient.post('/api/filters/x/advance', {});
    } catch (e) {
      thrown = e;
    }

    expect(thrown?.error).toBe('REAUTH_FAILED');
  });

  it('throws an Error with .code for non-REAUTH 4xx so mobile fallback catch (e.code path) still works', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      headers: { get: () => null },
      json: async () => ({
        error: 'BLOCK_CHANGE_REQUIRED',
        message: 'Filter belongs to a different block',
        details: { homeBlockId: 'b-1', requestedBlockId: 'b-2' },
      }),
    });

    const { apiClient } = await import('../api-client');
    let thrown: any = null;
    try {
      await apiClient.post('/api/filters/x/advance', {});
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.code).toBe('BLOCK_CHANGE_REQUIRED');
    expect(thrown.connectionInfo).toEqual({ homeBlockId: 'b-1', requestedBlockId: 'b-2' });
  });
});
