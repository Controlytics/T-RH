import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { apiUrl, getPhotoUrl } from '../url-utils';

describe('apiUrl', () => {
  beforeEach(() => { localStorage.clear(); delete (window as any).__API_BASE__; });

  it('is a no-op on the desktop browser (same-origin, base "")', () => {
    expect(apiUrl('/api/pm-schedules/upload')).toBe('/api/pm-schedules/upload');
  });

  it('prefixes the configured server address (the Capacitor APK case)', () => {
    localStorage.setItem('digilog.serverUrl', 'https://192.168.1.55:3000');
    expect(apiUrl('/api/pm-schedules/upload')).toBe('https://192.168.1.55:3000/api/pm-schedules/upload');
  });

  it('picks up a base set after module load (no cached read)', () => {
    expect(apiUrl('/api/x')).toBe('/api/x');
    (window as any).__API_BASE__ = 'https://tablet:3000';
    expect(apiUrl('/api/x')).toBe('https://tablet:3000/api/x');
  });
});

describe('getPhotoUrl', () => {
  beforeEach(() => { localStorage.clear(); delete (window as any).__API_BASE__; });

  it('leaves absolute URLs alone and prefixes relative ones', () => {
    localStorage.setItem('digilog.serverUrl', 'https://tablet:3000');
    expect(getPhotoUrl('https://cdn/x.png')).toBe('https://cdn/x.png');
    expect(getPhotoUrl('/uploads/x.png')).toBe('https://tablet:3000/uploads/x.png');
    expect(getPhotoUrl(undefined)).toBe('');
  });
});

/**
 * Source guard for #37/#31. These sites do multipart/FormData uploads, .xlsx
 * blob downloads, or pre-auth reads, so they can't go through apiClient (it
 * JSON-stringifies bodies) and use raw fetch instead. Every raw /api fetch must
 * resolve against getApiBase() — via apiUrl(), or via pdf-report.ts's own
 * `${getApiBase()}` idiom.
 *
 * Why it matters: getApiBase() is the base EVERY other caller already uses
 * (apiClient, getPhotoUrl, guest-request). A bare relative '/api/...' is the
 * only thing that doesn't, so it silently talks to a different origin than the
 * rest of the app — and on the Capacitor APK there is no origin at all, so the
 * WebView serves index.html with HTTP 200 and the call silently does nothing.
 *
 * NOT covered here: asset loads like pdf-report's `fetch(logoUrl)` — the
 * '/logo.jpg' default is a bundled asset that must NOT take the API base.
 */
describe('raw fetch call sites resolve against getApiBase()', () => {
  const FILES = [
    'routes/filter-management/filter-list.tsx',
    'routes/filter-management/replacement-schedule.tsx',
    'routes/pm-schedules/index.tsx',
    'routes/auth/contact-admin.tsx',
    'routes/config/backup.tsx',
    'lib/pdf-report.ts',
  ];

  // Matches fetch('/api/...') or fetch(`/api/...`) — i.e. an unprefixed path.
  // fetch(apiUrl('/api/... and fetch(`${getApiBase()}/api/... both pass.
  const RAW_RELATIVE_FETCH = /fetch\(\s*['"`]\/api\//g;

  for (const rel of FILES) {
    it(`${rel} has no unprefixed relative /api fetch`, () => {
      const src = readFileSync(resolve(__dirname, '../..', rel), 'utf8');
      expect(src.match(RAW_RELATIVE_FETCH) ?? []).toEqual([]);
    });
  }
});
