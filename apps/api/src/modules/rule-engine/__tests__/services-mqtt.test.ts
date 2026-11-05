import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import dns from 'node:dns';

/**
 * `services.mqtt` (rule chains, fix round 2): ONE client per `nodeKey`
 * (`<chainId>:<nodeId>`), and the default client id derived from it — two
 * chains that share node ids never share a client or a client id. Fix round 3
 * (task-3b-review, "for later work in services.ts"): MQTT 3.1 really connects
 * as 3.1; a client id over ThingsBoard's limit (23 on 3.1, 256 otherwise) is
 * refused with ThingsBoard's words; a client that dropped fails fast; a PEM
 * certificate with SSL off is said to be unused. Review B M-4 (2026-11-05): the
 * broker goes through the S-6 guard — resolved ONCE, every address judged, the
 * client connected to the judged address with `servername` = the name. No broker
 * and no DNS: `mqtt.connect` and `dns.promises.lookup` are stand-ins (a name
 * resolves to the private 10.1.2.3 unless a test says otherwise).
 */
const connects: { clientId: string; client: FakeClient; opts: Record<string, unknown> }[] = [];

class FakeClient extends EventEmitter {
  connected = true;
  published: { topic: string; payload: string; opts: unknown }[] = [];
  ended = false;
  async publishAsync(topic: string, payload: string, opts: unknown) { this.published.push({ topic, payload, opts }); }
  async endAsync() { this.ended = true; }
}

vi.mock('mqtt', () => ({
  default: {
    connect: (opts: { clientId: string } & Record<string, unknown>) => {
      const client = new FakeClient();
      connects.push({ clientId: opts.clientId, client, opts });
      setImmediate(() => client.emit('connect'));
      return client;
    },
  },
}));

const { createRuleServices, mqttClientIdFor } = await import('../services.js');
const { RULE_ENGINE_CONFIG_DEFAULTS } = await import('../config.js');
const { logger } = await import('../../../lib/logger.js');

const services = () => createRuleServices({ config: () => ({ ...RULE_ENGINE_CONFIG_DEFAULTS }), inc: () => undefined });
const NODE = '0f000000-0000-4000-8000-0000000000aa';
const CHAIN_A = '0f000000-0000-4000-8000-00000000000a';
const CHAIN_B = '0f000000-0000-4000-8000-00000000000b';

type LookupResult = { address: string; family: number }[];
let resolves: Record<string, LookupResult | Error>;
let lookups: { host: string; opts: unknown }[];

