import { ipInNetworks, modbusHostSchema } from '@digilog/shared';
import { prisma } from '../../lib/prisma.js';
import { withVisibility, type resolveVisibility } from '../instruments/visibility.js';
import { loadModbusReaderConfig } from './config.js';

export type ModbusAddressCheck =
  | { ok: true }
  | { ok: false; status: 400 | 409; code: 'ADDRESS_NOT_ALLOWED' | 'ADDRESS_IN_USE'; message: string };

/** The loopback address `allowLoopbackForTests` admits — that one, nothing else in 127.0.0.0/8. */
const TEST_LOOPBACK = '127.0.0.1';

/**
 * Rules 1-3 of `checkModbusAddress` below — may this server read `host:port` at
 * all — with the device networks passed in. PURE: no database. The Reader
 * calls it before every read with the configuration it has just loaded (one
 * snapshot for "is reading on" and "which networks"), and it does not ask the
 * in-use question: a stored instrument's own address is not "in use", and the
 * partial unique index already makes it the only holder.
 */
export function checkModbusAddressAllowed(
  host: string,
  port: number,
  deviceNetworks: readonly string[],
  opts: { allowLoopbackForTests?: boolean } = {},
): ModbusAddressCheck {
  const loopbackForTests = opts.allowLoopbackForTests === true && host === TEST_LOOPBACK;
  if (!loopbackForTests) {
    const shape = modbusHostSchema.safeParse(host);
    if (!shape.success) {
      return { ok: false, status: 400, code: 'ADDRESS_NOT_ALLOWED', message: shape.error.issues[0]?.message ?? `${host} is not an address this server may read.` };
    }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, status: 400, code: 'ADDRESS_NOT_ALLOWED', message: 'Port must be 1 to 65535.' };
  }
  if (!loopbackForTests && !ipInNetworks(host, [...deviceNetworks])) {
    return {
      ok: false, status: 400, code: 'ADDRESS_NOT_ALLOWED',
      message: deviceNetworks.length > 0
        ? `${host} is outside the device networks this server may read (${deviceNetworks.join(', ')}) — Configuration → TCP/IP Reading.`
        : `No device network is configured, so this server may read no address — Configuration → TCP/IP Reading.`,
    };
  }
  return { ok: true };
}

/**
 * May this server read a Modbus device at `host:port`, and is that address free?
 *
 * The ONE place the address rules are decided — instrument create / update,
 * bulk upload and Test connection call this; the Reader, before every read and
 * at every reload, calls rules 1-3 alone (`checkModbusAddressAllowed`, above).
 * It stands on its own and never assumes a zod schema ran in front of it
 * (a stored row, or a value the Reader reloads, has been through none):
 *
 *   1. an IPv4 dotted quad outside the always-refused ranges — the shared
 *      `modbusHostSchema`, the one list of them (0.x, 127.x, 169.254.x incl.
 *      the cloud metadata address, 224.0.0.0 upward);
 *   2. a port 1..65535;
 *   3. inside the administered device networks (Configuration → TCP/IP
 *      Reading), read fresh, so narrowing them applies at the next check;
 *   4. not already another instrument's `host:port` — the partial unique index
 *      `instruments_modbus_address_key` is the authority for a race; this is
 *      the answer with words. The holder's code is named ONLY when the caller
 *      can see it (the bulk upload's out-of-view rule): naming an instrument
 *      outside the caller's scope would confirm it exists.
 *
 * `allowLoopbackForTests` (ledger ruling P-1) admits exactly 127.0.0.1 and skips
 * the device-networks check for it, so a test can read an in-process fake
 * slave. Never derived from the environment: only test code passes it.
 */
export async function checkModbusAddress(
  host: string,
  port: number,
  opts: {
    excludeInstrumentId?: string;
    /** The caller's `resolveVisibility` result; only `where` is read. */
    visibility: Pick<Awaited<ReturnType<typeof resolveVisibility>>, 'where'>;
    allowLoopbackForTests?: boolean;
  },
): Promise<ModbusAddressCheck> {
  const loopbackForTests = opts.allowLoopbackForTests === true && host === TEST_LOOPBACK;
  // Rules 1-3 are checkModbusAddressAllowed's — one definition. The networks
  // are read fresh here (narrowing them applies at the next check).
  const deviceNetworks = loopbackForTests ? [] : (await loadModbusReaderConfig()).deviceNetworks;
  const allowed = checkModbusAddressAllowed(host, port, deviceNetworks, { allowLoopbackForTests: opts.allowLoopbackForTests });
  if (!allowed.ok) return allowed;

  const holder = await prisma.instrument.findFirst({
    where: {
      modbusHost: host,
      modbusPort: port,
      ...(opts.excludeInstrumentId ? { id: { not: opts.excludeInstrumentId } } : {}),
    },
    select: { id: true, code: true },
  });
  if (!holder) return { ok: true };

  const visibleToCaller = !opts.visibility.where || Boolean(await prisma.instrument.findFirst({
    where: withVisibility({ id: holder.id }, opts.visibility.where) as { id: string },
    select: { id: true },
  }));
  return {
    ok: false, status: 409, code: 'ADDRESS_IN_USE',
    message: visibleToCaller
      ? `${host} : ${port} is already used by instrument "${holder.code}".`
      : `${host} : ${port} is already in use.`,
  };
}
