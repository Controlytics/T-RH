import type { ZodError } from 'zod';
import { coerceModbusRegisterMap, type ModbusConnection, type ModbusRegisterMap } from '@digilog/shared';

/**
 * The instrument-level TCP/IP (Modbus) rules the instruments routes apply —
 * pure, so the create path, the update path and the bulk path (which shares
 * `createWithCredential`) read ONE wording and ONE judgement. The address rules
 * are `checkModbusAddress` (address.ts); the network list is
 * `loadModbusReaderConfig` (config.ts).
 */

export interface RuleRefusal { status: number; body: { error: string; message: string; details?: unknown } }

export const NOT_FOR_TCPIP: RuleRefusal = {
  status: 400,
  body: {
    error: 'NOT_FOR_TCPIP',
    message: 'A TCP/IP (Modbus) instrument is read by this server directly — it cannot be a gateway or report through one.',
  },
};

export const NOT_A_TCPIP_PROFILE: RuleRefusal = {
  status: 400,
  body: {
    error: 'NOT_A_TCPIP_PROFILE',
    message: 'An IP address, port, register map, Slave ID and read interval belong to instruments of a TCP/IP (Modbus) profile; this is a Gateway profile.',
  },
};

export const CONNECTION_DIFFERS: RuleRefusal = {
  status: 409,
  body: {
    error: 'CONNECTION_DIFFERS',
    message: 'An instrument cannot move between a Gateway profile and a TCP/IP (Modbus) profile — register a new instrument in that profile instead.',
  },
};

export const NO_TOKEN_FOR_TCPIP: RuleRefusal = {
  status: 400,
  body: {
    error: 'NO_TOKEN_FOR_TCPIP',
    message: 'A TCP/IP (Modbus) instrument has no access token — this server reads the device; the device never logs in.',
  },
};

export const REGISTER_MAP_SA_ONLY: RuleRefusal = {
  status: 403,
  body: {
    error: 'REGISTER_MAP_SA_ONLY',
    message: 'Only a super admin may change an instrument\'s register map — it decides which value is stored as which reading.',
  },
};

/** The fields a write may carry, as the shared schemas parse them. */
export interface ModbusWriteFields {
  isGateway?: boolean;
  gatewayId?: string | null;
  modbusHost?: string | null;
  modbusPort?: number | null;
  modbusRegisters?: ModbusRegisterMap | null;
  /** The instrument's Slave ID and read interval (CR-1, 2026-11-02). */
  modbusUnitId?: number | null;
  modbusIntervalSec?: number | null;
}

/**
 * The structural rule of a write against the profile's connection: a TCP/IP
 * instrument is never a gateway and never a gateway's child; a Gateway-profile
 * instrument carries no Modbus field. `false` / `null` are the "off" values a
 * whole-form save sends back, so only `isGateway === true`, a non-null
 * `gatewayId` and a non-null Modbus field are refused.
 */
export function connectionRefusal(fields: ModbusWriteFields, connection: ModbusConnection | string): RuleRefusal | null {
  if (connection === 'MODBUS_TCP') {
    if (fields.isGateway === true || (fields.gatewayId ?? null) !== null) return NOT_FOR_TCPIP;
    return null;
  }
  if ((fields.modbusHost ?? null) !== null || (fields.modbusPort ?? null) !== null || (fields.modbusRegisters ?? null) !== null
    || (fields.modbusUnitId ?? null) !== null || (fields.modbusIntervalSec ?? null) !== null) {
    return NOT_A_TCPIP_PROFILE;
  }
  return null;
}

/**
 * A TCP/IP instrument needs its address. Reported in the routes' existing
 * validation shape (`details.fieldErrors`), so a form puts the message under
 * the field.
 */
export function missingAddressRefusal(host: string | null | undefined, port: number | null | undefined): RuleRefusal | null {
  const fieldErrors: Record<string, string[]> = {};
  if (host === null || host === undefined || host === '') fieldErrors.modbusHost = ['A TCP/IP instrument needs its IP address'];
  if (port === null || port === undefined) fieldErrors.modbusPort = ['A TCP/IP instrument needs its port'];
  const fields = Object.keys(fieldErrors);
  if (fields.length === 0) return null;
  return {
    status: 400,
    body: {
      error: 'VALIDATION_ERROR',
      message: fields.length === 2 ? 'A TCP/IP instrument needs its IP address and port.' : (Object.values(fieldErrors)[0]![0] + '.'),
      details: { formErrors: [], fieldErrors },
    },
  };
}

