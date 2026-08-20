import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { apiUrl, getPhotoUrl } from '../url-utils';

describe('apiUrl', () => {
  beforeEach(() => { localStorage.clear(); delete (window as any).__API_BASE__; });

  it('is a no-op on the desktop browser (same-origin, base "")', () => {
    expect(apiUrl('/api/instruments/bulk')).toBe('/api/instruments/bulk');
  });

  it('prefixes the configured server address (the Capacitor APK case)', () => {
    localStorage.setItem('digilog.serverUrl', 'https://192.168.1.55:3000');
    expect(apiUrl('/api/instruments/bulk')).toBe('https://192.168.1.55:3000/api/instruments/bulk');
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
  /**
   * Scans the WHOLE tree rather than a hand-listed set of files.
   *
   * The original list named six call sites; three of them
   * (`routes/filter-management/filter-list.tsx`, `.../replacement-schedule.tsx`,
   * `routes/pm-schedules/index.tsx`) were deleted in the Phase 0 domain strip, so the
   * guard spent months failing with ENOENT instead of guarding anything. A list of known
   * offenders also says nothing about the file someone adds tomorrow, which is the case
   * that actually matters. Walking the tree is both stricter and unable to go stale.
   */
  const SRC = resolve(__dirname, '../..');

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = join(dir, e.name);
      if (e.isDirectory()) return e.name === 'node_modules' ? [] : sourceFiles(full);
      return /\.(ts|tsx)$/.test(e.name) ? [full] : [];
    });
  }

  /** Comment lines are prose about the rule, not calls that break it. */
  const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line);

  it('no source file fetches a bare relative /api path', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (!isComment(line) && /fetch\(\s*['"`]\/api\//.test(line)) {
          offenders.push(`${relative(SRC, file).replace(/\\/g, '/')}:${i + 1}`);
        }
      });
    }
    // A bare relative '/api/...' is the ONE fetch that does not resolve against
    // getApiBase(), so it silently talks to a different origin than the rest of the app —
    // and on the Capacitor APK there is no origin at all: the WebView serves index.html
    // with HTTP 200 and the call quietly does nothing.
    expect(offenders, `use apiUrl('/api/...') or \`\${getApiBase()}/api/...\` instead`).toEqual([]);
  });

  it('finds source files at all (guards the walker itself)', () => {
    // Without this, a broken walk returns [] and the assertion above passes vacuously —
    // exactly how the previous version of this guard failed silently.
    expect(sourceFiles(SRC).length).toBeGreaterThan(50);
  });
});
