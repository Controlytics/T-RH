import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerAdapter, getAdapter, listAdapters, clearAdaptersForTest,
  type IProtocolAdapter,
} from '../protocol-adapter.js';

const stub = (key: string): IProtocolAdapter => ({
  protocolKey: key,
  async start() {},
  async stop() {},
  health: () => ({
    connected: false, lastMessageAt: null, lastErrorAt: null,
    lastError: null, messagesReceived: 0, reconnectCount: 0,
  }),
});

describe('protocol adapter registry', () => {
  beforeEach(() => clearAdaptersForTest());

  it('registers and retrieves by protocolKey', () => {
    registerAdapter(stub('mqtt'));
    expect(getAdapter('mqtt')?.protocolKey).toBe('mqtt');
  });

  it('returns undefined for an unregistered protocol', () => {
    expect(getAdapter('modbus-tcp')).toBeUndefined();
  });

  it('rejects a duplicate registration rather than silently replacing', () => {
    registerAdapter(stub('mqtt'));
    expect(() => registerAdapter(stub('mqtt'))).toThrow(/already registered/i);
  });

  it('lists registered keys', () => {
    registerAdapter(stub('mqtt'));
    registerAdapter(stub('http'));
    expect(listAdapters().sort()).toEqual(['http', 'mqtt']);
  });
});
