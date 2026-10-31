import { z } from 'zod';
import { DEVICE_NETWORKS_DEFAULT, parseDeviceNetworks } from '@digilog/shared';
import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';
import { MODBUS_READER_CONFIG_KEY } from '../../modbus/config.js';

/**
 * Configuration → TCP/IP Reading (2026-10-31, TCP/IP (Modbus) instruments).
 * Spec: docs/superpowers/specs/2026-10-31-tcpip-instruments-design.md §7.1, §13.
 *
 * Two settings, both read through `loadModbusReaderConfig()` (fresh on every
 * call, failing closed):
 *   - **Read devices from this server** — default OFF. While OFF the server
 *     opens NO Modbus connection: no reads, and Test connection says so. A
 *     plant install turns it on once; an AWS install leaves it off, so a cloud
 *     server can never be made to connect into its own network.
 *   - **Device networks** — the CIDRs a TCP/IP instrument's address must lie
 *     in (checked on every create / update, on Test connection and before every
 *     read), default the three private ranges. A plant narrows it to its device
 *     subnets.
 *
 * The dynamic PUT REPLACES the stored row with the body, so the zod schema
 * requires BOTH keys: a body without `deviceNetworks` would erase a narrowed
 * list, and the loader would then read the shipped (wider) default. Every
 * entry must be a valid CIDR — a bad one is refused by name, never stored.
 * SUPER_ADMIN only; each change is a CONFIG_CHANGED audit row.
 */
export const modbusReaderDef: ModuleConfigDefinition = {
  moduleKey: MODBUS_READER_CONFIG_KEY,
  moduleName: 'TCP/IP Reading',
  description: 'Whether this server reads TCP/IP (Modbus) instruments, and the networks their addresses must be in.',
  icon: 'network',
  category: 'system',
  sortOrder: 16,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  requiresReauth: false,
  hasCustomPage: false,
  settings: [
    {
      key: 'serverReadingEnabled',
      type: 'boolean',
      label: 'Read devices from this server',
      description: 'When on, this server connects to each TCP/IP instrument\'s IP address and reads its registers on the profile\'s interval. When off, it opens no Modbus connection at all — no reads, and Test connection says so.',
      default: false,
      group: 'TCP/IP Reading',
    },
    {
      key: 'deviceNetworks',
      type: 'textarea',
      label: 'Device networks',
      description: 'The networks a TCP/IP instrument\'s IP address must be in, one per line or separated by commas (e.g. 192.168.1.0/24). Loopback, link-local and multicast addresses are always refused.',
      default: DEVICE_NETWORKS_DEFAULT,
      group: 'TCP/IP Reading',
    },
  ],
  zodSchema: z.object({
    serverReadingEnabled: z.boolean({ required_error: 'Read devices from this server is required' }),
    deviceNetworks: z.string({ required_error: 'Device networks are required' }).superRefine((text, ctx) => {
      const { cidrs, errors } = parseDeviceNetworks(text);
      for (const message of errors) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
      if (errors.length === 0 && cidrs.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter at least one device network, such as 192.168.1.0/24' });
      }
    }),
  }).strict(),
};
