/**
 * PROFILE MEASUREMENTS (2026-10-26) — each instrument profile says what its
 * devices measure and which keys carry each measurement.
 *
 * Operator: "temperature and humidity keys assining or limits keys assigning
 * configurations are there right those should be updated instrument profiles
 * wise, each profile can receive different keys", then "pressue or other
 * differnet sensors values", then "in instrument profiles NLT and MNT
 * attributes and MKT attributes are should be enabled or disabled should come".
 * Design: docs/superpowers/specs/2026-10-26-profile-measurements-design.md.
 *
 * Until now every instrument was read through ONE global set of key lists
 * (`telemetry-slots`, `alarm-limits`, `sensor-range-alarms`, `sensor-offsets`).
 * Those lists now live on the profile, one entry per measurement. This file is
 * the ONE definition of an entry, of the defaults, and of how an entry list
 * becomes the per-instrument `InstrumentSlotConfig` every server consumer reads.
 *
 * Phase 1 (this shape, two slots): the consumers still think in the two slots
 * `temperature` / `humidity`, so `slotConfigFromMeasurements` maps the TEMPERATURE
 * and HUMIDITY entries onto exactly the shapes the global loaders used to return.
 */
import { z } from 'zod';
import {
  parseTelemetryAliases, TELEMETRY_SLOT_ALIASES_DEFAULT, type TelemetrySlot,
} from './telemetry-slots.js';
import {
  parseLimitKeys, ALARM_LIMIT_KEYS_DEFAULT, ALARM_LIMIT_ENABLE_KEYS_DEFAULT, type LimitBound,
} from './alarm-limits.js';
import { SENSOR_RANGE_KEYS_DEFAULT, type RangeBound } from './sensor-range.js';
import { SENSOR_OFFSET_KEYS_DEFAULT } from './sensor-offsets.js';
import {
  TELEMETRY_DECIMALS_KEYS_DEFAULT, TELEMETRY_DECIMALS_FALLBACK, TELEMETRY_DECIMALS_MAX,
} from './telemetry-decimals.js';
import { MKT_ATTRIBUTE_KEY } from './mkt.js';

/** The measurements phase 1 lets a profile carry — the two the app understands. */
export const MEASUREMENT_CODES_PHASE1 = ['TEMPERATURE', 'HUMIDITY'] as const;

/** A measurement type's code: stored verbatim in `alarms.metric`, so immutable. */
export const MEASUREMENT_CODE_RE = /^[A-Z][A-Z0-9_]{1,31}$/;

/** Stored in `alarms.metric` for an inactivity alarm — never a measurement. */
export const RESERVED_MEASUREMENT_CODE = 'OFFLINE';

/** One row of the `measurement_types` registry. */
export interface MeasurementType {
  code: string;
  name: string;
  unit: string;
  sortOrder: number;
}

const SLOT_CODE: Record<TelemetrySlot, string> = { temperature: 'TEMPERATURE', humidity: 'HUMIDITY' };

const LIST_MAX = 20;
const KEY_MAX = 64;
const keyList = z.array(z.string().trim().min(1, 'A key cannot be blank').max(KEY_MAX, `A key must be ${KEY_MAX} characters or fewer`))
  .max(LIST_MAX, `At most ${LIST_MAX} keys per list`);

const boundSchema = z.object({
  enabled: z.boolean(),
  limitKeys: keyList,
  enableKeys: keyList,
});

export const profileMeasurementSchema = z.object({
  code: z.string()
    .regex(MEASUREMENT_CODE_RE, 'A measurement code is upper-case letters, digits and _')
    .refine((c) => c !== RESERVED_MEASUREMENT_CODE, `${RESERVED_MEASUREMENT_CODE} is reserved for inactivity alarms`),
  deviceKeys: keyList,
  decimals: z.object({
    attributeKeys: keyList,
    fallback: z.number().int().min(0).max(TELEMETRY_DECIMALS_MAX),
  }),
  high: boundSchema,
  low: boundSchema,
  range: z.object({ highKeys: keyList, lowKeys: keyList }),
  offsetKeys: keyList,
  mkt: z.object({ enabled: z.boolean(), attributeKeys: keyList }),
});

export type ProfileMeasurement = z.infer<typeof profileMeasurementSchema>;

const fold = (k: string) => k.trim().toLowerCase();

