import net from 'node:net';
import type { ModbusRegisterMap } from '@digilog/shared';
import { decodeMap } from './decode.js';
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_RESPONSE_TIMEOUT_MS,
  modbusErrorMessage,
  type ModbusErrorCode,
  type ModbusErrorContext,
} from './errors.js';
import { planReads, wordKey, type ReadRequest } from './plan.js';

export type ReadResult =
  | { ok: true; values: Record<string, number>; rejected: { key: string; reason: string }[]; elapsedMs: number; requests: number }
  | { ok: false; code: ModbusErrorCode; message: string };

export interface ReadDeviceOptions {
  host: string;
  port: number;
  unitId: number;
  map: ModbusRegisterMap;
  connectTimeoutMs?: number;
  responseTimeoutMs?: number;
  signal?: AbortSignal;
}

const MBAP_LEN = 7;
/** A Modbus TCP ADU is at most 260 bytes: 7 header + 253 PDU. */
const MAX_FRAME_LENGTH_FIELD = 254;

/** Modicon reference text for a 0-based address: "40001", "400001" past 9999. */
function modicon(prefix: 3 | 4, address: number): string {
  const n = address + 1;
  return `${prefix}${String(n).padStart(n > 9999 ? 5 : 4, '0')}`;
}

function rangeOf(req: ReadRequest): string {
  const prefix = req.functionCode === 3 ? 4 : 3;
  return `${modicon(prefix, req.address)}–${modicon(prefix, req.address + req.quantity - 1)}`;
}

/** errno codes that mean "nothing answered", as opposed to "somebody answered no". */
function isRefusal(err: NodeJS.ErrnoException): boolean {
  return err.code === 'ECONNREFUSED';
}

/**
 * Read every register in the map from one device: one connection, the planned
 * requests in order, each awaited, then the socket is closed — on EVERY path.
 * Every failure of the device or network is a `ReadResult` with `ok: false`;
 * nothing partial is ever returned as a success. A device that answers wrongly
 * (wrong transaction id, unit id or function code, or the wrong number of
 * bytes) is `BAD_RESPONSE` with the "reply did not match" wording; silence is the "did not answer" wording. Only a programming error, or an abort through
 * `signal`, rejects (the abort rejects with an `AbortError`; a unit id or port
 * outside its range with a `RangeError`, before any socket is opened).
 */