beforeEach(() => {
  connects.length = 0;
  resolves = {};
  lookups = [];
  vi.spyOn(dns.promises, 'lookup').mockImplementation((async (host: string, opts: unknown) => {
    lookups.push({ host, opts });
    const r = resolves[host] ?? [{ address: '10.1.2.3', family: 4 }];
    if (r instanceof Error) throw r;
    return r;
  }) as never);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('mqttClientIdFor', () => {
  it('a blank client id is digilog-rule-<10 hex of the nodeKey>, within MQTT 3.1\'s 23 characters', () => {
    const a = mqttClientIdFor(`${CHAIN_A}:${NODE}`, {});
    const b = mqttClientIdFor(`${CHAIN_B}:${NODE}`, {});
    expect(a).toMatch(/^digilog-rule-[0-9a-f]{10}$/);
    expect(a.length).toBeLessThanOrEqual(23);
    expect(a).not.toBe(b);
    expect(mqttClientIdFor(`${CHAIN_A}:${NODE}`, {})).toBe(a);
    expect(mqttClientIdFor(`${CHAIN_A}:${NODE}`, { protocolVersion: 3 })).toBe(a);
  });

  it('a set client id is kept, with the nodeKey suffix only when appendClientIdSuffix', () => {
    expect(mqttClientIdFor(`${CHAIN_A}:${NODE}`, { clientId: ' gw ' })).toBe('gw');
    expect(mqttClientIdFor(`${CHAIN_A}:${NODE}`, { clientId: 'gw', appendClientIdSuffix: true })).toMatch(/^gw_[0-9a-f]{10}$/);
  });

  it('ThingsBoard\'s limit: on MQTT 3.1 a set id (its suffix included) over 23 characters is REFUSED with ThingsBoard\'s words; 256 otherwise', () => {
    const key = `${CHAIN_A}:${NODE}`;
    // 12 + "_" + 10 = 23: fits 3.1 exactly.
    expect(mqttClientIdFor(key, { clientId: 'gateway-node', appendClientIdSuffix: true, protocolVersion: 3 })).toHaveLength(23);
    expect(() => mqttClientIdFor(key, { clientId: 'gateway-node1', appendClientIdSuffix: true, protocolVersion: 3 }))
      .toThrow('The length of Client ID cannot be longer than 23, but current length is 24.');
    expect(() => mqttClientIdFor(key, { clientId: 'x'.repeat(24), protocolVersion: 3 }))
      .toThrow('The length of Client ID cannot be longer than 23, but current length is 24.');
    // 3.1.1 and 5 allow 256.
    expect(mqttClientIdFor(key, { clientId: 'gateway-node1', appendClientIdSuffix: true, protocolVersion: 4 })).toHaveLength(24);
    expect(mqttClientIdFor(key, { clientId: 'x'.repeat(256), protocolVersion: 5 })).toHaveLength(256);
    expect(() => mqttClientIdFor(key, { clientId: 'x'.repeat(257) }))
      .toThrow('The length of Client ID cannot be longer than 256, but current length is 257.');
  });
});

describe('services.mqtt', () => {
  it('one client per nodeKey: two chains with the same node id get two clients; the same key reuses its client', async () => {
    const svc = services();
    const cfg = { host: 'broker.local' };
    await svc.mqtt.publish(`${CHAIN_A}:${NODE}`, cfg, 't/1', '{"a":1}', 1, false);
    await svc.mqtt.publish(`${CHAIN_B}:${NODE}`, cfg, 't/1', '{"b":1}', 0, true);
    await svc.mqtt.publish(`${CHAIN_A}:${NODE}`, cfg, 't/2', '{"a":2}', 1, false);
    expect(connects).toHaveLength(2);
    expect(connects[0].clientId).not.toBe(connects[1].clientId);
    expect(connects[0].client.published.map((p) => p.topic)).toEqual(['t/1', 't/2']);
    expect(connects[1].client.published).toEqual([{ topic: 't/1', payload: '{"b":1}', opts: { qos: 0, retain: true } }]);
    await svc.mqtt.close(`${CHAIN_A}:${NODE}`);
    expect(connects[0].client.ended).toBe(true);
    expect(connects[1].client.ended).toBe(false);
    await svc.dispose();
    expect(connects[1].client.ended).toBe(true);
  });

  it('a changed config reconnects; a masked credential or a blank host is refused', async () => {
    const svc = services();
    await svc.mqtt.publish(`${CHAIN_A}:${NODE}`, { host: 'h1' }, 't', 'x', 1, false);
    await svc.mqtt.publish(`${CHAIN_A}:${NODE}`, { host: 'h2' }, 't', 'x', 1, false);
    expect(connects).toHaveLength(2);
    expect(connects[0].client.ended).toBe(true);
    await expect(svc.mqtt.publish(`${CHAIN_A}:${NODE}`, { host: 'h', credentials: { type: 'basic', username: 'u', password: '***' } }, 't', 'x', 1, false))
      .rejects.toThrow(/^CREDENTIAL_NOT_SET/);
    await expect(svc.mqtt.publish(`${CHAIN_A}:${NODE}`, { host: ' ' }, 't', 'x', 1, false)).rejects.toThrow(/^MQTT_HOST_REQUIRED/);
    await svc.dispose();
  });

  it('the protocol the node names is the protocol spoken: 3 → 3.1 (protocolId MQIsdp), 4 → 3.1.1, 5 → 5', async () => {
    const svc = services();
    await svc.mqtt.publish(`${CHAIN_A}:${NODE}`, { host: 'h', protocolVersion: 3 }, 't', 'x', 1, false);
    await svc.mqtt.publish(`${CHAIN_B}:${NODE}`, { host: 'h', protocolVersion: 4 }, 't', 'x', 1, false);
    await svc.mqtt.publish(`${CHAIN_A}:0f000000-0000-4000-8000-0000000000ab`, { host: 'h', protocolVersion: 5 }, 't', 'x', 1, false);
    expect(connects.map((c) => [c.opts.protocolVersion, c.opts.protocolId ?? 'MQTT'])).toEqual([[3, 'MQIsdp'], [4, 'MQTT'], [5, 'MQTT']]);
    await svc.dispose();
  });

  it('a 3.1 client id over 23 characters fails the publish before any connection', async () => {
    const svc = services();
    await expect(svc.mqtt.publish(`${CHAIN_A}:${NODE}`, { host: 'h', protocolVersion: 3, clientId: 'a-much-too-long-id', appendClientIdSuffix: true }, 't', 'x', 1, false))
      .rejects.toThrow('The length of Client ID cannot be longer than 23, but current length is 29.');
    expect(connects).toHaveLength(0);
    await svc.dispose();
  });

  it('a client that DROPPED after connecting fails the publish at once (MQTT_NOT_CONNECTED) — not after mqtt.js\'s offline queue and the 30 s budget', async () => {
    const svc = services();
    await svc.mqtt.publish(`${CHAIN_A}:${NODE}`, { host: 'broker.local' }, 't', 'first', 1, false);
    expect(connects).toHaveLength(1);
    connects[0].client.connected = false;
    connects[0].client.emit('offline');
    const t0 = Date.now();
    await expect(svc.mqtt.publish(`${CHAIN_A}:${NODE}`, { host: 'broker.local' }, 't', 'second', 1, false)).rejects.toThrow(/^MQTT_NOT_CONNECTED/);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(connects[0].client.published.map((p) => p.payload)).toEqual(['first']);
    // Back: published again, on the same client.
    connects[0].client.connected = true;
    await svc.mqtt.publish(`${CHAIN_A}:${NODE}`, { host: 'broker.local' }, 't', 'third', 1, false);
    expect(connects[0].client.published.map((p) => p.payload)).toEqual(['first', 'third']);
    expect(connects).toHaveLength(1);
    await svc.dispose();
  });

  it('cert.PEM with SSL OFF: warned that the certificate is NOT used and the connection is plain — as ThingsBoard does (it builds no TLS context without SSL)', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation((() => undefined) as never);
    const svc = services();
    await svc.mqtt.publish(`${CHAIN_A}:${NODE}`, { host: 'h', ssl: false, credentials: { type: 'cert.PEM', cert: 'CERT', privateKey: 'KEY' } }, 't', 'x', 1, false);
    expect(connects[0].opts).toMatchObject({ protocol: 'mqtt' });
    expect(connects[0].opts.cert).toBeUndefined();
    expect(connects[0].opts.key).toBeUndefined();
    const said = warn.mock.calls.map((c) => String(c[1]));
    expect(said.some((t) => /certificate/i.test(t) && /SSL is off/i.test(t))).toBe(true);
    // With SSL on, the certificate is used and nothing is said.
    warn.mockClear();
    await svc.mqtt.publish(`${CHAIN_B}:${NODE}`, { host: 'h', ssl: true, credentials: { type: 'cert.PEM', cert: 'CERT', privateKey: 'KEY' } }, 't', 'x', 1, false);
    expect(connects[1].opts).toMatchObject({ protocol: 'mqtts', cert: 'CERT', key: 'KEY' });
    expect(warn.mock.calls.map((c) => String(c[1])).some((t) => /certificate/i.test(t))).toBe(false);
    await svc.dispose();
  });
});

describe('the broker through the S-6 guard (review B M-4)', () => {
  const KEY = `${CHAIN_A}:${NODE}`;

  it('a NAME is resolved ONCE (all addresses), and the client connects to the JUDGED address with servername = the name', async () => {
    resolves['broker.plant'] = [{ address: '10.0.0.7', family: 4 }, { address: '10.0.0.8', family: 4 }];
    const svc = services();
    await svc.mqtt.publish(KEY, { host: 'broker.plant', ssl: true }, 't', 'x', 1, false);
    await svc.mqtt.publish(KEY, { host: 'broker.plant', ssl: true }, 't', 'y', 1, false);
    expect(lookups).toEqual([{ host: 'broker.plant', opts: { all: true, verbatim: true } }]);
    expect(connects).toHaveLength(1);
    expect(connects[0].opts).toMatchObject({ host: '10.0.0.7', servername: 'broker.plant', protocol: 'mqtts' });
    expect(connects[0].client.published.map((p) => p.payload)).toEqual(['x', 'y']);
    await svc.dispose();
  });

  it('a name resolving to a link-local / metadata address is REFUSED: a Failure, NO connect, no client kept — the next message judges it again', async () => {
    resolves['meta.evil'] = [{ address: '169.254.169.254', family: 4 }];
    const svc = services();
    await expect(svc.mqtt.publish(KEY, { host: 'meta.evil' }, 't', 'x', 1, false)).rejects.toThrow(/^TARGET_NOT_ALLOWED: 169\.254\.169\.254/);
    await expect(svc.mqtt.publish(KEY, { host: 'meta.evil' }, 't', 'x', 1, false)).rejects.toThrow(/^TARGET_NOT_ALLOWED/);
    expect(connects).toHaveLength(0);
    expect(lookups).toHaveLength(2);
    await svc.dispose();
  });

  it('ONE refused address among several refuses the target (a split answer cannot slip a metadata address in)', async () => {
    resolves['split.example'] = [{ address: '10.0.0.5', family: 4 }, { address: 'fe80::1', family: 6 }];
    const svc = services();
    await expect(svc.mqtt.publish(KEY, { host: 'split.example' }, 't', 'x', 1, false)).rejects.toThrow(/^TARGET_NOT_ALLOWED: fe80::1/);
    expect(connects).toHaveLength(0);
    await svc.dispose();
  });

  it('an IP literal is judged as it is, with no lookup: metadata / unspecified refused, loopback and private allowed (no servername)', async () => {
    const svc = services();
    for (const host of ['169.254.169.254', '0.0.0.0', '[fe80::1]', 'fd00:ec2::254']) {
      await expect(svc.mqtt.publish(`${CHAIN_B}:${host}`, { host }, 't', 'x', 1, false), host).rejects.toThrow(/^TARGET_NOT_ALLOWED/);
    }
    expect(connects).toHaveLength(0);
    await svc.mqtt.publish(`${CHAIN_A}:loop`, { host: '127.0.0.1' }, 't', 'x', 1, false);
    await svc.mqtt.publish(`${CHAIN_A}:lan`, { host: '192.168.1.20' }, 't', 'x', 1, false);
    expect(connects.map((c) => [c.opts.host, c.opts.servername])).toEqual([['127.0.0.1', undefined], ['192.168.1.20', undefined]]);
    expect(lookups).toEqual([]);
    await svc.dispose();
  });

  it('a lookup that FAILS is a Failure and is not cached: the next message resolves again', async () => {
    resolves['flaky.plant'] = Object.assign(new Error('getaddrinfo ENOTFOUND flaky.plant'), { code: 'ENOTFOUND' });
    const svc = services();
    await expect(svc.mqtt.publish(KEY, { host: 'flaky.plant' }, 't', 'x', 1, false)).rejects.toThrow(/ENOTFOUND/);
    resolves['flaky.plant'] = [{ address: '10.0.0.9', family: 4 }];
    await svc.mqtt.publish(KEY, { host: 'flaky.plant' }, 't', 'x', 1, false);
    expect(lookups).toHaveLength(2);
    expect(connects.map((c) => c.opts.host)).toEqual(['10.0.0.9']);
    await svc.dispose();
  });

  it('two messages racing to a node\'s FIRST publish share ONE lookup and ONE client', async () => {
    const svc = services();
    await Promise.all([
      svc.mqtt.publish(KEY, { host: 'broker.local' }, 't', 'a', 1, false),
      svc.mqtt.publish(KEY, { host: 'broker.local' }, 't', 'b', 1, false),
    ]);
    expect(lookups).toHaveLength(1);
    expect(connects).toHaveLength(1);
    expect(connects[0].client.published.map((p) => p.payload).sort()).toEqual(['a', 'b']);
    await svc.dispose();
  });
});

describe('the services surface', () => {
  it('has NO unguarded HTTP primitive: services.http is gone (the REST and Slack nodes send through the S-6 guarded transport)', () => {
    expect('http' in services()).toBe(false);
  });
});
