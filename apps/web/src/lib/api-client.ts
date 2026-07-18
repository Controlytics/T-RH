// NOTE: Prefer importing as `apiClient` using @/ alias across all files
import { markServerContactFromResponse } from './server-contact';
import { isHardCutoffExceeded } from './hard-cutoff';
import { getApiBase } from './api-base';

// W4: methods that are refused before they hit the network when the
// hard-cutoff lockout has fired. GET stays allowed so SWR polling can keep
// trying to re-establish contact; allowing POST /api/auth/login is the
// narrow exception that lets the operator re-auth and (transitively) mark
// fresh server contact, which dismisses the blocker.
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
function isHardCutoffBlocked(method: string | undefined, url: string): boolean {
  const m = (method ?? 'GET').toUpperCase();
  if (!MUTATING_METHODS.has(m)) return false;
  // Allow login + token refresh so the operator can recover from the lockout
  // without an "everything's broken" experience. The fresh response from
  // these endpoints marks server contact and dismisses the blocker.
  if (url.includes('/api/auth/login') || url.includes('/api/auth/refresh')) return false;
  return isHardCutoffExceeded();
}

class ApiClient {
  private getToken(): string | null {
    return sessionStorage.getItem('access_token');
  }

  private async request<T>(url: string, options: RequestInit = {}): Promise<T> {
    // W4 hard-cutoff gate: refuse mutating calls before they hit the wire.
    // Throws a structured error so callers (e.g. handleSubmit in
    // filter-operations) can distinguish the lockout from generic failures.
    if (isHardCutoffBlocked(options.method, url)) {
      const err = new Error('Read-only mode — reconnect to the server to perform actions.');
      (err as any).code = 'HARD_CUTOFF';
      (err as any).status = 503;
      throw err;
    }

    const token = this.getToken();
    const headers: Record<string, string> = {
      ...(token && { Authorization: `Bearer ${token}` }),
    };
    // Only set Content-Type for requests with a body
    if (options.body) {
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(`${getApiBase()}${url}`, {
      ...options,
      headers: {
        ...headers,
        ...options.headers,
      },
    });

    // The fetch returned — apply the < 500 rule so that Vite dev-proxy
    // errors (and any reverse-proxy "upstream unreachable" responses) do
    // NOT spuriously reset the W4 hard-cutoff timer. 2xx/3xx/4xx count as
    // contact (401 is evidence the server is up, just rejecting auth);
    // 5xx is treated as no-contact since it's ambiguous between a backend
    // bug and a proxy error, and the safer 21 CFR Part 11 posture is to
    // err toward read-only mode on sustained 5xx.
    markServerContactFromResponse(res);

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
      // would hard-reload the page and on Capacitor bounce the operator to
      // /m/login mid-typing. Just throw and let the caller handle it.
      if (err.error === 'FORCE_PASSWORD_CHANGE' || err.error === 'PASSWORD_EXPIRED') {
        if (!window.location.pathname.startsWith('/change-password')) {
          window.location.href = '/change-password';
        }
        throw err;
      }
      // Generic 401 = session expired, log out (but not during login itself)
      if (res.status === 401) {
        if (!url.includes('/api/auth/login')) {
          sessionStorage.removeItem('access_token');
          localStorage.removeItem('access_token_backup');
          // Also drop cached user + single-tab keys. Without this, the cached
          // user kept `isAuthenticated` truthy on /login, /login auto-navigated
          // back to /, dashboard SWR queries 401'd, and the page ping-ponged
          // between / and /login forever.
          localStorage.removeItem('digilog_cached_user');
          localStorage.removeItem('digilog_active_tab_id');
          localStorage.removeItem('digilog_tab_heartbeat');
          localStorage.removeItem('digilog_active_user_id');
          // Redirect to login — use mobile login for /m routes
          const isMobile = window.location.pathname.startsWith('/m');
          const loginPath = isMobile ? '/m/login' : '/login';
          if (!window.location.pathname.startsWith(loginPath)) {
            if (isMobile) {
              window.location.href = '/m/login';
            } else {
              const returnPath = window.location.pathname + window.location.search;
              window.location.href = returnPath !== '/' ? `/login?returnUrl=${encodeURIComponent(returnPath)}` : '/login';
            }
          }
        }
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

  get<T>(url: string) { return this.request<T>(url); }
  post<T>(url: string, body: unknown, headers?: Record<string, string>) { return this.request<T>(url, { method: 'POST', body: JSON.stringify(body), ...(headers && { headers }) }); }
  put<T>(url: string, body: unknown, headers?: Record<string, string>) { return this.request<T>(url, { method: 'PUT', body: JSON.stringify(body), ...(headers && { headers }) }); }
  patch<T>(url: string, body: unknown) { return this.request<T>(url, { method: 'PATCH', body: JSON.stringify(body) }); }
  // 2026-05-21 fix: DELETE must carry an explicit Content-Type + body, even
  // when the route doesn't need a body. On Android, CapacitorHttp's native
  // path uses HttpURLConnection which defaults Content-Type to
  // `application/x-www-form-urlencoded` for any non-GET request when the FE
  // didn't set one. Fastify has no parser for that media type and replies 415
  // "Unsupported Media Type" — which surfaced on the tablet as RFID Remove
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
    return this.request<T>(url, opts);
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
      const token = this.getToken();
      if (!token) return false;
      try {
        const data = await this.post<{ token?: string }>('/api/auth/refresh', {});
        if (data?.token) {
          sessionStorage.setItem('access_token', data.token);
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
export const api = apiClient;
