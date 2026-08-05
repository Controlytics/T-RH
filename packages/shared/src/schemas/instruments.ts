import { z } from 'zod';

/**
 * The seven transport values (four protocol families — http/https, mqtt/mqtts,
 * websocket/wss, tcp). Lives in shared, not in the API module, because the
 * create form (web) and the CSV parser (api) must agree on the exact list; a
 * duplicated literal here is how a device gets registered with a transport the
 * listener has never heard of.
 *
 * P1 ships the HTTP/HTTPS listener only. The other five are accepted at
 * registration — an instrument can be catalogued before its listener exists —
 * but nothing will authenticate them until P2/P3 land.
 */
export const TRANSPORTS = ['http', 'https', 'mqtt', 'mqtts', 'websocket', 'wss', 'tcp'] as const;
export type Transport = (typeof TRANSPORTS)[number];

/**
 * `code` is the human reference and doubles as the MQTT topic segment
 * (`instruments/<code>/telemetry`), so it is restricted to characters that need
 * no escaping in a topic, a URL or a CSV cell.
 */
const codeSchema = z.string()
  .min(1, 'Code is required')
  .max(64, 'Maximum 64 characters')
  .regex(/^[A-Za-z0-9._-]+$/, 'Use letters, digits, dot, dash or underscore only');

export const createInstrumentSchema = z.object({
  name: z.string().min(1, 'Name is required').max(120),
  code: codeSchema,
  transport: z.enum(TRANSPORTS),
  isActive: z.boolean().default(true),
  instrumentType: z.string().max(80).optional(),
  manufacturer: z.string().max(120).optional(),
  model: z.string().max(120).optional(),
  serialNumber: z.string().max(120).optional(),
  description: z.string().max(500).optional(),
  // null / omitted = exempt from liveness checks. Capped at a week so a typo
  // can't silently disable the (future) liveness sweep for a decade.
  expectedIntervalSec: z.coerce.number().int().min(1).max(604_800).nullish(),
});

export const updateInstrumentSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  // `code` is deliberately NOT updatable: it is baked into MQTT topics and into
  // whatever the technician configured on the device. Renaming it server-side
  // would silently break an instrument that is already publishing.
  transport: z.enum(TRANSPORTS).optional(),
  isActive: z.boolean().optional(),
  instrumentType: z.string().max(80).nullish(),
  manufacturer: z.string().max(120).nullish(),
  model: z.string().max(120).nullish(),
  serialNumber: z.string().max(120).nullish(),
  description: z.string().max(500).nullish(),
  expectedIntervalSec: z.coerce.number().int().min(1).max(604_800).nullish(),
});

export const instrumentQuerySchema = z.object({
  search: z.string().optional(),
  transport: z.enum(TRANSPORTS).optional(),
  isActive: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(500).default(20),
});

/**
 * Bulk create takes the CSV text itself rather than a multipart file: the web
 * reads the file client-side (it must render a preview anyway) and the API
 * parses one string. 1 MB is ~15k rows — far beyond any real import, and small
 * enough that the parse can't be turned into a DoS.
 */
export const bulkCreateInstrumentsSchema = z.object({
  csv: z.string().min(1, 'CSV content is required').max(1_048_576, 'CSV must be under 1 MB'),
});

export type CreateInstrumentInput = z.infer<typeof createInstrumentSchema>;
export type UpdateInstrumentInput = z.infer<typeof updateInstrumentSchema>;
export type InstrumentQueryInput = z.infer<typeof instrumentQuerySchema>;
export type BulkCreateInstrumentsInput = z.infer<typeof bulkCreateInstrumentsSchema>;
