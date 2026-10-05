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
 * WRITE-ONLY as of 2026-08-29 (audit cleanup). This module had a reader half —
 * `getLastServerContact()` and a `subscribe(cb)` API — built for the W4
 * hard-cutoff blocker, which does not exist in this fork. Nothing imported
 * either, so the module maintained a listener Set and notified it on every
 * single HTTP response for an audience of zero.
 *
 * The write half IS live: `api-client.ts` calls `markServerContactFromResponse`
 * on each response and `use-auth.ts` clears it on logout. The timestamp is
 * therefore kept accurate in localStorage and is ready for a reader whenever
 * one is written — which is why the storage itself was not removed with the
 * notifier.
 */

import { safeStorage } from './safe-storage';

const STORAGE_KEY = 'digilog_last_server_contact';

/** Internal helper — persist the timestamp. */
function emit(timestampMs: number) {
  // localStorage may be unavailable in private-mode or quota-exhausted
  // environments. Nothing else depends on this write succeeding, so a
  // failure is simply a timestamp that will not survive a reload. The guard
  // is `safeStorage`'s (audit 2026-10-03, WEB-3).
  safeStorage.local.set(STORAGE_KEY, String(timestampMs));
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
  safeStorage.local.remove(STORAGE_KEY);
}


