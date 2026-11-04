import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * `services.mqtt` (rule chains, fix round 2): ONE client per `nodeKey`
 * (`<chainId>:<nodeId>`), and the default client id derived from it — two
 * chains that share node ids never share a client or a client id. No broker:
 * `mqtt.connect` is a stand-in.
 */
const connects: { clientId: string; client: FakeClient }[] = [];

class FakeClient extends EventEmitter {
  connected = true;
  published: { topic: string; payload: string; opts: unknown }[] = [];
  ended = false;
  async publishAsync(topic: string, payload: string, opts: unknown) { this.published.push({ topic, payload, opts }); }
  async endAsync() { this.ended = true; }
}

vi.mock('mqtt', () => ({
  default: {
    connect: (opts: { clientId: string }) => {
      const client = new FakeClient();
      connects.push({ clientId: opts.clientId, client });
      setImmediate(() => client.emit('connect'));
      return client;
    },
  },
}));

const { createRuleServices, mqttClientIdFor } = await import('../services.js');
const { RULE_ENGINE_CONFIG_DEFAULTS } = await import('../config.js');

const services = () => createRuleServices({ config: () => ({ ...RULE_ENGINE_CONFIG_DEFAULTS }), inc: () => undefined });
const NODE = '0f000000-0000-4000-8000-0000000000aa';
const CHAIN_A = '0f000000-0000-4000-8000-00000000000a';
const CHAIN_B = '0f000000-0000-4000-8000-00000000000b';

beforeEach(() => { connects.length = 0; });

describe('mqttClientIdFor', () => {
  it('a blank client id is digilog-rule-<10 hex of the nodeKey>, within MQTT 3.1\'s 23 characters', () => {
    const a = mqttClientIdFor(`${CHAIN_A}:${NODE}`, {});
    const b = mqttClientIdFor(`${CHAIN_B}:${NODE}`, {});
    expect(a).toMatch(/^digilog-rule-[0-9a-f]{10}$/);
    expect(a.length).toBeLessThanOrEqual(23);
    expect(a).not.toBe(b);
    expect(mqttClientIdFor(`${CHAIN_A}:${NODE}`, {})).toBe(a);
  });

  it('a set client id is kept, with the nodeKey suffix only when appendClientIdSuffix', () => {
    expect(mqttClientIdFor(`${CHAIN_A}:${NODE}`, { clientId: ' gw ' })).toBe('gw');
    expect(mqttClientIdFor(`${CHAIN_A}:${NODE}`, { clientId: 'gw', appendClientIdSuffix: true })).toMatch(/^gw_[0-9a-f]{10}$/);
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
});
