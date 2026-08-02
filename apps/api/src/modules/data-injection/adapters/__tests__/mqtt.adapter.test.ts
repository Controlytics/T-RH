import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, connect as netConnect } from 'node:net';
// aedes v1 REMOVED the default export: `new Aedes()` throws a migration error
// telling you to use the async factory instead.
import { Aedes } from 'aedes';
import mqtt from 'mqtt';
import { createMqttAdapter } from '../mqtt.adapter.js';
import type { InboundMessage } from '../protocol-adapter.js';

const PORT = 18883;
let broker: Aedes;
let server: Server;

beforeAll(async () => {
  broker = await Aedes.createBroker();
  server = createServer(broker.handle as never);
  await new Promise<void>(r => server.listen(PORT, r));
});
afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()));
  await new Promise<void>(r => broker.close(r));
});

const profile = {
  id: 'p1', name: 'Test', protocolKey: 'mqtt',
  config: {
    brokerUrl: `mqtt://localhost:${PORT}`,
    qos: 1,
    subscriptions: [{ gatewaySlug: 'gw-001', baseTopic: 'test/gw-001' }],
  },
};

const publisher = async () => {
  const pub = mqtt.connect(`mqtt://localhost:${PORT}`);
  await new Promise<void>(r => pub.on('connect', () => r()));
  return pub;
};
const settle = (ms = 400) => new Promise(r => setTimeout(r, ms));

describe('mqtt adapter', () => {
  it('connects, subscribes, and delivers a message', async () => {
    const adapter = createMqttAdapter();
    const got: InboundMessage[] = [];
    await adapter.start(profile, async m => { got.push(m); });

    const pub = await publisher();
    pub.publish('test/gw-001/temp001/telemetry', JSON.stringify({ temp: 21.5 }), { qos: 1 });
    await settle();

    expect(got).toHaveLength(1);
    expect(got[0].topic).toBe('test/gw-001/temp001/telemetry');
    expect(JSON.parse(got[0].payload.toString()).temp).toBe(21.5);
    expect(adapter.health().connected).toBe(true);
    expect(adapter.health().messagesReceived).toBe(1);

    pub.end();
    await adapter.stop();
    expect(adapter.health().connected).toBe(false);
  });

  it('stamps the gateway from the SUBSCRIPTION, not by parsing the topic', async () => {
    const adapter = createMqttAdapter();
    const got: InboundMessage[] = [];
    await adapter.start(profile, async m => { got.push(m); });

    const pub = await publisher();
    pub.publish('test/gw-001/temp001/telemetry', '{"t":1}', { qos: 1 });
    await settle();

    expect(got[0].gatewaySlug).toBe('gw-001');
    expect(got[0].baseTopic).toBe('test/gw-001');

    pub.end();
    await adapter.stop();
  });

  it('routes to the right gateway with several subscribed, incl. the gw-1/gw-10 trap', async () => {
    const adapter = createMqttAdapter();
    const got: InboundMessage[] = [];
    await adapter.start({
      ...profile,
      config: {
        ...profile.config,
        subscriptions: [
          { gatewaySlug: 'gw-1', baseTopic: 'test/gw-1' },
          { gatewaySlug: 'gw-10', baseTopic: 'test/gw-10' },
        ],
      },
    }, async m => { got.push(m); });

    const pub = await publisher();
    pub.publish('test/gw-1/a/telemetry', '{"x":1}', { qos: 1 });
    await settle();
    pub.publish('test/gw-10/b/telemetry', '{"x":2}', { qos: 1 });
    await settle();

    const byGateway = Object.fromEntries(got.map(m => [m.topic, m.gatewaySlug]));
    expect(byGateway['test/gw-1/a/telemetry']).toBe('gw-1');
    expect(byGateway['test/gw-10/b/telemetry']).toBe('gw-10');

    pub.end();
    await adapter.stop();
  });

  it('leaves gatewaySlug empty when no subscription matches, so it dead-letters downstream', async () => {
    const adapter = createMqttAdapter();
    const got: InboundMessage[] = [];
    // Subscribed to a wildcard wider than the declared gateway bases, so a
    // message can arrive that belongs to no known gateway.
    await adapter.start({
      ...profile,
      config: {
        ...profile.config,
        extraFilters: ['test/#'],
        subscriptions: [{ gatewaySlug: 'gw-001', baseTopic: 'test/gw-001' }],
      },
    }, async m => { got.push(m); });

    const pub = await publisher();
    pub.publish('test/unknown-gw/x/telemetry', '{"x":1}', { qos: 1 });
    await settle();

    expect(got).toHaveLength(1);
    expect(got[0].gatewaySlug).toBe('');   // unattributable — Task 9 dead-letters it
    expect(got[0].baseTopic).toBe('');

    pub.end();
    await adapter.stop();
  });

  it('a handler that throws does not kill the connection', async () => {
    const adapter = createMqttAdapter();
    let calls = 0;
    await adapter.start(profile, async () => { calls++; throw new Error('boom'); });

    const pub = await publisher();
    pub.publish('test/gw-001/a/telemetry', '{"x":1}', { qos: 1 });
    await settle(300);
    pub.publish('test/gw-001/a/telemetry', '{"x":2}', { qos: 1 });
    await settle(300);

    expect(calls).toBe(2);                       // still receiving after a throw
    expect(adapter.health().connected).toBe(true);
    expect(adapter.health().lastError).toContain('boom');

    pub.end();
    await adapter.stop();
  });

  it('refuses a profile with no brokerUrl', async () => {
    const adapter = createMqttAdapter();
    await expect(
      adapter.start({ id: 'p2', name: 'Bad', protocolKey: 'mqtt', config: {} }, async () => {}),
    ).rejects.toThrow(/brokerUrl/i);
  });
});

