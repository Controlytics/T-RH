// NOTE: Prefer importing as `apiClient` using @/ alias across all files
import { getApiBase } from './api-base';
import { safeStorage } from './safe-storage';
import { READ_TIMEOUT_MS, LONG_READ_TIMEOUT_MS } from './read-bounds';

// Re-exported for callers that already hold the client; new callers import them from
// `read-bounds.ts` (see there for why they do not live here).
export { READ_TIMEOUT_MS, LONG_READ_TIMEOUT_MS };

/**
 * How long a READ may wait for the server (performance audit 2026-11-17, P-03).
 *
 * There was no limit anywhere: with the database hung, every page sat on
 * "Loading…" for as long as the connection lived (measured: 76.5 s and still
 * going), with nothing on screen to say why. Now a read that has not finished —
 * headers AND body — inside its bound is aborted and fails with `code: 'TIMEOUT'`.
 * The bounds themselves live in `read-bounds.ts`:
 *
 * - `READ_TIMEOUT_MS` — what a page LOAD may take: every SWR read (`swr-config.ts`).
 *   The heaviest ordinary page measured ~0.9 s (the overview at 1,013 instruments).
 * - `LONG_READ_TIMEOUT_MS` — what an action the operator STARTED may take (a report,
 *   a download: an explicit `apiClient.get`), and the Data Report table, which
 *   measured 12.6 s per page at 27 instruments x 30 days (G1-05) and grows with the
 *   selection. Bounded, but never short enough to cut a legitimate report.
 * - `timeoutMs: 0` — no limit (the backup download).
 *
 * WRITES ARE NOT BOUNDED HERE, deliberately: aborting a POST/PUT in the browser
 * does not stop the server, so the operator would read "timed out" for a change
 * that may well have committed — and a retry could record it twice. A write's
 * outcome has to be bounded on the server. (This also keeps the token refresh, a
 * POST, from ever "failing" by timeout.)
 */

export interface ReadOptions {
  /** Milliseconds before the read is abandoned; 0 = no limit. */
  timeoutMs?: number;
}

/** The error a timed-out read fails with. `code: 'TIMEOUT'` is what callers test. */
export function readTimeoutError(url: string, timeoutMs: number): Error {
  const seconds = Math.round(timeoutMs / 1000);
  const error = new Error(`The server did not answer within ${seconds} seconds. Nothing was changed — try again in a moment.`);
  error.name = 'TimeoutError';
  (error as any).code = 'TIMEOUT';
  (error as any).url = url;
  return error;
}

class ApiClient {
  private getToken(): string | null {
    // Through `safeStorage` (audit 2026-10-03, WEB-3): a blocked storage
    // accessor throws, and a throw here would fail every request at once.
    return safeStorage.session.get('access_token');
  }

