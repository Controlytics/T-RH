// Single source of truth for the API base URL. On the desktop browser this is
// '' (same-origin). A runtime address set on the Server Address screen is
// persisted in localStorage and wins over the build-time VITE_API_URL.
//
// Storage goes through `safeStorage` (audit 2026-10-03, WEB-3): a browser that
// blocks site data throws on the accessor, and this is read before every request.
import { safeStorage } from './safe-storage';

const STORAGE_KEY = 'digilog.serverUrl';

export function normalizeServerUrl(raw: string): string {
  const t = (raw ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/.+/i.test(t)) {
    throw new Error('Enter a full address, e.g. https://192.168.1.55:3000');
  }
  return t;
}

export function getApiBase(): string {
  const stored = safeStorage.local.get(STORAGE_KEY);
  if (stored) return stored;
  const w = (window as any).__API_BASE__;
  if (w) return w;
  const env = (import.meta as any).env?.VITE_API_URL;
  if (env) return env;
  return '';
}

export function setApiBase(url: string): string {
  const norm = normalizeServerUrl(url);
  safeStorage.local.set(STORAGE_KEY, norm);
  (window as any).__API_BASE__ = norm;
  return norm;
}

export function clearApiBase(): void {
  safeStorage.local.remove(STORAGE_KEY);
  delete (window as any).__API_BASE__;
}

// Call once at boot, before any module reads the base, so synchronous reads of
// window.__API_BASE__ (existing precedent) see the persisted value.
export function initApiBaseFromStorage(): void {
  const stored = safeStorage.local.get(STORAGE_KEY);
  if (stored && !(window as any).__API_BASE__) (window as any).__API_BASE__ = stored;
}
