/**
 * The four ways a read of a device fails, and the exact words the operator
 * sees for each. Protocol module: imports nothing from the API.
 */
export type ModbusErrorCode = 'NO_ANSWER' | 'REFUSED' | 'DEVICE_EXCEPTION' | 'BAD_RESPONSE';

export interface ModbusErrorContext {
  host: string;
  port: number;
  /** Modicon range of the refused request, e.g. "40001–40010" (en dash). */
  range?: string;
  /** Modbus exception code from the device (DEVICE_EXCEPTION). */
  exception?: number;
  connectTimeoutMs?: number;
  responseTimeoutMs?: number;
  /** BAD_RESPONSE only: the device DID answer, but the reply did not match the request. */
  mismatch?: boolean;
}

export const DEFAULT_CONNECT_TIMEOUT_MS = 3000;
export const DEFAULT_RESPONSE_TIMEOUT_MS = 1000;

const EXCEPTION_NAMES: Record<number, string> = {
  0x01: 'illegal function',
  0x02: 'illegal address',
  0x03: 'illegal data value',
  0x04: 'server device failure',
  0x05: 'acknowledge',
  0x06: 'server device busy',
  0x0a: 'gateway path unavailable',
  0x0b: 'gateway target device failed to respond',
};

function hex2(n: number): string {
  return n.toString(16).toUpperCase().padStart(2, '0');
}

function seconds(ms: number): string {
  return String(Math.round(ms) / 1000);
}

export function modbusErrorMessage(code: ModbusErrorCode, ctx: ModbusErrorContext): string {
  const { host, port } = ctx;
  switch (code) {
    case 'NO_ANSWER':
      return `${host} : ${port} did not answer within ${seconds(ctx.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS)} s — check the IP, the cable, and that the device is on.`;
    case 'REFUSED':
      return `${host} refused port ${port} — the device is reachable but not listening on that port.`;
    case 'DEVICE_EXCEPTION': {
      const n = ctx.exception ?? 0;
      const name = EXCEPTION_NAMES[n] ?? `exception ${hex2(n)}`;
      return `The device refused registers ${ctx.range ?? 'unknown'} (exception ${hex2(n)}, ${name}) — the register map does not match it.`;
    }
    case 'BAD_RESPONSE':
      if (ctx.mismatch) {
        return `${host} : ${port} answered, but the reply did not match the request (wrong transaction, unit, function code or length) — check the unit ID and the register map.`;
      }
      return `${host} : ${port} accepted the connection but did not answer the read within ${seconds(ctx.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS)} s.`;
  }
}