export function readDevice(opts: ReadDeviceOptions): Promise<ReadResult> {
  const connectMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const responseMs = opts.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
  const { host, port, unitId, signal } = opts;
  // Refused at ENTRY, as a rejection (final review F-6): a unit id outside a
  // byte would throw inside the socket's 'connect' listener (`writeUInt8`), out
  // of reach of any try/catch — an uncaught exception ends the API process. Both
  // callers validate first, so reaching here is a programming error: it
  // rejects, it is never turned into an ok:false.
  if (!Number.isInteger(unitId) || unitId < 0 || unitId > 255) {
    return Promise.reject(new RangeError(`Modbus unit ID ${String(unitId)} is not an integer 0 to 255.`));
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return Promise.reject(new RangeError(`Port ${String(port)} is not an integer 1 to 65535.`));
  }
  const requests = planReads(opts.map);
  const started = performance.now();

  const abortError = () => {
    const e = new Error('Modbus read aborted');
    e.name = 'AbortError';
    return e;
  };
  if (signal?.aborted) return Promise.reject(abortError());
  if (requests.length === 0) {
    return Promise.resolve({ ok: true, values: Object.create(null) as Record<string, number>, rejected: [], elapsedMs: 0, requests: 0 });
  }

  return new Promise<ReadResult>((resolve, reject) => {
    const socket = new net.Socket();
    socket.setNoDelay(true);
    const words = new Map<string, number>();
    let buf: Buffer = Buffer.alloc(0);
    let stage: 'connecting' | 'reading' = 'connecting';
    let index = 0;
    let txId = 0;
    let timer: NodeJS.Timeout | undefined;
    let done = false;

    const ctx = (extra: Partial<ModbusErrorContext> = {}): ModbusErrorContext => ({
      host, port, connectTimeoutMs: connectMs, responseTimeoutMs: responseMs, ...extra,
    });

    const finish = (outcome: ReadResult | Error) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    };
    const fail = (code: ModbusErrorCode, extra: Partial<ModbusErrorContext> = {}) =>
      finish({ ok: false, code, message: modbusErrorMessage(code, ctx(extra)) });
    const onAbort = () => finish(abortError());
    signal?.addEventListener('abort', onAbort, { once: true });

    const arm = (ms: number, code: ModbusErrorCode) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fail(code), ms);
    };

    const sendNext = () => {
      const req = requests[index]!;
      txId = (txId + 1) & 0xffff;
      const adu = Buffer.alloc(12);
      adu.writeUInt16BE(txId, 0);
      adu.writeUInt16BE(0, 2); // protocol id
      adu.writeUInt16BE(6, 4); // unit id + PDU (5 bytes)
      adu.writeUInt8(unitId, 6);
      adu.writeUInt8(req.functionCode, 7);
      adu.writeUInt16BE(req.address, 8);
      adu.writeUInt16BE(req.quantity, 10);
      arm(responseMs, 'BAD_RESPONSE');
      socket.write(adu);
    };

    /** Returns true when a full frame was consumed and handled (success or failure). */
    const handleFrame = (): boolean => {
      if (buf.length < MBAP_LEN) return false;
      const lengthField = buf.readUInt16BE(4);
      if (buf.readUInt16BE(2) !== 0 || lengthField < 2 || lengthField > MAX_FRAME_LENGTH_FIELD) {
        fail('BAD_RESPONSE', { mismatch: true });
        return true;
      }
      const total = 6 + lengthField;
      if (buf.length < total) return false; // wait for the rest, by the MBAP length
      const frame = buf.subarray(0, total);
      buf = buf.subarray(total);
      const req = requests[index]!;

      if (frame.readUInt16BE(0) !== txId || frame.readUInt8(6) !== unitId) {
        fail('BAD_RESPONSE', { mismatch: true });
        return true;
      }
      const fc = frame.readUInt8(7);
      if (fc === (req.functionCode | 0x80)) {
        if (lengthField !== 3) { fail('BAD_RESPONSE', { mismatch: true }); return true; }
        fail('DEVICE_EXCEPTION', { range: rangeOf(req), exception: frame.readUInt8(8) });
        return true;
      }
      if (fc !== req.functionCode || lengthField < 3) {
        fail('BAD_RESPONSE', { mismatch: true });
        return true;
      }
      const byteCount = frame.readUInt8(8);
      if (byteCount !== req.quantity * 2 || lengthField !== 3 + byteCount) {
        fail('BAD_RESPONSE', { mismatch: true });
        return true;
      }
      const area = req.functionCode === 3 ? 'HOLDING' : 'INPUT';
      for (let i = 0; i < req.quantity; i++) words.set(wordKey(area, req.address + i), frame.readUInt16BE(9 + i * 2));

      index++;
      if (index < requests.length) {
        sendNext();
        return false;
      }
      const decoded = decodeMap(opts.map, words);
      finish({ ok: true, ...decoded, elapsedMs: Math.round(performance.now() - started), requests: requests.length });
      return true;
    };

    socket.on('connect', () => {
      stage = 'reading';
      // The same guard as the data handler's (final review F-6): nothing thrown
      // here may escape the listener. A backstop — the entry checks above leave
      // nothing known that can throw.
      try {
        sendNext();
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
    socket.on('data', (chunk) => {
      if (done || stage !== 'reading') return;
      buf = Buffer.concat([buf, chunk]);
      try {
        while (!done && handleFrame()) { /* keep consuming whole frames */ }
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
    // After the connection was accepted, an error or a close we did not cause
    // is the device dropping the line before it answered — its own sentence
    // (final review F-7), not the response timeout's, which would put a false
    // cause into the "stopped answering" audit row's {reason}.
    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (stage === 'connecting') fail(isRefusal(err) ? 'REFUSED' : 'NO_ANSWER');
      else fail('BAD_RESPONSE', { closed: true });
    });
    socket.on('close', () => {
      if (stage === 'connecting') fail('NO_ANSWER');
      else fail('BAD_RESPONSE', { closed: true });
    });

    arm(connectMs, 'NO_ANSWER');
    socket.connect({ host, port });
  });
}
