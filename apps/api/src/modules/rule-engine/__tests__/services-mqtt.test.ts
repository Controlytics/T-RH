import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * `services.mqtt` (rule chains, fix round 2): ONE client per `nodeKey`
 * (`<chainId>:<nodeId>`), and the default client id derived from it — two
 * chains that share node ids never share a client or a client id. Fix round 3
 * (task-3b-review, "for later work in services.ts"): MQTT 3.1 really connects
 * as 3.1; a client id over ThingsBoard's limit (23 on 3.1, 256 otherwise) is
 * refused with ThingsBoard's words; a client that dropped fails fast; a PEM
 * certificate with SSL off is said to be unused. No broker: `mqtt.connect` is a
 * stand-in.
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

beforeEach(() => { connects.length = 0; });
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

describe('the services surface', () => {
  it('has NO unguarded HTTP primitive: services.http is gone (the REST and Slack nodes send through the S-6 guarded transport)', () => {
    expect('http' in services()).toBe(false);
  });
});
