/**
 * Last-successful-server-contact tracker.
 *
 * Foundational for the W4 hard-cutoff lockout: if the client has not received
 * any HTTP response from the server in the configured `cacheHardCutoffHours`
 * window, the UI enters read-only mode.
 *
 * Why "any HTTP response" and not "any 2xx response": a 401 / 500 / 429 still
 * proves the server is reachable. Only a network failure (fetch threw before
 * returning) or an abort timeout counts as "no contact." Treating 5xx as "no
 * contact" would cause spurious lockouts during transient server hiccups.
 *
 * Storage: localStorage so the timestamp survives page reloads and tab
 * navigations without re-establishing contact. Key is namespaced so it
 * doesn't collide with other digilog_* keys.
 *
 * Subscriber API: the W4 blocker needs to know when contact resumes so it can
 * dismiss itself. `subscribe(cb)` registers a callback fired on every
 * `markContact()` AND every `clearContact()` (on logout, etc.). The callback
 * receives the new timestamp (0 means "cleared").
 */

const STORAGE_KEY = 'digilog_last_server_contact';

type Listener = (timestampMs: number) => void;
const listeners = new Set<Listener>();

/** Internal helper — write + notify. */
function emit(timestampMs: number) {
  try {
    localStorage.setItem(STORAGE_KEY, String(timestampMs));
  } catch {
    // localStorage may be unavailable in private-mode or quota-exhausted
    // environments. The in-memory listeners still fire, so the UI reacts
    // correctly even if persistence fails — just won't survive a reload.
  }
  for (const cb of listeners) cb(timestampMs);
}

/**
 * Mark contact based on a fetch Response, applying the < 500 rule.
 *
 * Why the rule: in dev (and in any deployment with a reverse proxy in
 * front of the API), a dead upstream produces a 5xx response from the
 * proxy — NOT a thrown fetch error. Vite's dev proxy specifically
 * returns 500 on connect-refused. If we treat those as "contact made,"
 * the W4 hard-cutoff timer resets on every failing call and the
 * read-only lockout never trips.
 *
 * 2xx / 3xx / 4xx all count as contact:
 *   - 2xx, 3xx — the obvious success / redirect cases
 *   - 401 / 403 — server is up, just rejecting auth or perms. The
 *     existing 401 handler in api-client will redirect to login; not
 *     marking contact wouldn't change that outcome but would falsely
 *     escalate to read-only mode on transient session expiries.
 *   - 404 / 422 / 429 — the server is responding with a structured
 *     reply. Counts as contact.
 *
 * 5xx is treated as "no contact": ambiguous between a backend bug and a
 * proxy-error, and the safer posture for 21 CFR Part 11 is to assume
 * the server isn't healthy. Sustained 5xx → eventual hard-cutoff →
 * operator sees read-only mode. If the API is fine and a single 5xx is
 * a transient blip, the next 2xx response will mark contact and reset.
 */
export function markServerContactFromResponse(res: { status: number }): void {
  if (res.status < 500) emit(Date.now());
}

/**
 * Clear the timestamp. Called on logout so the next login session starts with
 * a clean slate (otherwise a freshly logged-in user might see a hard-cutoff
 * blocker inherited from the previous session's stale timestamp).
 */
export function clearServerContact(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  for (const cb of listeners) cb(0);
}

/**
 * Read the last-contact timestamp. Returns 0 if never set. Useful for the
 * initial render of components that need to compute staleness synchronously.
 */
export function getLastServerContact(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Subscribe to contact updates. Returns an unsubscribe function. The callback
 * is NOT invoked immediately — call `getLastServerContact()` for the initial
 * value if you need it.
 */
export function subscribeToServerContact(cb: Listener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
