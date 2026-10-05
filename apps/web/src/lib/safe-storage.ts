/**
 * The ONE door to `localStorage` and `sessionStorage` (audit 2026-10-03, WEB-3).
 *
 * A browser set to block site data — Chrome's "Block all cookies", a site-data
 * policy, some private windows — throws a `SecurityError` on ACCESS to
 * `window.localStorage` itself, not on a read. Before this module the auth hook
 * read the token during render through a bare `sessionStorage.getItem`, so that
 * exception surfaced inside `useAuth` and took the whole application shell down
 * to the root error boundary, while `AppLayout` carefully wrapped its own one
 * read a few lines later. Every access goes through here now, and every one of
 * them degrades to "nothing stored" rather than throwing.
 *
 * `get` returns `null` when the value is absent OR storage is unavailable — the
 * two are the same answer to every caller: there is nothing stored for you.
 * `set` / `remove` return whether the write landed, for the rare caller that
 * wants to know; most ignore it, because a preference that did not persist still
 * applies for the session.
 */

export type StorageArea = 'local' | 'session';

function area(which: StorageArea): Storage | null {
  // The property access is inside the try on purpose — it is the access that
  // throws under a block-site-data policy.
  try {
    return which === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

function make(which: StorageArea) {
  return {
    get(key: string): string | null {
      try {
        return area(which)?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    set(key: string, value: string): boolean {
      try {
        const s = area(which);
        if (!s) return false;
        s.setItem(key, value);
        return true;
      } catch {
        // Quota exhausted or storage blocked — the caller carries on without it.
        return false;
      }
    },
    remove(key: string): boolean {
      try {
        const s = area(which);
        if (!s) return false;
        s.removeItem(key);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export const safeStorage = {
  /** Per-workstation state that outlives the tab (display preferences, the cached user). */
  local: make('local'),
  /** Per-tab state (the access token lives here, and only here). */
  session: make('session'),
};