  /**
   * The ONE place the Authorization header is built (audit 2026-10-03, WEB-11).
   * `request()`, `getRaw()` and `getBlob()` all go through it, so a change to
   * where the token lives cannot leave a hand-rolled `fetch` sending
   * `Bearer null` — which is exactly how the photo upload 401'd until 2026-08-11.
   */
  private authHeaders(options: RequestInit): Record<string, string> {
    const token = this.getToken();
    const headers: Record<string, string> = {
      ...(token && { Authorization: `Bearer ${token}` }),
    };
    // Only set Content-Type for requests with a body.
    //
    // NEVER for FormData: the browser must set it itself so it can append the
    // multipart boundary. Forcing `application/json` here makes the server
    // unable to find any parts, which surfaces as a confusing 400 about the
    // request not being multipart.
    if (options.body && !(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }
    return headers;
  }

  /** `fetch` with the shared headers; no body handling. */
  private async send(url: string, options: RequestInit): Promise<Response> {
    return fetch(`${getApiBase()}${url}`, {
      ...options,
      headers: {
        ...this.authHeaders(options),
        ...options.headers,
      },
    });
  }

  /**
   * Run `work` with an abort signal that fires after `timeoutMs` (0 = no limit).
   * The timer stays live until `work` RESOLVES — `fetch` resolves at the headers,
   * so `work` must read the body inside it, or the body read is unbounded.
   * A manual AbortController rather than `AbortSignal.timeout`: one code path for
   * every runtime the tests use.
   */
  private async bounded<T>(url: string, timeoutMs: number, work: (signal?: AbortSignal) => Promise<T>): Promise<T> {
    if (!timeoutMs) return work(undefined);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      return await work(controller.signal);
    } catch (err) {
      if (timedOut) throw readTimeoutError(url, timeoutMs);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A generic 401 = the session has ended: drop the token, the cached user and
   * the single-tab keys, and send the browser to /login. Not during login
   * itself, where a 401 is a wrong password and the form shows it.
   */
  private sessionEnded(url: string): void {
    if (url.includes('/api/auth/login')) return;
    safeStorage.session.remove('access_token');
    // Also drop cached user + single-tab keys. Without this, the cached
    // user kept `isAuthenticated` truthy on /login, /login auto-navigated
    // back to /, dashboard SWR queries 401'd, and the page ping-ponged
    // between / and /login forever.
    safeStorage.local.remove('digilog_cached_user');
    safeStorage.local.remove('digilog_active_tab_id');
    safeStorage.local.remove('digilog_tab_heartbeat');
    safeStorage.local.remove('digilog_active_user_id');
    // The `/m/login` branch that sat here went with the Capacitor remnants
    // (audit 2026-10-03, WEB-10): no `/m` route exists in main.tsx, so it
    // could only ever have sent a browser to the catch-all.
    if (!window.location.pathname.startsWith('/login')) {
      // No `?returnUrl=` (2026-10-03): the next sign-in lands on the
      // dashboard whatever page the session ended on. See use-auth.ts.
      window.location.href = '/login';
    }
  }

  /** `timeoutMs` bounds the whole exchange, body included; 0 = no limit (every write). */
  private request<T>(url: string, options: RequestInit = {}, timeoutMs = 0): Promise<T> {
    return this.bounded(url, timeoutMs, (signal) => this.requestOnce<T>(url, signal ? { ...options, signal } : options));
  }

  private async requestOnce<T>(url: string, options: RequestInit): Promise<T> {
    const res = await this.send(url, options);

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'PARSE_ERROR', message: 'Failed to parse server response' }));
      // Re-auth errors: throw without logging out so the dialog can show the error
      if (err.error === 'REAUTH_REQUIRED' || err.error === 'REAUTH_FAILED') {
        throw err;
      }
      // Force password change or password expired — redirect to change password.
      // 2026-05-21: skip the hard redirect when we're already on the
      // change-password page. Some background calls (JWT refresh, branding
      // poll) fire while the operator is typing the new password; a 403 here
      // would hard-reload the page under them. Just throw and let the caller
      // handle it.
      if (err.error === 'FORCE_PASSWORD_CHANGE' || err.error === 'PASSWORD_EXPIRED') {
        if (!window.location.pathname.startsWith('/change-password')) {
          window.location.href = '/change-password';
        }
        throw err;
      }
      // Generic 401 = session expired, log out (but not during login itself)
      if (res.status === 401) {
        this.sessionEnded(url);
        // Attach status + code so callers (and the SWR onError 401-suppressor
        // in swr-config.ts) can recognise this as an auth failure. Without
        // these, a 401 like "Missing token" (e.g. an ungated SWR firing before
        // login) leaked through onError as a visible "Load Error" toast.
        const authError = new Error(err.message ?? 'Invalid credentials');
        (authError as any).status = 401;
        (authError as any).code = err.error;
        throw authError;
      }
      const error = new Error(err.message ?? err.error ?? `Request failed: ${res.status}`);
      (error as any).status = res.status;
      (error as any).code = err.error;
      (error as any).connectionInfo = err.details ?? err.connectionInfo;
      (error as any).activeSession = err.activeSession;
      // Lockout-progress field — backend sends this on INVALID_PASSWORD so the
      // login UI can show "X attempts remaining before lockout".
      if (err.attemptsRemaining !== undefined) (error as any).attemptsRemaining = err.attemptsRemaining;
      // Phase 8.3 STALE_TAPE: lift currentTapeVersion from `details` to a
      // top-level field so callers (sync-engine, mobile-operations) don't have
      // to dig through connectionInfo. Mirrors the attemptsRemaining lift just
      // above. Only present on 409 STALE_TAPE — caller branches on err.code.
      if (err.details?.currentTapeVersion !== undefined) {
        (error as any).currentTapeVersion = err.details.currentTapeVersion;
      }
      throw error;
    }

    if (res.status === 204) return undefined as T;
    // Guard against empty bodies (e.g. proxy hiccup on cold start) —
    // res.json() throws "Unexpected end of JSON input" on empty text.
    const text = await res.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error('Failed to parse server response');
    }
  }

  /** A read. Bounded at `LONG_READ_TIMEOUT_MS` unless told otherwise; SWR passes `READ_TIMEOUT_MS`. */
  get<T>(url: string, opts: ReadOptions = {}) { return this.request<T>(url, {}, opts.timeoutMs ?? LONG_READ_TIMEOUT_MS); }
  post<T>(url: string, body: unknown, headers?: Record<string, string>) { return this.request<T>(url, { method: 'POST', body: JSON.stringify(body), ...(headers && { headers }) }); }
  /**
   * A POST that only READS — the selection is in the body because it does not fit a URL (`/telemetry-history`,
   * performance audit WA-26, 2026-11-18). Bounded like a GET (`LONG_READ_TIMEOUT_MS` unless `timeoutMs` says
   * otherwise), never like a write: a hung database must end in an error here too, not "Loading…" forever.
   */
  postRead<T>(url: string, body: unknown, opts: ReadOptions = {}) {
    return this.request<T>(url, { method: 'POST', body: JSON.stringify(body) }, opts.timeoutMs ?? LONG_READ_TIMEOUT_MS);
  }
  put<T>(url: string, body: unknown, headers?: Record<string, string>) { return this.request<T>(url, { method: 'PUT', body: JSON.stringify(body), ...(headers && { headers }) }); }
  patch<T>(url: string, body: unknown) { return this.request<T>(url, { method: 'PATCH', body: JSON.stringify(body) }); }
  /**
   * Multipart upload.
   *
   * Goes through `request()` so it picks up the ONE definition of where the
   * token lives and the shared error handling.
   * Hand-rolled `fetch` calls for uploads have already gone wrong once here:
   * the profile photo uploader read the token from `localStorage`, a key
   * nothing in the app ever writes, so it sent `Bearer null` and always 401'd.
   */
  postFormData<T>(url: string, form: FormData, headers?: Record<string, string>) {
    return this.request<T>(url, { method: 'POST', body: form, ...(headers && { headers }) });
  }

  /**
   * A NON-JSON response — a backup archive, an image — with the shared headers
   * (audit 2026-10-03, WEB-11). Resolves the raw `Response` so the caller can
   * read `Content-Disposition`; a non-2xx is thrown the way `request()` throws
   * it, and a 401 ends the session the same way. Until this existed, four
   * hand-rolled `fetch` calls each read the token themselves.
   */
  async getRaw(url: string, options: RequestInit = {}, readOpts: ReadOptions = {}): Promise<Response> {
    // Bounded until the HEADERS only: the caller reads the body, after this
    // returns. A large download that must not be cut passes `timeoutMs: 0`.
    return this.bounded(url, readOpts.timeoutMs ?? LONG_READ_TIMEOUT_MS, (signal) => this.rawOnce(url, options, signal));
  }

  private async rawOnce(url: string, options: RequestInit, signal?: AbortSignal): Promise<Response> {
    const res = await this.send(url, { ...options, method: options.method ?? 'GET', ...(signal && { signal }) });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      // Re-auth errors go up untouched, as `request()` throws them, so the
      // re-auth dialog can show a wrong password instead of logging out.
      if (err.error === 'REAUTH_REQUIRED' || err.error === 'REAUTH_FAILED') throw err;
      if (res.status === 401) this.sessionEnded(url);
      const error = new Error(err.message ?? err.error ?? `Request failed: ${res.status}`);
      (error as any).status = res.status;
      (error as any).code = err.error;
      throw error;
    }
    return res;
  }

  /** Headers AND body inside the bound. */
  async getBlob(url: string, options: RequestInit = {}, readOpts: ReadOptions = {}): Promise<Blob> {
    return this.bounded(url, readOpts.timeoutMs ?? LONG_READ_TIMEOUT_MS, async (signal) => (await this.rawOnce(url, options, signal)).blob());
  }
  // 2026-05-21 fix: DELETE must carry an explicit Content-Type + body, even
  // when the route doesn't need a body. On Android, CapacitorHttp's native
  // path uses HttpURLConnection which defaults Content-Type to
  // `application/x-www-form-urlencoded` for any non-GET request when the FE
  // didn't set one. Fastify has no parser for that media type and replies 415
  // "Unsupported Media Type" — which surfaced as a failed Remove
  // failing with "Unsupported Media Type". Sending an empty JSON body forces
  // Fastify's JSON parser to handle it; routes that don't read req.body see
  // an empty object and ignore it.
  delete<T>(url: string, body?: unknown) {
    return this.request<T>(url, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      // Defaults to {} (see the Android Content-Type quirk above); callers that
      // need to pass data (e.g. a required `reason`) supply it explicitly.
      body: JSON.stringify(body ?? {}),
    });
  }

  // Re-auth variants: include password for actions requiring re-authentication
  // Password is sent in BOTH body (_currentPassword) and header (x-reauth-password)
  // to ensure the backend can always extract it regardless of body parsing behavior.
  withReauth<T>(method: string, url: string, password: string, body?: unknown) {
    const headers: Record<string, string> = { 'x-reauth-password': password };
    const opts: RequestInit = { method, headers };
    // Methods that can carry a body: send one (with the password) so the
    // request always has a Content-Type Fastify can parse. See delete()
    // above for the Android Content-Type-default quirk this addresses.
    if (method !== 'GET' && method !== 'HEAD') {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify({ ...((body as object) ?? {}), _currentPassword: password });
    }
    // Only a GET is a read; every other method is a write and stays unbounded.
    return this.request<T>(url, opts, method === 'GET' ? LONG_READ_TIMEOUT_MS : 0);
  }
  deleteWithReauth<T>(url: string, password: string, body?: unknown) {
    return this.withReauth<T>('DELETE', url, password, body);
  }
  postWithReauth<T>(url: string, body: unknown, password: string) {
    return this.withReauth<T>('POST', url, password, body);
  }
  putWithReauth<T>(url: string, body: unknown, password: string) {
    return this.withReauth<T>('PUT', url, password, body);
  }
  patchWithReauth<T>(url: string, body: unknown, password: string) {
    return this.withReauth<T>('PATCH', url, password, body);
  }
  getWithReauth<T>(url: string, password: string) {
    return this.withReauth<T>('GET', url, password);
  }

  /**
   * Audit 2026-05-04 fix #4 (web-plumbing review H — JWT refresh
   * fragmentation). Centralised JWT refresh.
   *
   * The previous flow had THREE independent refresh sites:
   *   - use-auth.ts 30-min interval used raw `fetch('/api/auth/refresh')`
   *     (relative URL — silent no-op on Capacitor APK because the WebView
   *     origin is capacitor://, not the API host)
   *   - sync-engine.ts had its own inline refresh helper
   *   - nothing on the request path — a token expiring mid-request would
   *     trigger 401 logout instead of silent renewal
   *
   * Now: every refresh goes through this method. Goes through the normal
   * apiClient.post which uses VITE_API_URL → reaches the API on tablets.
   *
   * In-flight Promise guard means concurrent callers (interval + sync
   * engine + tab-switch wakeup) share one network request.
   *
   * Returns true on success, false on any failure (network or 401).
   * Caller decides whether to log out on false (typically: only the
   * interval refresher logs out; per-request callers let the next
   * request 401 through the normal logout path).
   */
  private inFlightRefresh: Promise<boolean> | null = null;
  refreshToken(): Promise<boolean> {
    if (this.inFlightRefresh) return this.inFlightRefresh;
    this.inFlightRefresh = (async () => {
      try {
        // INSIDE the try (audit 2026-11-07, S2-H7): an early return outside it
        // skipped the `finally` below, so the guard was never cleared — one call
        // before a token existed made every later refresh return that `false`.
        if (!this.getToken()) return false;
        const data = await this.post<{ token?: string }>('/api/auth/refresh', {});
        if (data?.token) {
          safeStorage.session.set('access_token', data.token);
          return true;
        }
        return false;
      } catch {
        // Silent — caller decides what to do. The request layer's normal
        // 401 handling will take over on subsequent requests if the token
        // really is dead.
        return false;
      } finally {
        // Clear after a microtask so concurrent callers awaiting the same
        // promise still get the result; only NEW callers after this point
        // fire a fresh refresh.
        queueMicrotask(() => { this.inFlightRefresh = null; });
      }
    })();
    return this.inFlightRefresh;
  }
}

export const apiClient = new ApiClient();
// The `api` alias was removed 2026-08-29 (audit L9). The same singleton was
// exported under two names and both were live — 63 files used `apiClient`,
// 13 used `api` — so a "find all usages of apiClient" search silently missed
// a fifth of the call sites, on the module every network call goes through.
// One name, one search result.
