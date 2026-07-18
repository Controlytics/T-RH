import { useEffect, useRef } from 'react';

/**
 * use-android-back-button — intercepts the Android hardware/gesture back button
 * on Capacitor APK builds and routes it to a caller-supplied handler.
 *
 * Why this exists
 * ---------------
 * With NO `backButton` listener registered, Capacitor's default behaviour is
 * `window.history.back()` while there's history, then `App.exitApp()` at the
 * root. On the tablet that exit destroys the WebView, which clears
 * `sessionStorage` — where the `access_token` lives — so the next launch forces
 * a login. Operators experienced this as "the back button logged me out".
 *
 * Registering ANY `backButton` listener suppresses that automatic exit and hands
 * control to JS. This hook gives the caller that control; as long as the handler
 * never calls `App.exitApp()`, the app never exits (and never self-logs-out) on
 * back. See `connectivity.ts` for the same dynamic-import-guarded plugin pattern
 * that keeps plain web builds (where the plugin/event don't exist) working.
 *
 * The handler is stored in a ref so the native listener is registered exactly
 * once but always invokes the latest closure (so it sees current view / modal
 * state without re-subscribing on every render).
 */
export function useAndroidBackButton(handler: () => void): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    let cancelled = false;
    let remove: (() => void) | undefined;

    (async () => {
      try {
        const mod = await import('@capacitor/app');
        const sub = await mod.App.addListener('backButton', () => {
          handlerRef.current();
        });
        if (cancelled) {
          // Unmounted before the async subscribe resolved — tear down now.
          try { (sub as any)?.remove?.(); } catch { /* ignore */ }
          return;
        }
        remove = () => { try { (sub as any)?.remove?.(); } catch { /* ignore */ } };
      } catch {
        // Plugin not available (plain web build) — backButton never fires there,
        // so there's nothing to wire up. No-op.
      }
    })();

    return () => {
      cancelled = true;
      if (remove) remove();
    };
  }, []);
}