/** Every attribute key an entry names, with the role it plays. */
function attributeRoles(m: ProfileMeasurement): { key: string; role: string }[] {
  const tag = (keys: string[], role: string) => keys.map((key) => ({ key, role: `${m.code} ${role}` }));
  return [
    ...tag(m.decimals.attributeKeys, 'decimals'),
    ...tag(m.high.limitKeys, 'high limit'),
    ...tag(m.high.enableKeys, 'high limit enable'),
    ...tag(m.low.limitKeys, 'low limit'),
    ...tag(m.low.enableKeys, 'low limit enable'),
    ...tag(m.range.highKeys, 'high range'),
    ...tag(m.range.lowKeys, 'low range'),
    ...tag(m.offsetKeys, 'offset'),
    ...tag(m.mkt.attributeKeys, 'MKT'),
  ];
}

/**
 * A profile's whole list. Cross-entry rules: a measurement once; a device key
 * belongs to one measurement (otherwise one reading would be two things); an
 * attribute key plays one role (a limit of one measurement cannot be the offset
 * of another — the value would be judged and added at once).
 */
export const profileMeasurementsSchema = z.array(profileMeasurementSchema).superRefine((ms, ctx) => {
  const codes = new Set<string>();
  const deviceKeys = new Map<string, string>();
  const roles = new Map<string, string>();
  ms.forEach((m, i) => {
    if (codes.has(m.code)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'code'], message: `${m.code} is listed more than once` });
    }
    codes.add(m.code);
    for (const k of m.deviceKeys) {
      const f = fold(k);
      const owner = deviceKeys.get(f);
      if (owner && owner !== m.code) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'deviceKeys'], message: `Device key "${k}" is used by both ${owner} and ${m.code}` });
      }
      deviceKeys.set(f, m.code);
    }
    for (const { key, role } of attributeRoles(m)) {
      const f = fold(key);
      const other = roles.get(f);
      if (other && other !== role) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i], message: `Attribute "${key}" cannot be both ${other} and ${role}` });
      }
      roles.set(f, role);
    }
  });
});

const lines = (raw: string) => raw.split('\n').map((s) => s.trim()).filter(Boolean);

/**
 * What a profile measures when nobody has said otherwise: temperature and
 * humidity read through the shipped default key lists — today's behaviour for
 * an install that never edited them. Humidity adds `h`, which this plant's
 * devices send and the old shipped default lacked (a new profile must not show
 * NA humidity on a device that has always worked).
 */
export const DEFAULT_PROFILE_MEASUREMENTS: ProfileMeasurement[] = (['temperature', 'humidity'] as const).map((slot) => {
  const hi = `${slot}High` as LimitBound;
  const lo = `${slot}Low` as LimitBound;
  const deviceKeys = lines(TELEMETRY_SLOT_ALIASES_DEFAULT[slot]);
  return {
    code: SLOT_CODE[slot],
    deviceKeys: slot === 'humidity' && !deviceKeys.includes('h') ? [...deviceKeys, 'h'] : deviceKeys,
    decimals: { attributeKeys: lines(TELEMETRY_DECIMALS_KEYS_DEFAULT[slot]), fallback: TELEMETRY_DECIMALS_FALLBACK },
    high: { enabled: true, limitKeys: lines(ALARM_LIMIT_KEYS_DEFAULT[hi]), enableKeys: lines(ALARM_LIMIT_ENABLE_KEYS_DEFAULT[hi]) },
    low: { enabled: true, limitKeys: lines(ALARM_LIMIT_KEYS_DEFAULT[lo]), enableKeys: lines(ALARM_LIMIT_ENABLE_KEYS_DEFAULT[lo]) },
    range: { highKeys: lines(SENSOR_RANGE_KEYS_DEFAULT[hi as RangeBound]), lowKeys: lines(SENSOR_RANGE_KEYS_DEFAULT[lo as RangeBound]) },
    offsetKeys: lines(SENSOR_OFFSET_KEYS_DEFAULT[slot]),
    mkt: slot === 'temperature'
      ? { enabled: true, attributeKeys: [MKT_ATTRIBUTE_KEY] }
      : { enabled: false, attributeKeys: [] },
  };
});

/**
 * The stored column → a list. Three states, the `attributeKeys` precedent:
 * a valid list is the profile's own; `[]` is "measures nothing"; NULL ("never
 * customised") and anything unreadable are the DEFAULTS — failing toward
 * monitoring, never toward an instrument that silently measures nothing.
 */
export function coerceProfileMeasurements(raw: unknown): ProfileMeasurement[] {
  if (raw === null || raw === undefined) return structuredClone(DEFAULT_PROFILE_MEASUREMENTS);
  const parsed = profileMeasurementsSchema.safeParse(raw);
  return parsed.success ? parsed.data : structuredClone(DEFAULT_PROFILE_MEASUREMENTS);
}

/**
 * One instrument's key mappings in the shapes the server consumers already
 * read: the old global loaders returned these per SITE, this returns them per
 * PROFILE. Lists lower-cased and de-duplicated in order (precedence).
 */
