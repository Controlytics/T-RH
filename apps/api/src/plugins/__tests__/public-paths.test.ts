import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * An allowlist on an auth hook is where holes get made. This pins the EXACT set
 * of unauthenticated paths, so adding one is a deliberate, reviewed act rather
 * than a side effect. If you are here because this failed: confirm the new path
 * must genuinely be reachable without a login, then update this list.
 */
describe('auth plugin public paths', () => {
  const src = readFileSync(resolve(__dirname, '../auth.ts'), 'utf8');
  const block = src.slice(src.indexOf('const PUBLIC_PATHS'), src.indexOf('// Paths that are public only for GET'));
  const paths = [...block.matchAll(/'(\/[^']*)'/g)].map((m) => m[1]).sort();

  it('exposes only the expected unauthenticated paths', () => {
    expect(paths).toEqual([
      '/api/auth/beacon-logout',
      '/api/auth/forgot-password',
      '/api/auth/login',
      '/api/health',
      '/api/ingest/v1/attributes',
      '/api/ingest/v1/mqtt-auth',
      '/api/ingest/v1/telemetry',
      '/api/ingest/v1/ws',
      '/api/notification-settings/email/oauth2/code',
      '/docs',
      '/docs/',
    ]);
  });

  /**
   * The two gated-state allowlists (audit 2026-10-03, SEC-4). Each used to name
   * `/api/config/password-policy`, which under the old `startsWith` ALSO admitted
   * the policy WRITE while the account was locked or forced to change its
   * password. Only the public `/current` read belongs here; a parent prefix of
   * a writable resource is the hole being closed. Both lists are hoisted to
   * module scope so this test can read them the same way it reads PUBLIC_PATHS.
   */
  const listAfter = (marker: string, end: string) => {
    const start = src.indexOf(marker);
    expect(start, `${marker} must be a module-scope constant in auth.ts`).toBeGreaterThan(-1);
    const slice = src.slice(start, src.indexOf(end, start));
    return [...slice.matchAll(/'(\/[^']*)'/g)].map((m) => m[1]).sort();
  };

  it('a forced-password-change user may reach exactly these paths', () => {
    expect(listAfter('const PASSWORD_CHANGE_ALLOWED', 'const SA_LOCK_ALLOWED')).toEqual([
      '/api/auth/change-password',
      '/api/auth/logout',
      '/api/auth/me',
      '/api/config/password-policy/current',
      '/api/config/tablet-access/my-features',
    ]);
  });

  it('a SUPER_ADMIN under the API kill-switch may reach exactly these paths', () => {
    expect(listAfter('const SA_LOCK_ALLOWED', 'async function authPlugin')).toEqual([
      '/api/auth/change-password',
      '/api/auth/logout',
      '/api/auth/me',
      '/api/auth/refresh',
      '/api/config/password-policy/current',
      '/api/super-admin/api-lock',
    ]);
  });

  it('neither gated-state list names a writable config resource by its parent prefix', () => {
    for (const marker of ['const PASSWORD_CHANGE_ALLOWED', 'const SA_LOCK_ALLOWED']) {
      const list = listAfter(marker, marker === 'const SA_LOCK_ALLOWED' ? 'async function authPlugin' : 'const SA_LOCK_ALLOWED');
      expect(list, `${marker} must list the /current read, not the PUT-able prefix`).not.toContain('/api/config/password-policy');
    }
  });

  it('exposes exactly the four device-token ingest paths', () => {
    // All four turn on a per-instrument token instead of a user JWT: the HTTP
    // POST, the device's attributes over HTTP (2026-10-28, operator: "add for
    // all protocals" — reviewed then), the WebSocket upgrade, and the hook
    // EMQX calls at MQTT CONNECT (where the token arrives as the MQTT username
    // and the caller is the broker, which has no JWT to present). Any FIFTH
    // entry under /api/ingest/ is a new unauthenticated surface and belongs in
    // a review, not a diff.
    expect(paths.filter((p) => p.startsWith('/api/ingest/'))).toEqual([
      '/api/ingest/v1/attributes',
      '/api/ingest/v1/mqtt-auth',
      '/api/ingest/v1/telemetry',
      '/api/ingest/v1/ws',
    ]);
  });
});
