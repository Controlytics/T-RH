import { z } from 'zod';
import { profileMeasurementsSchema } from '../types/profile-measurements.js';
import { MODBUS_CONNECTIONS, MODBUS_INTERVAL, MODBUS_UNIT_ID } from '../types/modbus.js';

/**
 * An instrument profile is a named container for instruments.
 *
 * It carries ONE inherited setting: `attributeKeys`, the attribute keys the New
 * Instrument form asks for in this profile. Profiles inherit PROMPTS, never
 * VALUES — nothing is back-filled onto an instrument that already exists, and
 * moving an instrument between profiles changes only which keys are suggested.
 * See `docs/superpowers/specs/2026-08-08-per-profile-instrument-attributes-design.md`.
 *
 * `name` is trimmed before validation because the database's unique index is an
 * exact match. Without trimming, "Cleanroom-A" and "Cleanroom-A " are two
 * distinct profiles that look identical everywhere they are rendered — an
 * operator would have no way to tell which one their instruments went into.
 */

/**
 * Newline-separated, one key per line, capped to match
 * `instrumentAttributesConfigSchema` so a per-profile list cannot hold more than
 * the default template could.
 *
 * NOT trimmed, deliberately: the dynamic-config PUT stores its value verbatim,
 * and a list that round-trips differently depending on which page saved it is a
 * bug waiting to be found months later. Per-line trimming, blank-dropping and
 * case-insensitive de-duplication all happen in `parseInstrumentAttributeKeys`,
 * which is the single definition of what a line means.
 */
const attributeKeysField = z.string()
  .max(2000, 'Attribute keys must be 2000 characters or fewer');


// TCP/IP (Modbus) profile settings (2026-10-31). `connection` absent = PUSH
// ("Gateway", today's behaviour). The two modbus fields exist only on a
// MODBUS_TCP profile and are NULL on a PUSH one.
const connectionField = z.enum(MODBUS_CONNECTIONS);
const modbusIntervalField = z.number({ invalid_type_error: 'Read interval must be a number' })
  .int('Read interval must be a whole number of seconds')
  .min(MODBUS_INTERVAL.min, `Read interval must be at least ${MODBUS_INTERVAL.min} seconds`)
  .max(MODBUS_INTERVAL.max, `Read interval must be at most ${MODBUS_INTERVAL.max} seconds`);
const modbusUnitField = z.number({ invalid_type_error: 'Unit ID must be a number' })
  .int('Unit ID must be a whole number')
  .min(MODBUS_UNIT_ID.min, `Unit ID must be ${MODBUS_UNIT_ID.min} to ${MODBUS_UNIT_ID.max}`)
  .max(MODBUS_UNIT_ID.max, `Unit ID must be ${MODBUS_UNIT_ID.min} to ${MODBUS_UNIT_ID.max}`);

function refuseModbusFieldsOnPush(
  v: { connection?: string; modbusIntervalSec?: number | null; modbusUnitId?: number | null },
  ctx: z.RefinementCtx,
) {
  if (v.connection !== 'PUSH' && v.connection !== undefined) return;
  // On update an absent `connection` means "unchanged", which the route checks
  // against the stored profile; only an explicit PUSH is refused here.
  for (const f of ['modbusIntervalSec', 'modbusUnitId'] as const) {
    if (v[f] !== undefined && v[f] !== null && (v.connection === 'PUSH')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [f], message: 'Only a TCP/IP (Modbus) profile has a read interval and unit ID' });
    }
  }
}

export const createInstrumentProfileSchema = z.object({
  name: z.string().trim()
    .min(1, 'Profile name is required')
    .max(120, 'Profile name must be 120 characters or fewer'),
  description: z.string().trim().max(500, 'Description must be 500 characters or fewer').optional(),
  isActive: z.boolean().default(true),
  // `.optional()` with NO default: an absent field means "seed from the default
  // template", which only the route can do. A `.default('')` here would make
  // every new profile ask for nothing.
  attributeKeys: attributeKeysField.optional(),
  // What the profile's devices measure (2026-10-26). Absent = the shipped
  // temperature + humidity defaults, written by the route. Only a super admin
  // may send anything else (the route enforces it).
  measurements: profileMeasurementsSchema.optional(),
  connection: connectionField.optional(),
  modbusIntervalSec: modbusIntervalField.nullish(),
  modbusUnitId: modbusUnitField.nullish(),
}).superRefine((v, ctx) => {
  // A create without `connection` is a Gateway profile, so the fields are refused there too.
  for (const f of ['modbusIntervalSec', 'modbusUnitId'] as const) {
    if (v.connection !== 'MODBUS_TCP' && v[f] !== undefined && v[f] !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [f], message: 'Only a TCP/IP (Modbus) profile has a read interval and unit ID' });
    }
  }
}).transform((v) => (v.connection === 'MODBUS_TCP'
  ? { ...v, modbusIntervalSec: v.modbusIntervalSec ?? MODBUS_INTERVAL.default, modbusUnitId: v.modbusUnitId ?? MODBUS_UNIT_ID.default }
  : v));

export const updateInstrumentProfileSchema = z.object({
  name: z.string().trim()
    .min(1, 'Profile name is required')
    .max(120, 'Profile name must be 120 characters or fewer')
    .optional(),
  // `.nullish()` rather than `.optional()`: null is meaningful here — it is how
  // an operator clears a description they no longer want.
  description: z.string().trim().max(500, 'Description must be 500 characters or fewer').nullish(),
  isActive: z.boolean().optional(),
  // `.nullish()` for the same reason as description, with a narrower meaning:
  // null re-arms the default-template fallback, '' means "ask for nothing".
  attributeKeys: attributeKeysField.nullish(),
  // The remark recorded on every INSTRUMENT_ATTRIBUTE_REMOVED row when a key
  // dropped from the list is CARRIED by instruments (2026-09-16, operator:
  // "when i removed attributes for profile in configuration those are not
  // removing for instruments"). Required by the route in exactly that case;
  // `validateAttributeRemark` is the shared rule for what counts as one.
  reason: z.string().max(500).optional(),
  // What the profile's devices measure (2026-10-26). A change is super-admin
  // only and needs `reason`; a list EQUIVALENT to the stored one (a page
  // saving other fields sends it back) changes nothing and needs neither.
  measurements: profileMeasurementsSchema.optional(),
  // Device certificates (2026-10-27): every instrument of the profile must
  // connect with its own client certificate. A change is super-admin only,
  // needs `reason`, and ON is refused while the server has no device CA.
  requireDeviceCertificate: z.boolean().optional(),
  connection: connectionField.optional(),
  modbusIntervalSec: modbusIntervalField.nullish(),
  modbusUnitId: modbusUnitField.nullish(),
}).superRefine(refuseModbusFieldsOnPush);

export type CreateInstrumentProfileInput = z.infer<typeof createInstrumentProfileSchema>;
export type UpdateInstrumentProfileInput = z.infer<typeof updateInstrumentProfileSchema>;