// ── Real EMQX ────────────────────────────────────────────────────────────────
// aedes accepts any credentials, so a credential assertion against it would pass
// vacuously. These run against the real broker, which has auth enabled.
const emqxUp = await new Promise<boolean>((resolve) => {
  const s = netConnect({ host: '127.0.0.1', port: 1883 })
    .on('connect', () => { s.destroy(); resolve(true); })
    .on('error', () => resolve(false));
  setTimeout(() => { s.destroy(); resolve(false); }, 1500);
});

describe.skipIf(!emqxUp)('mqtt adapter against real EMQX (auth enabled)', () => {
  const emqxProfile = (username?: string, password?: string) => ({
    id: 'emqx-1', name: 'EMQX', protocolKey: 'mqtt',
    config: {
      brokerUrl: 'mqtt://127.0.0.1:1883',
      username, password, qos: 1,
      subscriptions: [{ gatewaySlug: 'gw-e2e', baseTopic: 'digilog-e2e/gw-e2e' }],
    },
  });

  it('connects with the profile credentials and receives a real message', async () => {
    const adapter = createMqttAdapter();
    const got: InboundMessage[] = [];
    await adapter.start(emqxProfile('digilog', 'digilog-mqtt-dev'), async m => { got.push(m); });
    expect(adapter.health().connected).toBe(true);

    const pub = mqtt.connect('mqtt://127.0.0.1:1883', {
      username: 'digilog', password: 'digilog-mqtt-dev',
    });
    await new Promise<void>(r => pub.on('connect', () => r()));
    pub.publish('digilog-e2e/gw-e2e/temp001/telemetry', '{"temp":21.5}', { qos: 1 });
    await settle(600);

    expect(got).toHaveLength(1);
    expect(got[0].gatewaySlug).toBe('gw-e2e');
    expect(JSON.parse(got[0].payload.toString()).temp).toBe(21.5);

    pub.end();
    await adapter.stop();
  });

  it('does NOT connect with wrong credentials', async () => {
    const adapter = createMqttAdapter();
    await adapter.start(emqxProfile('digilog', 'WRONG-PASSWORD'), async () => {});
    expect(adapter.health().connected).toBe(false);
    expect(adapter.health().lastError).toMatch(/not authorized|bad user|password/i);
    await adapter.stop();
  });
});
