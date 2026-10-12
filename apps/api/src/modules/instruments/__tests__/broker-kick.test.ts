import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { kickMqttClient, resetBrokerKickWarning } from '../broker-kick.js';

/**
 * The EMQX client kick (audit 2026-10-12 follow-up): after a credential or an
 * instrument is revoked, the API asks the broker to drop the device's open
 * MQTT session, because EMQX consults the auth hook only at CONNECT. Driven
 * against a STUB of EMQX's REST API — no broker is touched.
 */
interface Seen { method: string; url: string; auth: string | undefined }

let server: http.Server;
let base = '';
let seen: Seen[] = [];
/** What the stub answers next: a status, or 'hang' (never answers). */
let next: number | 'hang' = 204;
const saved: Record<string, string | undefined> = {};
const KEYS = ['EMQX_API_URL', 'EMQX_API_KEY', 'EMQX_API_SECRET'] as const;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization });
    if (next === 'hang') return;   // the timeout must end it, not the stub
    res.statusCode = next;
    res.end(next === 204 ? undefined : JSON.stringify({ code: 'X', message: 'stub' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.EMQX_API_URL = base;
  process.env.EMQX_API_KEY = 'digilogkey1';
  process.env.EMQX_API_SECRET = 'sekret';
  seen = []; next = 204;
  resetBrokerKickWarning();
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const logs = () => {
  const out: { level: string; msg: string }[] = [];
  return {
    out,
    log: {
      info: (_o: unknown, m: string) => out.push({ level: 'info', msg: m }),
      warn: (_o: unknown, m: string) => out.push({ level: 'warn', msg: m }),
    },
  };
};

describe('kickMqttClient', () => {
  it('DELETEs /api/v5/clients/{clientid} with the client id URL-encoded and basic auth key:secret', async () => {
    const l = logs();
    const r = await kickMqttClient('CWH/RDU/001-00', 'token regenerated', l.log);
    expect(r).toBe('kicked');
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('DELETE');
    expect(seen[0].url).toBe('/api/v5/clients/CWH%2FRDU%2F001-00');
    expect(seen[0].auth).toBe(`Basic ${Buffer.from('digilogkey1:sekret').toString('base64')}`);
  });

  it('a client that is not connected (404) is not an error', async () => {
    next = 404;
    const l = logs();
    expect(await kickMqttClient('GONE', 'deleted', l.log)).toBe('not-connected');
    expect(l.out.some((x) => x.level === 'warn')).toBe(false);
  });

  it('a broker refusal (401) is logged, never thrown', async () => {
    next = 401;
    const l = logs();
    expect(await kickMqttClient('X', 'deactivated', l.log)).toBe('failed');
    expect(l.out.some((x) => x.level === 'warn')).toBe(true);
  });

  it('a broker that never answers is abandoned after the short timeout, never thrown', async () => {
    next = 'hang';
    const l = logs();
    const t0 = Date.now();
    expect(await kickMqttClient('X', 'deactivated', l.log, 300)).toBe('failed');
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('an unreachable broker is logged, never thrown', async () => {
    process.env.EMQX_API_URL = 'http://127.0.0.1:1';   // nothing listens on port 1
    const l = logs();
    expect(await kickMqttClient('X', 'deactivated', l.log)).toBe('failed');
  });

  it('is a NO-OP with ONE warning when the key/secret are not configured', async () => {
    delete process.env.EMQX_API_KEY;
    const l = logs();
    expect(await kickMqttClient('A', 'deleted', l.log)).toBe('disabled');
    expect(await kickMqttClient('B', 'deleted', l.log)).toBe('disabled');
    expect(seen).toHaveLength(0);
    expect(l.out.filter((x) => x.level === 'warn')).toHaveLength(1);
  });
});
