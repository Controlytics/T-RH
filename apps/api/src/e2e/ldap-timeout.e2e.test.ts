/**
 * Performance audit 2026-11-17, G4-02 — an LDAP directory that accepts the
 * connection and never answers must not hold the request open.
 *
 * ldapts bounds only the connect phase unless `timeout` is passed; the perf
 * audit measured Test Connection against such a server unanswered after 90 s,
 * and the same client serves directory logins and e-signature re-authentication.
 * `buildClient` now passes LDAP_OPERATION_TIMEOUT_MS, and the client is
 * released on every path.
 *
 * Real sockets: a TCP listener that accepts and stays silent.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import net from 'node:net';
import { ldapService, LDAP_OPERATION_TIMEOUT_MS } from '../modules/ldap/ldap.service.js';

describe('G4-02: a silent LDAP directory', () => {
  const sockets = new Set<net.Socket>();
  let server: net.Server;
  let port = 0;

  beforeAll(async () => {
    server = net.createServer((s) => {
      sockets.add(s);
      // Read and discard (never answer): a socket that is never read stays paused
      // and never sees the client close, which would look like a leak that is not.
      s.resume();
      s.on('error', () => { /* the client closes it */ });
      s.on('close', () => sockets.delete(s));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as net.AddressInfo).port;
  });

  afterAll(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('Test Connection gives up after the operation timeout instead of hanging', async () => {
    const started = Date.now();
    const result = await ldapService.testConnection({
      serverUrl: `ldap://127.0.0.1:${port}`,
      bindDN: 'cn=svc,dc=example,dc=com',
      bindPassword: 'not-used',
      searchBase: 'dc=example,dc=com',
    });
    const elapsed = Date.now() - started;

    expect(result.success).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(LDAP_OPERATION_TIMEOUT_MS - 500);
    expect(elapsed).toBeLessThan(LDAP_OPERATION_TIMEOUT_MS + 5_000);
  }, LDAP_OPERATION_TIMEOUT_MS + 20_000);

  it('releases the connection afterwards', async () => {
    // The client is destroyed on the timeout and closed in `finally`; the server
    // side sees the close a moment later.
    await vi.waitFor(() => expect(sockets.size).toBe(0), { timeout: 5_000, interval: 100 });
  });
});
