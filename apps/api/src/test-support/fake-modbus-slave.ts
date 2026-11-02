/**
 * A Modbus TCP slave for tests (FC 03 / 04 only). Test support: it binds
 * 127.0.0.1:0, which production code never may (the address rules live above
 * the protocol module). It records connections and closes so a test can assert
 * "the socket was closed" and "no connection was made".
 */
import net from 'node:net';

export type FakeSlaveBehaviour = 'normal' | 'exception02' | 'silent' | 'wrongTxId' | 'wrongUnit' | 'wrongFc' | 'short';

export interface FakeSlaveOptions {
  holding?: Record<number, number>;
  input?: Record<number, number>;
  unitId?: number;
  behaviour?: FakeSlaveBehaviour;
  /**
   * 'normal' replies only: answer this many ms after the request instead of at
   * once — a slow device, for tests that need a read still in flight (the
   * Reader's skip-while-running and stop() cases). Keep it under the client's
   * 1000 ms response timeout or the read fails BAD_RESPONSE. Default 0.
   */
  delayMs?: number;
}

export interface FakeSlave {
  host: string;
  port: number;
  /** Connections accepted so far. */
  connections(): number;
  /** Connections that have since closed (from either side). */
  closedConnections(): number;
  /** Read requests received (FC, address, quantity) in arrival order. */
  requests(): Array<{ functionCode: number; address: number; quantity: number }>;
  close(): Promise<void>;
}

export async function startFakeSlave(opts: FakeSlaveOptions = {}): Promise<FakeSlave> {
  const holding = opts.holding ?? {};
  const input = opts.input ?? {};
  const unitId = opts.unitId ?? 1;
  const behaviour = opts.behaviour ?? 'normal';
  const delayMs = opts.delayMs ?? 0;
  const pending = new Set<NodeJS.Timeout>();
  const sockets = new Set<net.Socket>();
  const seen: Array<{ functionCode: number; address: number; quantity: number }> = [];
  let connections = 0;
  let closed = 0;

  const frame = (txId: number, unit: number, pdu: Buffer): Buffer => {
    const out = Buffer.alloc(7 + pdu.length);
    out.writeUInt16BE(txId & 0xffff, 0);
    out.writeUInt16BE(0, 2);
    out.writeUInt16BE(pdu.length + 1, 4);
    out.writeUInt8(unit & 0xff, 6);
    pdu.copy(out, 7);
    return out;
  };

  const dataPdu = (fc: number, area: Record<number, number>, address: number, quantity: number): Buffer => {
    const pdu = Buffer.alloc(2 + quantity * 2);
    pdu.writeUInt8(fc, 0);
    pdu.writeUInt8(quantity * 2, 1);
    for (let i = 0; i < quantity; i++) pdu.writeUInt16BE((area[address + i] ?? 0) & 0xffff, 2 + i * 2);
    return pdu;
  };

  const handle = (socket: net.Socket, req: Buffer) => {
    const txId = req.readUInt16BE(0);
    const unit = req.readUInt8(6);
    const fc = req.readUInt8(7);
    const address = req.readUInt16BE(8);
    const quantity = req.readUInt16BE(10);
    seen.push({ functionCode: fc, address, quantity });
    if (behaviour === 'silent' || unit !== unitId) return;
    const area = fc === 4 ? input : holding;
    switch (behaviour) {
      case 'exception02':
        socket.write(frame(txId, unit, Buffer.from([fc | 0x80, 0x02])));
        return;
      case 'wrongTxId':
        socket.write(frame(txId + 1, unit, dataPdu(fc, area, address, quantity)));
        return;
      case 'wrongUnit':
        socket.write(frame(txId, unit + 1, dataPdu(fc, area, address, quantity)));
        return;
      case 'wrongFc': {
        const other = fc === 3 ? 4 : 3;
        socket.write(frame(txId, unit, dataPdu(other, area, address, quantity)));
        return;
      }
      case 'short':
        // A well-formed frame, but one register fewer than was asked for.
        socket.write(frame(txId, unit, dataPdu(fc, area, address, Math.max(0, quantity - 1))));
        return;
      default: {
        const reply = frame(txId, unit, dataPdu(fc, area, address, quantity));
        if (delayMs <= 0) {
          socket.write(reply);
          return;
        }
        const t = setTimeout(() => {
          pending.delete(t);
          if (!socket.destroyed) socket.write(reply);
        }, delayMs);
        pending.add(t);
      }
    }
  };

  const server = net.createServer((socket) => {
    connections++;
    sockets.add(socket);
    let buf = Buffer.alloc(0);
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 12) {
        const total = 6 + buf.readUInt16BE(4);
        if (buf.length < total) break;
        const req = buf.subarray(0, total);
        buf = buf.subarray(total);
        handle(socket, Buffer.from(req));
      }
    });
    socket.on('error', () => { /* a client that hangs up mid-write is not a test failure */ });
    socket.on('close', () => { closed++; sockets.delete(socket); });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as net.AddressInfo).port;

  return {
    host: '127.0.0.1',
    port,
    connections: () => connections,
    closedConnections: () => closed,
    requests: () => [...seen],
    close: () => new Promise<void>((resolve) => {
      for (const t of pending) clearTimeout(t);
      pending.clear();
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  };
}
