import { z } from 'zod';

/**
 * TCP/IP (Modbus) instruments — the contracts both sides share.
 *
 * An instrument profile is either `PUSH` ("Gateway": the device or a gateway
 * posts to us, today's behaviour) or `MODBUS_TCP` ("TCP/IP (Modbus)": this
 * server reads the instrument's own IP:port on a schedule using the register
 * map stored on the instrument). Validated strings, NOT a Postgres enum, so the
 * vocabulary can grow without a migration.
 *
 * Everything the browser must not decide — decoding, judgement, whether an
 * address is allowed or already in use — is decided on the server. What lives
 * here is only SHAPE: what a well-formed value looks like, so the form and the
 * API refuse the same input with the same words.
 */

export const MODBUS_CONNECTIONS = ['PUSH', 'MODBUS_TCP'] as const;
export type ModbusConnection = (typeof MODBUS_CONNECTIONS)[number];

export const MODBUS_INTERVAL = { min: 10, max: 3600, default: 60 } as const;
export const MODBUS_UNIT_ID = { min: 0, max: 255, default: 1 } as const;
export const MODBUS_PORT_DEFAULT = 502;
export const MODBUS_MAX_KEYS = 100;
export const MODBUS_MAX_REGISTERS_PER_REQUEST = 125;

/**
 * Reserved top-level payload keys: they carry metadata, not readings. ONE list
 * (plan ruling P2) — the payload parser skips them and the register-map schema
 * refuses them as keys, so a mapped key can never be swallowed as metadata.
 */
export const PAYLOAD_META_KEYS: ReadonlySet<string> = new Set(['ts', 'timestamp', 'quality', 'devices']);

export const MODBUS_DATA_TYPES = ['UINT16', 'INT16', 'UINT32', 'INT32', 'FLOAT32'] as const;
export const MODBUS_BYTE_ORDERS = ['ABCD', 'BADC', 'CDAB', 'DCBA'] as const;
export type ModbusDataType = (typeof MODBUS_DATA_TYPES)[number];
export type ModbusByteOrder = (typeof MODBUS_BYTE_ORDERS)[number];

export interface ModbusRegister {
  key: string;
  register: string;
  dataType: ModbusDataType;
  byteOrder?: ModbusByteOrder;
  scale: number;
}
export type ModbusRegisterMap = ModbusRegister[];

/** How many 16-bit registers a data type occupies. */
export function registersFor(dataType: ModbusDataType): 1 | 2 {
  return dataType === 'UINT16' || dataType === 'INT16' ? 1 : 2;
}

const REF_RE = /^([34])(\d{4,5})$/;

/**
 * 1-based Modicon reference to a 0-based wire address. 5 digits cover 1..9999
 * (`40001`..`49999`), 6 digits cover 1..65536 (`400001`..`465536`). Prefix 3 =
 * input registers (FC 04), 4 = holding registers (FC 03). Coils and discrete
 * inputs (0xxxx / 1xxxx) are not supported: this reader never writes and has no
 * bit access.
 */
export function parseModiconRef(ref: string): { area: 'HOLDING' | 'INPUT'; address: number } {
  const parsed = parseRef(ref);
  if (!parsed) {
    throw new Error(`Register reference "${ref}" is not a Modicon holding (4xxxx) or input (3xxxx) register from 1 to 65536`);
  }
  return { area: parsed.area, address: parsed.n - 1 };
}

function parseRef(ref: string): { area: 'HOLDING' | 'INPUT'; n: number; maxN: number } | null {
  if (typeof ref !== 'string') return null;
  const m = REF_RE.exec(ref);
  if (!m) return null;
  const digits = m[2]!;
  const n = Number(digits);
  const maxN = digits.length === 4 ? 9999 : 65536;
  if (n < 1 || n > maxN) return null;
  return { area: m[1] === '4' ? 'HOLDING' : 'INPUT', n, maxN };
}

const keySchema = z.string().trim()
  .min(1, 'Key is required')
  .max(64, 'Key must be 64 characters or fewer')
  .superRefine((k, ctx) => {
    if (PAYLOAD_META_KEYS.has(k.toLowerCase())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${k}" is reserved (${[...PAYLOAD_META_KEYS].join(', ')}) and cannot be a key` });
    } else if (/^dev\d+$/i.test(k)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${k}" is reserved (devN) and cannot be a key` });
    }
  });

