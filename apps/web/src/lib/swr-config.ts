import { type SWRConfiguration } from 'swr';
import { apiClient } from './api-client';

/**
 * Module-level toast callback registered by ToastProvider at mount.
 * Allows SWR onError (which runs outside React tree) to trigger toasts.
 */
let _toastError: ((title: string, message?: string) => void) | null = null;
export function registerSwrToast(fn: (title: string, message?: string) => void) { _toastError = fn; }
export function unregisterSwrToast() { _toastError = null; }

export const swrConfig: SWRConfiguration = {
  fetcher: (url: string) => apiClient.get(url),
  revalidateOnFocus: true,
  shouldRetryOnError: true,
  errorRetryCount: 2,
  errorRetryInterval: 5000,
  dedupingInterval: 5000,
  onError: (error: any) => {
    // Don't show toast for 401 (handled by api-client redirect)
    if (error?.status === 401 || error?.error === 'UNAUTHORIZED') return;
    // Silently ignore network errors (offline mode)
    const msg = String(error?.message || error || '').toLowerCase();
    if (msg.includes('failed to fetch') || msg.includes('networkerror') || msg.includes('network request failed') || msg.includes('load failed') || msg.includes('failed to connect') || msg.includes('unable to resolve host') || error?.name === 'TypeError') return;
    // Issue #6 fix (2026-05-18) + delta-audit 2026-05-20 §2.2 tightening +
    // 2026-05-20 widen: suppress doctype responses unconditionally.
    //
    // The narrower rule (only when navigator.onLine===false) missed the case
    // every operator hit on tablet: Capacitor's WebView returns navigator.onLine=true
    // even when API requests are routed back through the SPA index.html
    // fallback (cached SW, transient WiFi loss the OS hasn't surfaced yet,
    // or capacitor bridge race during app cold-start). The doctype response
    // is NEVER a legitimate API payload — the Fastify backend always returns
    // JSON, so an HTML body means the request didn't reach the server. Hide
    // the toast in all cases.
    //
    // True server-side JSON bugs (malformed UTF-8, bad proxy) wouldn't
    // produce <!doctype either — they'd produce malformed JSON or a
    // truncated body. Those errors still fire the toast.
    const isDoctypeFallback = msg.includes('doctype');
    if (isDoctypeFallback) return;
    console.error('[SWR Error]', error?.message || error);
    if (error?.status !== 401 && error?.status !== 403) {
      _toastError?.('Load Error', error?.message || 'Failed to load data. Please try again.');
    }
  },
};
