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
 * `code` is the human reference AND, since 2026-09-04, the MQTT client id and
 * the topic segment. ANY NON-EMPTY TEXT, since 2026-09-16.
 *
 * History, because this rule has flipped three times and the reasoning is what
 * keeps the next reader from re-adding a guard by reflex:
 *   - Until 2026-08-07 the code was the topic segment, restricted to
 *     `[A-Za-z0-9._-]` — `/` forges a topic level, `+`/`#` are MQTT wildcards.
 *   - 2026-08-07 → 2026-09-04: the UUID was the client id, so nothing typed
 *     reached a topic.
 *   - 2026-09-04: the operator asked for the client id to BE the code
 *     (`CWH/RDU/001-00`); a guard (`instrumentCodeTopicViolation`) refused
 *     `+`, `#`, NUL and a reserved last segment on every create path.
 *   - 2026-09-16: the operator asked for that guard to go ("remove
 *     instrument id restriction"), choosing "remove the rule entirely" over
 *     keeping it or deriving a safe client id, with the consequence stated:
 *     **an ID containing `+` or `#` cannot publish** (the broker refuses a
 *     wildcard in a publish topic, so such a device fails silently rather than
 *     the form failing visibly); **under the file ACL a `+` client id matches
 *     every instrument's topics**; and an ID whose last segment is
 *     `telemetry`/`attributes`/`children`/`report`/`rtc-request` can have a
 *     child's downlink parsed as a message of that kind. `/` is a topic level
 *     the ACL template reproduces literally; the bridge matches a fixed prefix
 *     and suffix rather than counting levels.
 *
 * Two limits that are NOT this schema's, stated so the field's promise is
 * honest: the bulk-CSV importer still splits on commas and quotes, so a code
 * containing either cannot arrive that way; and a rename (`PUT`) moves the
 * broker slots but cannot reconfigure the device. And ONE uniqueness rule the
 * DATABASE holds (2026-09-16): a code must be unique IGNORING CASE — a
 * functional unique index on lower(code); the routes report it as the same
 * 409 / error row as an exact duplicate.
 */
const codeSchema = z.string().min(1, 'Instrument ID is required');

export const createInstrumentSchema = z.object({
  // No max: `name` is set to the code by the create form, and the code now has
  // no length limit. A cap here would reject an instrument the code schema
  // accepts, which is a rejection nobody could explain from the form.
  name: z.string().min(1, 'Name is required'),
  code: codeSchema,
  // Every instrument belongs to exactly one profile. Required: rows predating
  // profiles were backfilled to "Default" by migration 20260808120000, so there
  // is no unassigned state for any code path to handle.
  profileId: z.string().uuid('A profile must be selected'),
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
  // Moving an instrument to another profile. `.optional()` not `.nullish()`:
  // there is no "no profile" to move to, so null is meaningless here.
  profileId: z.string().uuid().optional(),
  // Changeable since 2026-09-16 (operator). The code is the MQTT client id and
  // every topic segment, so the route — not this schema — clears the retained
  // slots keyed on the old code and republishes under the new one; the device
  // itself has to be reconfigured. Same rule as on create: no wildcard, no
  // reserved last segment.
  code: codeSchema.optional(),
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
  // ANY characters, ANY length (2026-08-07, operator decision). The base64url
  // charset and the TOKEN_PREFIX_LEN+1 floor are both gone.
  //
  // ── The ONE remaining rule, and why it is not policy ──
  // No carriage return or line feed. This is not a preference that can be
  // waived: the token travels as an `Authorization: Bearer` header value, as an
  // MQTT username, and as a field in the newline-delimited TCP protocol. A
  // token containing CR or LF cannot be transmitted over any of the three — the
  // HTTP client rejects it (or, worse, it becomes header injection) and the TCP
  // framing splits mid-credential. Accepting one would mint a credential that
  // authenticates nowhere, which is a worse outcome than refusing it.
  //
  // ── What was given up, stated so nobody rediscovers it the hard way ──
  // `instrument_credentials.token_prefix` is the first TOKEN_PREFIX_LEN
  // characters, treated as NON-SECRET: it is returned by the INSTRUMENT_READ
  // list and detail endpoints. A token of TOKEN_PREFIX_LEN characters or fewer
  // is therefore FULLY DISCLOSED to anyone who can view the instrument — no
  // password, no INSTRUMENT_TOKEN_VIEWED audit row, bypassing all three controls
  // the reveal endpoint rests on. The old floor existed to prevent exactly that.
  // Short tokens are now the operator's call; the UI says so at the point of
  // entry rather than hiding it behind a validation error.
  token: z.string()
    .min(1, 'A token is required')
    .regex(/^[^\r\n]+$/, 'A token cannot contain a line break — it would not survive an HTTP header or the TCP line protocol'),
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
  /**
   * Scope the list to a FUNCTIONAL LOCATION — a Block or an Area.
   *
   * NOT the `block`/`area` params above: those match the SUPERSEDED free-text
   * `Instrument.block` / `.area` columns, which are no longer read for grouping.
   * This one is the authoritative tree, and a Block resolves to ITS OWN
   * instruments plus every Area beneath it, server-side through
   * `resolveLocationIds()` — the expansion a client must never re-derive.
   */
  functionalLocationId: z.string().uuid().optional(),
  // Scopes the list to one profile. Filtered SERVER-side on purpose: doing it
  // in the browser left the pagination footer counting the unfiltered set, so
  // an empty profile announced "Showing 1–10 of 15".
  profileId: z.string().uuid().optional(),
  page: z.coerce.number().min(1).default(1),
  // NO `.max()` (operator, 2026-09-02): every server-side record ceiling was
  // removed. A `.max()` here REJECTS with a 400 rather than clamping, which is
  // louder than the silent `Math.min`s that went — but it still stops a caller
  // asking for the whole set, which is the instruction. The `.min(1)` stays: a
  // negative LIMIT is a Postgres error, not a request for everything.
  // See apps/api/src/lib/page-size.ts for the full reasoning.
  limit: z.coerce.number().min(1).default(20),
});

/**
 * Bulk create takes the CSV text itself rather than a multipart file: the web
 * reads the file client-side (it must render a preview anyway) and the API
 * parses one string. 1 MB is ~15k rows — far beyond any real import, and small
 * enough that the parse can't be turned into a DoS.
 */
export const bulkCreateInstrumentsSchema = z.object({
  csv: z.string().min(1, 'CSV content is required').max(1_048_576, 'CSV must be under 1 MB'),
  // Chosen ONCE for the whole upload, deliberately NOT a CSV column: adding a
  // column would break every template file operators already have on disk, and
  // a per-row profile is not a thing anyone asked for.
  profileId: z.string().uuid('A profile must be selected'),
});

export type CreateInstrumentInput = z.infer<typeof createInstrumentSchema>;
export type UpdateInstrumentInput = z.infer<typeof updateInstrumentSchema>;
export type InstrumentQueryInput = z.infer<typeof instrumentQuerySchema>;
export type BulkCreateInstrumentsInput = z.infer<typeof bulkCreateInstrumentsSchema>;
export type SetInstrumentTokenInput = z.infer<typeof setInstrumentTokenSchema>;
export type SetInstrumentAttributeInput = z.infer<typeof setInstrumentAttributeSchema>;
export type UpdateInstrumentAttributeInput = z.infer<typeof updateInstrumentAttributeSchema>;
