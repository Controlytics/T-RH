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
      '/api/ingest/v1/mqtt-auth',
      '/api/ingest/v1/telemetry',
      '/api/ingest/v1/ws',
      '/api/notification-settings/email/oauth2/code',
      '/docs',
      '/docs/',
    ]);
  });

  it('exposes exactly the three device-token ingest paths', () => {
    // All three turn on a per-instrument token instead of a user JWT: the HTTP
    // POST, the WebSocket upgrade, and the hook EMQX calls at MQTT CONNECT
    // (where the token arrives as the MQTT username and the caller is the
    // broker, which has no JWT to present). Any FOURTH entry under /api/ingest/
    // is a new unauthenticated surface and belongs in a review, not a diff.
    expect(paths.filter((p) => p.startsWith('/api/ingest/'))).toEqual([
      '/api/ingest/v1/mqtt-auth',
      '/api/ingest/v1/telemetry',
      '/api/ingest/v1/ws',
    ]);
  });
});
