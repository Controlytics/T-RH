import { DEVICE_NETWORKS_DEFAULT, parseDeviceNetworks } from '@digilog/shared';
import { prisma } from '../../lib/prisma.js';

/** The `system_config` key of Configuration → TCP/IP Reading (`modbus-reader.def.ts`). */
export const MODBUS_READER_CONFIG_KEY = 'modbus-reader';

export interface ModbusReaderConfig {
  /** Whether this server opens Modbus connections at all (reads and Test connection). */
  serverReadingEnabled: boolean;
  /** The CIDRs a device address must lie in — only the VALID stored entries. */
  deviceNetworks: string[];
}

/**
 * Configuration → TCP/IP Reading, as every caller must read it: the Reader
 * before each read, Test connection, and the address check on every write.
 *
 * Read FRESH on every call (one row): narrowing the device networks or
 * switching reading off must apply at the next check, not after a cache TTL.
 *
 * Fails CLOSED, both ways:
 *   - `serverReadingEnabled` is ON only when the stored value is exactly
 *     `true` — an absent, half-seeded or hand-edited row is OFF (the
 *     `audit-hard-delete` / inactivity rule). A server that reads devices it was
 *     never told to read is the failure this setting exists to prevent.
 *   - `deviceNetworks`: an absent ROW or an absent KEY is the shipped default
 *     (the three private ranges — what a fresh install has). A stored TEXT keeps
 *     only its valid CIDRs: a bad entry is dropped, never read as "anything",
 *     so it can only NARROW the list. A stored value that is not text at all
 *     (or a row that is not an object) allows nothing.
 */
export async function loadModbusReaderConfig(): Promise<ModbusReaderConfig> {
  const row = await prisma.systemConfig.findUnique({
    where: { configKey: MODBUS_READER_CONFIG_KEY },
    select: { configValue: true },
  });
  const defaults = parseDeviceNetworks(DEVICE_NETWORKS_DEFAULT).cidrs;
  if (!row) return { serverReadingEnabled: false, deviceNetworks: defaults };
  const raw = row.configValue;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { serverReadingEnabled: false, deviceNetworks: [] };
  const value = raw as Record<string, unknown>;
  const serverReadingEnabled = value.serverReadingEnabled === true;
  if (!Object.prototype.hasOwnProperty.call(value, 'deviceNetworks')) return { serverReadingEnabled, deviceNetworks: defaults };
  const stored = value.deviceNetworks;
  return {
    serverReadingEnabled,
    deviceNetworks: typeof stored === 'string' ? parseDeviceNetworks(stored).cidrs : [],
  };
}
