import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { prisma } from '../../../lib/prisma.js';
import {
  registerAdapter, clearAdaptersForTest, type IProtocolAdapter,
} from '../adapters/protocol-adapter.js';
import { startConnections, stopConnections, getConnectionHealth } from '../connection-manager.js';

let started: { id: string; config: Record<string, unknown> }[] = [];

const fake = (key: string, failOnStart = false): IProtocolAdapter => ({
  protocolKey: key,
  async start(p) {
    if (failOnStart) throw new Error('cannot connect');
    started.push({ id: p.id, config: p.config });
  },
  async stop() {},
  health: () => ({
    connected: !failOnStart, lastMessageAt: null, lastErrorAt: null,
    lastError: null, messagesReceived: 0, reconnectCount: 0,
  }),
});

const cleanup = async () => {
  await prisma.$executeRawUnsafe(`DELETE FROM communication_profiles WHERE name LIKE 'cmtest-%'`);
};

describe('connection manager', () => {
  beforeEach(async () => {
    clearAdaptersForTest();
    started = [];
    await cleanup();
    await prisma.protocol.updateMany({ where: { key: 'mqtt' }, data: { isEnabled: false } });
  });
  afterEach(async () => { await stopConnections(); });
  // Leave the protocol as it was found — disabled is the shipped default.
  afterAll(async () => {
    await cleanup();
    await prisma.protocol.updateMany({ where: { key: 'mqtt' }, data: { isEnabled: false } });
  });

  it('starts nothing when the protocol is disabled', async () => {
    await prisma.communicationProfile.create({
      data: { name: 'cmtest-a', protocolKey: 'mqtt', config: { brokerUrl: 'mqtt://x' } },
    });
    registerAdapter(fake('mqtt'));
    await startConnections(async () => {});
    expect(started).toEqual([]);
  });

  it('starts one connection per active profile when the protocol is enabled', async () => {
    await prisma.protocol.update({ where: { key: 'mqtt' }, data: { isEnabled: true } });
    const p = await prisma.communicationProfile.create({
      data: { name: 'cmtest-b', protocolKey: 'mqtt', config: { brokerUrl: 'mqtt://x' } },
    });
    registerAdapter(fake('mqtt'));
    await startConnections(async () => {});
    expect(started.map(s => s.id)).toContain(p.id);
    expect(getConnectionHealth()[p.id].connected).toBe(true);
  });

  it('injects derived subscriptions into the config the adapter receives', async () => {
    await prisma.protocol.update({ where: { key: 'mqtt' }, data: { isEnabled: true } });
    const p = await prisma.communicationProfile.create({
      data: { name: 'cmtest-subs', protocolKey: 'mqtt', config: { brokerUrl: 'mqtt://x' } },
    });
    registerAdapter(fake('mqtt'));
    await startConnections(async () => {});

    // Select by id: the seeded database carries other active profiles, and
    // startConnections correctly starts all of them, so started[0] is not ours.
    const mine = started.find(s => s.id === p.id);
    expect(mine).toBeDefined();
    // No gateways on this profile, so the list is empty — but it must be PRESENT,
    // because the adapter subscribes to nothing at all without it.
    expect(mine!.config).toHaveProperty('subscriptions');
    expect(Array.isArray(mine!.config.subscriptions)).toBe(true);
    // The broker config from the profile must survive the merge.
    expect(mine!.config.brokerUrl).toBe('mqtt://x');
  });

  it('one failing profile does not prevent the others starting', async () => {
    await prisma.protocol.update({ where: { key: 'mqtt' }, data: { isEnabled: true } });
    await prisma.communicationProfile.create({
      data: { name: 'cmtest-c', protocolKey: 'mqtt', config: { brokerUrl: 'mqtt://x' } },
    });
    registerAdapter(fake('mqtt', true));
    await expect(startConnections(async () => {})).resolves.not.toThrow();
  });

  it('records the start error rather than swallowing it', async () => {
    await prisma.protocol.update({ where: { key: 'mqtt' }, data: { isEnabled: true } });
    const p = await prisma.communicationProfile.create({
      data: { name: 'cmtest-e', protocolKey: 'mqtt', config: { brokerUrl: 'mqtt://x' } },
    });
    registerAdapter(fake('mqtt', true));
    await startConnections(async () => {});
    expect(getConnectionHealth()[p.id].startError).toBe('cannot connect');
  });

  it('skips inactive profiles', async () => {
    await prisma.protocol.update({ where: { key: 'mqtt' }, data: { isEnabled: true } });
    const p = await prisma.communicationProfile.create({
      data: {
        name: 'cmtest-d', protocolKey: 'mqtt',
        config: { brokerUrl: 'mqtt://x' }, isActive: false,
      },
    });
    registerAdapter(fake('mqtt'));
    await startConnections(async () => {});
    expect(started.map(s => s.id)).not.toContain(p.id);
  });

  it('ignores a profile whose protocol has no adapter registered', async () => {
    await prisma.protocol.update({ where: { key: 'mqtt' }, data: { isEnabled: true } });
    await prisma.communicationProfile.create({
      data: { name: 'cmtest-f', protocolKey: 'mqtt', config: { brokerUrl: 'mqtt://x' } },
    });
    // Nothing registered at all.
    await expect(startConnections(async () => {})).resolves.not.toThrow();
    expect(getConnectionHealth()).toEqual({});
  });
});
