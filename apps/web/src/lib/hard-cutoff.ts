import { getLastServerContact, subscribeToServerContact } from './server-contact';

/**
 * W4 (offline-safety series): hard-cutoff lockout logic.
 *
 * If the client has had NO successful server contact for more than
 * `cacheHardCutoffMs` (sourced from the SUPER_ADMIN offline-cache config —
 * see W1 / use-offline-config), the UI enters read-only mode:
 *
 *   - A full-screen blocker overlay renders on top of the app
 *     (HardCutoffBlocker component)
 *   - apiClient intercepts mutating methods (POST / PUT / PATCH / DELETE)
 *     and throws HARD_CUTOFF before the network call. GETs are allowed so
 *     SWR queries can keep trying to re-establish contact.
 *   - useOffline.executeOrQueue refuses to enqueue new operations so a
 *     locked-out tablet doesn't silently pile up writes that may not be
 *     accepted when contact eventually resumes (offline-replay grant has
 *     its own 24h expiry; queuing past that is wasted work + audit-trail
 *     noise).
 *
 * Why module-level mutable state and not a context: the apiClient and
 * sync-engine are not React-aware — they need a synchronous gate they can
 * consult from any code path. The React layer pushes the configured
 * cutoff in via setHardCutoffMs() on every config update; readers consult
 * isHardCutoffExceeded() inline.
 *
 * The cutoff defaults to 24h. Setting it to Infinity effectively disables
 * the feature; setting it to 0 means "lock immediately whenever offline,"
 * which is too aggressive — the config schema enforces a >= 0.01 minimum.
 */

let _hardCutoffMs = 24 * 60 * 60 * 1000;

export function setHardCutoffMs(ms: number): void {
  if (Number.isFinite(ms) && ms > 0) {
    _hardCutoffMs = ms;
  }
}

export function getHardCutoffMs(): number {
  return _hardCutoffMs;
}

/**
 * True iff the configured cutoff window has elapsed since the last
 * successful HTTP response from the server. A timestamp of 0 (never seen
 * contact) is treated as "not yet exceeded" so a brand-new session before
 * its first response doesn't trip the lockout — the first apiClient call
 * (login or otherwise) seeds the timestamp.
 */
export function isHardCutoffExceeded(): boolean {
  const lastContact = getLastServerContact();
  if (lastContact <= 0) return false;
  return Date.now() - lastContact > _hardCutoffMs;
}

/**
 * Subscribe to lockout-state transitions. The callback receives the new
 * boolean state. Useful for the FullPage blocker component which needs to
 * re-render the moment contact resumes (so the operator doesn't have to
 * wait for the next React render cycle from an unrelated trigger).
 *
 * Wired by piggy-backing on the server-contact subscription: every
 * markServerContact() fires the underlying subscription, and we forward a
 * computed isHardCutoffExceeded() to our own listeners.
 */
type CutoffListener = (exceeded: boolean) => void;
const cutoffListeners = new Set<CutoffListener>();
let serverContactUnsub: (() => void) | null = null;

function ensureBridge() {
  if (serverContactUnsub) return;
  serverContactUnsub = subscribeToServerContact(() => {
    const exceeded = isHardCutoffExceeded();
    for (const cb of cutoffListeners) cb(exceeded);
  });
}

export function subscribeToHardCutoff(cb: CutoffListener): () => void {
  ensureBridge();
  cutoffListeners.add(cb);
  return () => {
    cutoffListeners.delete(cb);
    if (cutoffListeners.size === 0 && serverContactUnsub) {
      serverContactUnsub();
      serverContactUnsub = null;
    }
  };
}
