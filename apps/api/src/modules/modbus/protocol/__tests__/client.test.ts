import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import type { ModbusRegisterMap } from '@digilog/shared';
import { readDevice } from '../client.js';
import { modbusErrorMessage } from '../errors.js';
import { startFakeSlave, type FakeSlave, type FakeSlaveOptions } from '../../../../test-support/fake-modbus-slave.js';

const map: ModbusRegisterMap = [
  { key: 'Temperature', register: '40001', dataType: 'FLOAT32', byteOrder: 'ABCD', scale: 1 },
  { key: 'Humidity', register: '40003', dataType: 'FLOAT32', byteOrder: 'CDAB', scale: 1 },
  { key: 'Pressure', register: '40005', dataType: 'UINT16', scale: 0.1 },
  { key: 'Power', register: '40006', dataType: 'INT16', scale: 1 },
  { key: 'Voltage', register: '40007', dataType: 'UINT16', scale: 1 },
  { key: 'Switch', register: '40008', dataType: 'UINT32', byteOrder: 'ABCD', scale: 1 },
];
const holding = { 0: 0x41b3, 1: 0x3333, 2: 0x3333, 3: 0x41b3, 4: 2301, 5: 0xffff, 6: 230, 7: 0, 8: 1 };

let slave: FakeSlave | undefined;
async function start(o: FakeSlaveOptions = {}) {
  slave = await startFakeSlave({ holding, ...o });
  return slave;
}
afterEach(async () => {
  await slave?.close();
  slave = undefined;
});

async function waitFor(cond: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
}

describe('readDevice', () => {
  it('reads the six values over one connection and one request', async () => {
    const s = await start();
    const r = await readDevice({ host: s.host, port: s.port, unitId: 1, map });
    expect(r).toMatchObject({ ok: true, requests: 1, rejected: [] });
    if (!r.ok) throw new Error('unreachable');
    expect(r.values).toEqual({ Temperature: 22.4, Humidity: 22.4, Pressure: 230.1, Power: -1, Voltage: 230, Switch: 1 });
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(s.connections()).toBe(1);
    await waitFor(() => s.closedConnections() === 1);
    expect(s.closedConnections()).toBe(1);
    expect(s.requests()).toEqual([{ functionCode: 3, address: 0, quantity: 9 }]);
  });

  it('reads input registers with FC 04', async () => {
    const s = await start({ input: { 0: 77 } });
    const r = await readDevice({ host: s.host, port: s.port, unitId: 1, map: [{ key: 'in', register: '30001', dataType: 'UINT16', scale: 1 }] });
    expect(r).toMatchObject({ ok: true, values: { in: 77 } });
    expect(s.requests()[0]).toMatchObject({ functionCode: 4 });
  });

  it('opens no connection for an empty map', async () => {
    const s = await start();
    const r = await readDevice({ host: s.host, port: s.port, unitId: 1, map: [] });
    expect(r).toMatchObject({ ok: true, requests: 0, values: {} });
    expect(s.connections()).toBe(0);
  });

  it('reports a device exception with the refused range and its words', async () => {
    const s = await start({ behaviour: 'exception02' });
    const r = await readDevice({ host: s.host, port: s.port, unitId: 1, map });
    expect(r).toMatchObject({ ok: false, code: 'DEVICE_EXCEPTION' });
    if (r.ok) throw new Error('unreachable');
    expect(r.message).toContain('registers 40001–40009 (exception 02, illegal address)');
    await waitFor(() => s.closedConnections() === 1);
    expect(s.closedConnections()).toBe(1);
  });

  it('is BAD_RESPONSE when the device accepts the connection but stays silent', async () => {
    const s = await start({ behaviour: 'silent' });
    const t0 = Date.now();
    const r = await readDevice({ host: s.host, port: s.port, unitId: 1, map });
    expect(r).toMatchObject({ ok: false, code: 'BAD_RESPONSE' });
    if (r.ok) throw new Error('unreachable');
    expect(r.message).toBe(`127.0.0.1 : ${s.port} accepted the connection but did not answer the read within 1 s.`);
    expect(Date.now() - t0).toBeLessThan(2500);
    await waitFor(() => s.closedConnections() === 1);
    expect(s.closedConnections()).toBe(1);
  });

  it('is REFUSED when nothing listens on the port', async () => {
    const probe = net.createServer();
    await new Promise<void>((res) => probe.listen(0, '127.0.0.1', () => res()));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((res) => probe.close(() => res()));
    const r = await readDevice({ host: '127.0.0.1', port, unitId: 1, map });
    expect(r).toMatchObject({ ok: false, code: 'REFUSED' });
    if (r.ok) throw new Error('unreachable');
    expect(r.message).toBe(`127.0.0.1 refused port ${port} — the device is reachable but not listening on that port.`);
  });

  it('is NO_ANSWER for an address nothing routes to', async () => {
    const r = await readDevice({ host: '10.255.255.1', port: 502, unitId: 1, map, connectTimeoutMs: 200 });
    expect(r).toMatchObject({ ok: false, code: 'NO_ANSWER' });
  });

  it.each(['wrongTxId', 'wrongUnit', 'wrongFc', 'short'] as const)(
    'a reply with %s is BAD_RESPONSE, stores nothing and the socket is closed',
    async (behaviour) => {
      const s = await start({ behaviour });
      const r = await readDevice({ host: s.host, port: s.port, unitId: 1, map, responseTimeoutMs: 1000 });
      expect(r).toMatchObject({ ok: false, code: 'BAD_RESPONSE' });
      expect(r).not.toHaveProperty('values');
      await waitFor(() => s.closedConnections() === 1);
      expect(s.closedConnections()).toBe(1);
    },
  );

  it('rejects with an AbortError (and closes) when the signal fires mid-read', async () => {
    const s = await start({ behaviour: 'silent' });
    const ac = new AbortController();
    const p = readDevice({ host: s.host, port: s.port, unitId: 1, map, signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    await waitFor(() => s.closedConnections() === 1);
    expect(s.closedConnections()).toBe(1);
  });
});

describe('modbusErrorMessage', () => {
  it('keeps the seconds true to the timeouts actually used', () => {
    expect(modbusErrorMessage('NO_ANSWER', { host: 'h', port: 1, connectTimeoutMs: 3000 })).toBe('h : 1 did not answer within 3 s — check the IP, the cable, and that the device is on.');
    expect(modbusErrorMessage('NO_ANSWER', { host: 'h', port: 1, connectTimeoutMs: 200 })).toContain('within 0.2 s');
    expect(modbusErrorMessage('BAD_RESPONSE', { host: 'h', port: 1, responseTimeoutMs: 1000 })).toContain('within 1 s.');
  });

  it('names exception codes, and unknown ones by number', () => {
    const c = (n: number) => modbusErrorMessage('DEVICE_EXCEPTION', { host: 'h', port: 1, range: '40001–40010', exception: n });
    expect(c(1)).toBe('The device refused registers 40001–40010 (exception 01, illegal function) — the register map does not match it.');
    expect(c(0x0b)).toContain('(exception 0B, gateway target device failed to respond)');
    expect(c(0x0a)).toContain('gateway path unavailable');
    expect(c(0x99)).toContain('(exception 99, exception 99)');
  });
});
