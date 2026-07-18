import { getApiBase } from './api-base';

// Absolute URL for a raw `fetch()` that can't go through apiClient (which
// JSON-stringifies bodies) — i.e. multipart/FormData uploads and .xlsx blob
// downloads. On the desktop browser getApiBase() is '' so this is a no-op;
// on the Capacitor APK there is NO origin to resolve a relative '/api/...'
// against, and the WebView serves index.html with HTTP 200 instead of ever
// reaching the API. Always wrap raw fetch paths with this.
export function apiUrl(path: string): string {
  return `${getApiBase()}${path}`;
}

export function getPhotoUrl(url: string | undefined): string {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  return `${getApiBase()}${url}`;
}