export interface InstrumentSlotConfig {
  measured: Record<TelemetrySlot, boolean>;
  aliases: Record<TelemetrySlot, string[]>;
  decimals: {
    keys: Record<TelemetrySlot, string[]>;
    fallback: Record<TelemetrySlot, number>;
    /**
     * Attribute keys shown at this slot's precision — a limit or range bounds a
     * reading, so "27 breached > 25.0" would read as a bug. DERIVED from the
     * measurement's own limit and range keys (never guessed from the words in a
     * key: operator-typed keys drift, and a word rule would claim any future key
     * containing "temp"). Display only — it changes nothing stored or alarmed.
     * Replaced the global `temperatureValuedKeys` / `humidityValuedKeys` lists
     * (2026-10-26).
     */
    valuedKeys: Record<TelemetrySlot, string[]>;
  };
  limitKeys: Record<LimitBound, string[]>;
  enableKeys: Record<LimitBound, string[]>;
  /** The profile's NMT / NLT switch per bound. Off = never enforced. */
  boundSwitch: Record<LimitBound, boolean>;
  rangeKeys: Record<RangeBound, string[]>;
  offsetKeys: Record<TelemetrySlot, string[]>;
  mkt: Record<TelemetrySlot, { enabled: boolean; attributeKeys: string[] }>;
}

const lower = (keys: string[]) => parseLimitKeys(keys.join('\n'));

export function slotConfigFromMeasurements(ms: ProfileMeasurement[]): InstrumentSlotConfig {
  const entry = (slot: TelemetrySlot) => ms.find((m) => m.code === SLOT_CODE[slot]) ?? null;
  const t = entry('temperature');
  const h = entry('humidity');
  const per = <V>(fn: (m: ProfileMeasurement | null) => V): Record<TelemetrySlot, V> => ({ temperature: fn(t), humidity: fn(h) });
  const bound = <V>(fn: (m: ProfileMeasurement | null, side: 'high' | 'low') => V): Record<LimitBound, V> => ({
    temperatureHigh: fn(t, 'high'), temperatureLow: fn(t, 'low'),
    humidityHigh: fn(h, 'high'), humidityLow: fn(h, 'low'),
  });
  return {
    measured: per((m) => m !== null),
    aliases: per((m) => (m ? parseTelemetryAliases(m.deviceKeys.join('\n')) : [])),
    decimals: {
      keys: per((m) => (m ? lower(m.decimals.attributeKeys) : [])),
      fallback: per((m) => m?.decimals.fallback ?? TELEMETRY_DECIMALS_FALLBACK),
      valuedKeys: per((m) => (m
        ? lower([...m.high.limitKeys, ...m.low.limitKeys, ...m.range.highKeys, ...m.range.lowKeys])
        : [])),
    },
    limitKeys: bound((m, side) => (m ? lower(m[side].limitKeys) : [])),
    enableKeys: bound((m, side) => (m ? lower(m[side].enableKeys) : [])),
    boundSwitch: bound((m, side) => m?.[side].enabled ?? false),
    rangeKeys: bound((m, side) => (m ? lower(side === 'high' ? m.range.highKeys : m.range.lowKeys) : [])),
    offsetKeys: per((m) => (m ? lower(m.offsetKeys) : [])),
    mkt: per((m) => (m ? { enabled: m.mkt.enabled, attributeKeys: lower(m.mkt.attributeKeys) } : { enabled: false, attributeKeys: [] })),
  };
}

/** Case-folded canonical form — what two lists must agree on to monitor alike. */
function canonical(ms: ProfileMeasurement[]): string {
  const f = (keys: string[]) => keys.map(fold);
  return JSON.stringify(ms.map((m) => ({
    code: m.code,
    deviceKeys: f(m.deviceKeys),
    decimals: { attributeKeys: f(m.decimals.attributeKeys), fallback: m.decimals.fallback },
    high: { enabled: m.high.enabled, limitKeys: f(m.high.limitKeys), enableKeys: f(m.high.enableKeys) },
    low: { enabled: m.low.enabled, limitKeys: f(m.low.limitKeys), enableKeys: f(m.low.enableKeys) },
    range: { highKeys: f(m.range.highKeys), lowKeys: f(m.range.lowKeys) },
    offsetKeys: f(m.offsetKeys),
    mkt: { enabled: m.mkt.enabled, attributeKeys: f(m.mkt.attributeKeys) },
  })));
}

/**
 * Do two lists monitor an instrument identically? Key case is ignored (every
 * resolver folds it); order is NOT — it is display order and key precedence.
 */
export function measurementsEquivalent(a: ProfileMeasurement[], b: ProfileMeasurement[]): boolean {
  return canonical(a) === canonical(b);
}