export const modbusRegisterSchema = z.object({
  key: keySchema,
  register: z.string().superRefine((r, ctx) => {
    if (!parseRef(r)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Register "${r}" must be a holding (40001-49999 / 400001-465536) or input (30001-39999 / 300001-365536) register`,
      });
    }
  }),
  dataType: z.enum(MODBUS_DATA_TYPES, { errorMap: () => ({ message: `Data type must be one of ${MODBUS_DATA_TYPES.join(', ')}` }) }),
  byteOrder: z.enum(MODBUS_BYTE_ORDERS, { errorMap: () => ({ message: `Byte order must be one of ${MODBUS_BYTE_ORDERS.join(', ')}` }) }).optional(),
  scale: z.number({ invalid_type_error: 'Scale must be a number' })
    .refine((n) => Number.isFinite(n) && n !== 0, 'Scale must be a non-zero number')
    .default(1),
}).superRefine((r, ctx) => {
  const thirtyTwo = registersFor(r.dataType) === 2;
  if (thirtyTwo && !r.byteOrder) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['byteOrder'], message: `${r.dataType} needs a byte order (${MODBUS_BYTE_ORDERS.join(', ')})` });
  }
  if (!thirtyTwo && r.byteOrder) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['byteOrder'], message: `${r.dataType} is one register — it has no byte order` });
  }
});

/** The registers one entry occupies: area plus first and last reference number. */
function spanOf(r: ModbusRegister): { area: string; start: number; end: number; maxN: number } | null {
  const p = parseRef(r.register);
  if (!p) return null;
  return { area: p.area, start: p.n, end: p.n + registersFor(r.dataType) - 1, maxN: p.maxN };
}

export const modbusRegisterMapSchema = z.array(modbusRegisterSchema)
  .max(MODBUS_MAX_KEYS, `At most ${MODBUS_MAX_KEYS} keys`)
  .superRefine((map, ctx) => {
    const seen = new Map<string, number>();
    const spans: Array<{ i: number; area: string; start: number; end: number }> = [];
    map.forEach((r, i) => {
      const lk = r.key.toLowerCase();
      const first = seen.get(lk);
      if (first !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'key'], message: `Key "${r.key}" is already used by row ${first + 1} (keys are not case-sensitive)` });
      } else {
        seen.set(lk, i);
      }
      const s = spanOf(r);
      if (!s) return; // the element's own issue already says why
      if (s.end > s.maxN) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, 'register'],
          message: `${r.dataType} at ${r.register} runs past the end of the register area (${s.maxN === 9999 ? 'use the 6-digit form, e.g. 4' + String(s.start).padStart(5, '0') : 'last register is 65536'})`,
        });
        return;
      }
      for (const o of spans) {
        if (o.area === s.area && s.start <= o.end && o.start <= s.end) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i, 'register'],
            message: `${r.register} overlaps the registers of row ${o.i + 1} (${map[o.i]!.register})`,
          });
          break;
        }
      }
      spans.push({ i, ...s });
    });
  });

/** The stored map, forgivingly: anything unreadable is "no map". */
export function coerceModbusRegisterMap(value: unknown): ModbusRegisterMap {
  const r = modbusRegisterMapSchema.safeParse(value);
  return r.success ? (r.data as ModbusRegisterMap) : [];
}

// ---- addresses -----------------------------------------------------------

function parseIpv4(s: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const parts = [m[1]!, m[2]!, m[3]!, m[4]!];
  const nums = parts.map(Number);
  // Leading zeros are refused: "010" is octal to some stacks and decimal to others.
  if (nums.some((n, i) => n > 255 || String(n) !== parts[i])) return null;
  return nums as [number, number, number, number];
}

function ipToInt(o: [number, number, number, number]): number {
  return ((o[0] * 256 + o[1]) * 256 + o[2]) * 256 + o[3];
}

/**
 * An IPv4 dotted quad, never a hostname, and never an address a device cannot
 * be at: 0.0.0.0/8, 127.0.0.0/8 (this server), 169.254.0.0/16 (link-local,
 * incl. the cloud metadata address) and 224.0.0.0 upward (multicast, reserved,
 * broadcast). The administered device networks are checked by the API on top.
 */
export const modbusHostSchema = z.string().superRefine((h, ctx) => {
  const o = parseIpv4(h);
  if (!o) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter an IPv4 address such as 192.168.1.24 (hostnames are not accepted)' });
    return;
  }
  if (o[0] === 0 || o[0] === 127 || (o[0] === 169 && o[1] === 254) || o[0] >= 224) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${h} is not an address a device can have (0.x, 127.x, 169.254.x and 224.0.0.0 upward are refused)` });
  }
});

