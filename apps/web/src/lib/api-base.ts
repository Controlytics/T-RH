// Single source of truth for the API base URL. On the desktop browser this is
// '' (same-origin). On the Capacitor tablet it is the runtime address the
// operator set on the Server Address screen (persisted in localStorage, which
// persists across launches in the Android WebView). See EXE-PACKAGING-PLAN §13.
const STORAGE_KEY = 'digilog.serverUrl';

export function normalizeServerUrl(raw: string): string {
  const t = (raw ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/.+/i.test(t)) {
    throw new Error('Enter a full address, e.g. https://192.168.1.55:3000');
  }
  return t;
}

export function getApiBase(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return stored;
  } catch { /* localStorage unavailable — fall through */ }
  const w = (window as any).__API_BASE__;
  if (w) return w;
  const env = (import.meta as any).env?.VITE_API_URL;
  if (env) return env;
  return '';
}

export function setApiBase(url: string): string {
  const norm = normalizeServerUrl(url);
  try { localStorage.setItem(STORAGE_KEY, norm); } catch { /* ignore */ }
  (window as any).__API_BASE__ = norm;
  return norm;
}

export function clearApiBase(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  delete (window as any).__API_BASE__;
}

// Call once at boot, before any module reads the base, so synchronous reads of
// window.__API_BASE__ (existing precedent) see the persisted value.
export function initApiBaseFromStorage(): void {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && !(window as any).__API_BASE__) (window as any).__API_BASE__ = stored;
  } catch { /* ignore */ }
}
