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
 * How many leading characters of a token are stored as the NON-SECRET
 * `instrument_credentials.token_prefix`, used to index-seek a credential at
 * ingest.
 *
 * It lives here, in shared, rather than only in the API's `token.ts`, because
 * two things must agree and they sit on opposite sides of the package boundary:
 * `tokenPrefix()` slices this many characters off, and
 * `setInstrumentTokenSchema` refuses any operator-supplied token short enough
 * for that slice to BE the whole token (see the note on that schema — the
 * prefix is visible to anyone with `INSTRUMENT_READ`). Two independent copies
 * would let the bound drift below the slice and silently reopen that leak, so
 * `token.ts` re-exports this one rather than declaring its own.
 */
export const TOKEN_PREFIX_LEN = 8;

/**
 * `code` is the human reference. ANY characters, ANY length (2026-08-07).
 *
 * It used to be restricted to `[A-Za-z0-9._-]` and 64 characters, because it
 * WAS the MQTT topic segment: `/` forges a topic level, and `+`/`#` are MQTT
 * wildcards, so an instrument coded `+` matched the broker's
 * `instruments/${clientid}/...` ACL against every instrument — read every
 * attribute downlink, publish telemetry attributed to any device. In a §11
 * system that is forged records that read as genuine.
 *
 * The guard is not merely relaxed. The code STOPPED BEING A TOPIC SEGMENT: the
 * wire addresses instruments by their UUID (`mqtt-auth-routes.ts` binds the
 * client id to `instrument.id`, `attributeDownlinkTopic` interpolates ids), and
 * a platform-generated UUID cannot contain a metacharacter. The safety comes
 * from what is in the topic now, not from what a person is allowed to type.
 *
 * Two limits that are NOT this schema's to lift, stated so the field's promise
 * is honest:
 *   - the bulk-CSV importer still splits on commas and quotes, so a code
 *     containing either cannot arrive that way;
 *   - `code` is IMMUTABLE after creation (`updateInstrumentSchema` omits it) —
 *     a typo is fixed by re-registering, not by editing.
 */
const codeSchema = z.string().min(1, 'Instrument ID is required');

export const createInstrumentSchema = z.object({
  // No max: `name` is set to the code by the create form, and the code now has
  // no length limit. A cap here would reject an instrument the code schema
  // accepts, which is a rejection nobody could explain from the form.
  name: z.string().min(1, 'Name is required'),
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
 * ── Length: the 32–128 bounds were REMOVED 2026-08-06 at the operator's request.
 *
 * They existed because `token_hash` is a fast SHA-256 (see `token.ts` for why
 * bcrypt is wrong here), so a short hand-typed token is genuinely
 * brute-forceable where a 256-bit generated one is not. **That reasoning still
 * holds** — it was outweighed by the case this endpoint exists for: a device
 * whose credential is fixed in firmware or on an installer's config sheet, which
 * the platform has to match rather than the other way round. A bound the
 * hardware violates makes the feature unusable, and the operator cannot change
 * the hardware. Nothing about issuance changed: `generateToken()` still mints 43
 * base64url characters, so every token this system chooses for itself is still
 * 256 bits.
 *
 * ── The one bound that remains, and why it is NOT the old security bound
 *
 * `TOKEN_PREFIX_LEN + 1`. This is not a strength requirement; it keeps a
 * DIFFERENT control honest. `instrument_credentials.token_prefix` is the first
 * `TOKEN_PREFIX_LEN` characters of the token, treated as non-secret: it is
 * returned by the `INSTRUMENT_READ`-gated list and detail endpoints and rendered
 * on both instrument pages. At `TOKEN_PREFIX_LEN` characters or fewer the prefix
 * IS the whole token — so a viewer holding only `INSTRUMENT_READ` would read a
 * live credential off the screen, with no password and no
 * `INSTRUMENT_TOKEN_VIEWED` audit row, bypassing all three controls the reveal
 * endpoint is built on. The old 32-char floor was hiding that; removing it
 * without this one would have opened it.
 *
 * Derived from the constant, never written as a literal — if `TOKEN_PREFIX_LEN`
 * ever changes, this bound has to move with it or the leak reopens.
 *
 * Fixing it the other way — deriving `token_prefix` from a hash instead of a
 * slice — is NOT available: `resolveInstrumentByToken` recomputes
 * `tokenPrefix()` on the presented token and seeks on it, so changing the
 * derivation would stop every credential already in the database from matching.
 */
export const setInstrumentTokenSchema = z.object({
  token: z.string()
    .min(
      TOKEN_PREFIX_LEN + 1,
      `Token must be more than ${TOKEN_PREFIX_LEN} characters — the first ${TOKEN_PREFIX_LEN} are shown as a non-secret prefix to anyone who can view this instrument`,
    )
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