export const DEVICE_NETWORKS_DEFAULT = '10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16';

function parseCidr(c: string): { base: number; bits: number } | null {
  const m = /^([^/]+)\/(\d{1,2})$/.exec(c);
  if (!m) return null;
  const o = parseIpv4(m[1]!);
  const bits = Number(m[2]);
  if (!o || bits > 32) return null;
  return { base: ipToInt(o), bits };
}

function inCidr(ip: number, c: { base: number; bits: number }): boolean {
  const size = 2 ** (32 - c.bits);
  return Math.floor(ip / size) === Math.floor(c.base / size);
}

/** Comma- or newline-separated CIDRs; blanks ignored; every bad entry named. */
export function parseDeviceNetworks(text: string): { cidrs: string[]; errors: string[] } {
  const cidrs: string[] = [];
  const errors: string[] = [];
  for (const raw of text.split(/[,\n\r]+/)) {
    const c = raw.trim();
    if (!c) continue;
    if (parseCidr(c)) cidrs.push(c);
    else errors.push(`"${c}" is not a network such as 192.168.1.0/24`);
  }
  return { cidrs, errors };
}

export function ipInNetworks(ip: string, cidrs: string[]): boolean {
  const o = parseIpv4(ip);
  if (!o) return false;
  const n = ipToInt(o);
  return cidrs.some((c) => {
    const p = parseCidr(c);
    return p !== null && inCidr(n, p);
  });
}

// ---- the desktop tool's keys file ------------------------------------------

/**
 * Convert the desktop Modbus tool's keys file —
 * `{ keys: [{ key, register, data_type, byte_order }] }` — into a register map.
 * Registers are already 1-based Modicon there, so no offset is applied.
 * `byte_order` is dropped for 16-bit types (the tool writes one regardless) and
 * `scale` is 1. All-or-nothing: any bad row means `ok: false` with every error
 * naming its row, and no partial map.
 */
export function fromDesktopKeysFile(json: unknown): { ok: true; map: ModbusRegisterMap } | { ok: false; errors: string[] } {
  const keys = (json && typeof json === 'object') ? (json as { keys?: unknown }).keys : undefined;
  if (!Array.isArray(keys)) return { ok: false, errors: ['Not a keys file: expected { "keys": [ ... ] }'] };
  if (keys.length === 0) return { ok: false, errors: ['The keys file has no keys'] };

  const errors: string[] = [];
  const rows: unknown[] = [];
  keys.forEach((row, i) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      errors.push(`Row ${i + 1}: expected an object with key, register, data_type, byte_order`);
      rows.push(null);
      return;
    }
    const r = row as Record<string, unknown>;
    const dt = r.data_type;
    const is32 = typeof dt === 'string' && (MODBUS_DATA_TYPES as readonly string[]).includes(dt)
      && registersFor(dt as ModbusDataType) === 2;
    rows.push({
      key: r.key,
      register: typeof r.register === 'number' ? String(r.register) : r.register,
      dataType: dt,
      ...(is32 && r.byte_order !== undefined ? { byteOrder: r.byte_order } : {}),
      scale: 1,
    });
  });
  if (errors.length > 0) return { ok: false, errors };

  const parsed = modbusRegisterMapSchema.safeParse(rows);
  if (parsed.success) return { ok: true, map: parsed.data as ModbusRegisterMap };
  return {
    ok: false,
    errors: parsed.error.issues.map((is) => {
      const idx = is.path[0];
      return typeof idx === 'number' ? `Row ${idx + 1}: ${is.message}` : `Keys file: ${is.message}`;
    }),
  };
}
