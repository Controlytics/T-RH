import { z } from 'zod';

/**
 * The seven transport values (four protocol families — http/https, mqtt/mqtts,
 * websocket/wss, tcp).
 *
 * This is an enumeration of the protocols the platform speaks, NOT a property
 * of any instrument. An instrument used to store one, chosen at creation; that
 * was reversed because a credential authenticates on any listener
 * (`resolveInstrumentByToken` never checks protocol), so the stored value
 * asserted a constraint nothing enforced. The list survives because the
 * connection-instructions switcher enumerates it to render one example per
 * protocol.
 *
 * P1 ships the HTTP/HTTPS listener only; the switcher marks the other five as
 * having no listener yet.
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
  isActive: z.boolean().default(true),
  instrumentType: z.string().max(80).optional(),
  manufacturer: z.string().max(120).optional(),
  model: z.string().max(120).optional(),
  serialNumber: z.string().max(120).optional(),
  description: z.string().max(500).optional(),
  // null / omitted = exempt from liveness checks. Capped at a week so a typo
  // can't silently disable the (future) liveness sweep for a decade.
  expectedIntervalSec: z.coerce.number().int().min(1).max(604_800).nullish(),
  location: z.string().max(120).nullish(),
  area: z.string().max(120).nullish(),
  block: z.string().max(120).nullish(),
  isGateway: z.boolean().optional(),
  // null is meaningful: it unlinks. `.nullish()` keeps "omitted" and
  // "explicitly cleared" distinguishable in the handler.
  gatewayId: z.string().uuid().nullish(),
});

export const updateInstrumentSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  // `code` is deliberately NOT updatable: it is baked into MQTT topics and into
  // whatever the technician configured on the device. Renaming it server-side
  // would silently break an instrument that is already publishing.
  isActive: z.boolean().optional(),
  instrumentType: z.string().max(80).nullish(),
  manufacturer: z.string().max(120).nullish(),
  model: z.string().max(120).nullish(),
  serialNumber: z.string().max(120).nullish(),
  description: z.string().max(500).nullish(),
  expectedIntervalSec: z.coerce.number().int().min(1).max(604_800).nullish(),
  location: z.string().max(120).nullish(),
  area: z.string().max(120).nullish(),
  block: z.string().max(120).nullish(),
  isGateway: z.boolean().optional(),
  // null is meaningful: it unlinks. `.nullish()` keeps "omitted" and
  // "explicitly cleared" distinguishable in the handler.
  gatewayId: z.string().uuid().nullish(),
});

/**
 * An operator-supplied replacement for a device's access token.
 *
 * The character class is the SAME one `generateToken()` produces (base64url):
 * the value has to survive an `Authorization: Bearer` header, an MQTT username,
 * a CSV cell and a newline-delimited JSON line with no escaping. A space or a
 * colon in a token would authenticate here and fail on the device, which is the
 * worst kind of bug to debug from the field.
 *
 * The 32-char floor is a real security bound, not a formality: a generated token
 * is 256 bits, and a hand-typed one is the weakest credential on the ingest
 * endpoint. `token_hash` is a fast SHA-256 (see `token.ts` for why bcrypt is
 * wrong here), so a short token would be genuinely brute-forceable.
 */
export const setInstrumentTokenSchema = z.object({
  token: z.string()
    .min(32, 'Token must be at least 32 characters')
    .max(128, 'Maximum 128 characters')
    .regex(/^[A-Za-z0-9._-]+$/, 'Use letters, digits, dot, dash or underscore only'),
});

/**
 * One free-form attribute on an instrument.
 *
 * The key is TRIMMED before the length check, so a key of only whitespace is
 * refused rather than stored: such a row is unreachable through the edit and
 * delete endpoints (which take the key as a URL segment) and invisible in a
 * table, so it can only ever accumulate. Trimming also makes `" Room "` and
 * `"Room"` the same attribute, which is what an operator retyping a key expects.
 *
 * The value is NOT length-floored — an empty value is a real state ("we track
 * this, we do not know it yet") and refusing it would push operators into
 * placeholder text like "-" that no report can filter out.
 *
 * Neither field is character-restricted the way `code` and the token are: an
 * attribute is display text, not a topic segment or a credential, and a site
 * that wants "Certificat d'étalonnage" should get it. Markup is stripped by
 * `sanitizeStrings` at the route, as on every other text field in this module.
 */
export const setInstrumentAttributeSchema = z.object({
  key: z.string()
    .transform((s) => s.trim())
    .pipe(
      z.string()
        .min(1, 'Key is required')
        .max(64, 'Maximum 64 characters'),
    ),
  value: z.string().max(1000, 'Maximum 1000 characters'),
});

/** PUT body — the key comes from the URL, so only the value is supplied. */
export const updateInstrumentAttributeSchema = z.object({
  value: z.string().max(1000, 'Maximum 1000 characters'),
});

export const instrumentQuerySchema = z.object({
  search: z.string().optional(),
  isActive: z.enum(['true', 'false']).optional(),
  block: z.string().optional(),
  area: z.string().optional(),
  location: z.string().optional(),
  isGateway: z.enum(['true', 'false']).optional(),
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
export type SetInstrumentTokenInput = z.infer<typeof setInstrumentTokenSchema>;
export type SetInstrumentAttributeInput = z.infer<typeof setInstrumentAttributeSchema>;
export type UpdateInstrumentAttributeInput = z.infer<typeof updateInstrumentAttributeSchema>;