/**
 * A TCP/IP instrument always has a Slave ID and a read interval (CR-1,
 * 2026-11-02): an explicit `null` on an update would leave a device the Reader
 * refuses as INVALID_CONFIG. Answered in the routes' validation shape, so a form
 * puts the message under the field. Omitted (`undefined`) = unchanged.
 */
export function missingReadingRefusal(unitId: number | null | undefined, intervalSec: number | null | undefined): RuleRefusal | null {
  const fieldErrors: Record<string, string[]> = {};
  if (unitId === null) fieldErrors.modbusUnitId = ['A TCP/IP instrument needs its Slave ID'];
  if (intervalSec === null) fieldErrors.modbusIntervalSec = ['A TCP/IP instrument needs its read interval'];
  const fields = Object.keys(fieldErrors);
  if (fields.length === 0) return null;
  return {
    status: 400,
    body: {
      error: 'VALIDATION_ERROR',
      message: fields.length === 2 ? 'A TCP/IP instrument needs its Slave ID and read interval.' : (Object.values(fieldErrors)[0]![0] + '.'),
      details: { formErrors: [], fieldErrors },
    },
  };
}

/** Which TCP/IP settings one write changes. */
export interface TcpipChanged { address?: boolean; map?: boolean; unitId?: boolean; interval?: boolean }

/**
 * The changed TCP/IP settings in words — ONE list for the PUT's reason refusal
 * and every INSTRUMENT_UPDATED meaning, single or bulk, so they read the same.
 * Two parts read "A and B", more "A, B and C"; `null` when nothing changed.
 */
export function tcpipChangedParts(changed: TcpipChanged, addressWord = 'TCP/IP address'): string | null {
  const parts = [
    changed.address ? addressWord : null,
    changed.map ? 'register map' : null,
    changed.unitId ? 'Slave ID' : null,
    changed.interval ? 'read interval' : null,
  ].filter((p): p is string => p !== null);
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * The INSTRUMENT_UPDATED meaning for a TCP/IP change, or null when nothing
 * TCP/IP changed. The caller passes the code already clipped (`codeLabel`):
 * signature_meaning is VARCHAR(255), and the longest list here is ~60 chars.
 */
export function tcpipChangeMeaning(code: string, changed: TcpipChanged): string | null {
  const what = tcpipChangedParts(changed);
  return what ? `Instrument "${code}" ${what} changed` : null;
}

/**
 * A body that failed the shared schema ONLY on `modbusHost` (a hostname, or an
 * address in an always-refused range) is an address the server will not read:
 * answered as ADDRESS_NOT_ALLOWED — the code every other address refusal
 * carries — with the schema's own words. Any other failure stays the plain
 * VALIDATION_ERROR (null here), so no other field's error is hidden.
 */
export function hostOnlyRefusal(error: ZodError): RuleRefusal | null {
  if (error.issues.length === 0 || !error.issues.every((i) => i.path[0] === 'modbusHost')) return null;
  return {
    status: 400,
    body: {
      error: 'ADDRESS_NOT_ALLOWED',
      message: error.issues.map((i) => i.message).join('; '),
      details: error.flatten(),
    },
  };
}

/**
 * Do two register maps say the same thing? Compared field by field, never as
 * JSON text: Postgres stores JSONB with its own key order, so the stored map and
 * the same map sent back would differ as strings. Both sides are read through
 * the one forgiving reader, so a stored map the schema no longer accepts reads
 * as "no map" on both sides of the comparison, as everywhere else.
 */
export function registerMapsEqual(a: unknown, b: unknown): boolean {
  const x = coerceModbusRegisterMap(a);
  const y = coerceModbusRegisterMap(b);
  if (x.length !== y.length) return false;
  return x.every((r, i) => {
    const o = y[i]!;
    return r.key === o.key && r.register === o.register && r.dataType === o.dataType
      && (r.byteOrder ?? null) === (o.byteOrder ?? null) && r.scale === o.scale;
  });
}
