/**
 * The ONE place the server answers "what does this instrument measure, and
 * which keys carry it" (2026-10-26). Every key mapping that used to be a global
 * config row — device keys, decimals, limit / enable / range / offset keys, MKT —
 * lives on the instrument's PROFILE (`instrument_profiles.measurements`), and
 * every consumer reads it through here. Design:
 * docs/superpowers/specs/2026-10-26-profile-measurements-design.md (D6).
 *
 * It replaced four readers of the global rows that had drifted into duplicates
 * (`telemetry-overview.loadAliases`, `load-offsets.slotAliases`,
 * `room-history.slotAliases`, `decimals.loadDecimalsConfig`).
 *
 * Cached for 10 s (the `load-offsets` precedent): ingest asks on every batch,
 * the dashboard on every poll. Profile and registry WRITES call
 * `invalidateProfileMeasurementsCache`, so an admin's save is visible on the
 * very next read — the 10 s is only a ceiling for writes from another process.
 */
import {
  coerceProfileMeasurements, profileMeasurementsSchema, slotConfigFromMeasurements, DEFAULT_PROFILE_MEASUREMENTS,
  type InstrumentSlotConfig, type MeasurementType, type ProfileMeasurement,
} from '@digilog/shared';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';

const TTL_MS = 10_000;

interface Snapshot {
  measurements: Map<string, ProfileMeasurement[]>;
  slots: Map<string, InstrumentSlotConfig>;
  at: number;
}

let cache: Snapshot | null = null;
const DEFAULT_SLOT = slotConfigFromMeasurements(DEFAULT_PROFILE_MEASUREMENTS);

async function snapshot(): Promise<Snapshot> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache;
  const rows = await prisma.instrumentProfile.findMany({ select: { id: true, name: true, measurements: true } });
  const measurements = new Map<string, ProfileMeasurement[]>();
  const slots = new Map<string, InstrumentSlotConfig>();
  for (const r of rows) {
    // A stored list that fails validation is read as the DEFAULTS (failing
    // toward monitoring) — and said out loud, because that is a silent change of
    // keys for every instrument in the profile. Only a hand edit of the column
    // can produce one: every write path validates.
    if (r.measurements !== null && !profileMeasurementsSchema.safeParse(r.measurements).success) {
      logger.error(`[profile-measurements] profile "${r.name}" (${r.id}) holds an invalid measurements list; reading it as the defaults`);
    }
    const list = coerceProfileMeasurements(r.measurements);
    measurements.set(r.id, list);
    slots.set(r.id, slotConfigFromMeasurements(list));
  }
  cache = { measurements, slots, at: Date.now() };
  return cache;
}

export function invalidateProfileMeasurementsCache(): void {
  cache = null;
}

/** Every profile's measurements, by profile id. */
export async function loadProfileMeasurements(): Promise<Map<string, ProfileMeasurement[]>> {
  return (await snapshot()).measurements;
}

/** One profile's measurements; an unknown id reads as the defaults. */
export async function measurementsForProfile(profileId: string): Promise<ProfileMeasurement[]> {
  return (await snapshot()).measurements.get(profileId) ?? structuredClone(DEFAULT_PROFILE_MEASUREMENTS);
}

/** One profile's key mappings; an unknown id reads as the defaults. */
export async function slotConfigForProfile(profileId: string): Promise<InstrumentSlotConfig> {
  return (await snapshot()).slots.get(profileId) ?? DEFAULT_SLOT;
}

/**
 * A synchronous profile id → key mappings lookup over ONE snapshot, for a caller
 * that already holds each instrument's `profileId` (the fleet overview maps over
 * hundreds of rows; one snapshot means one consistent answer for all of them).
 */
export async function slotConfigLookup(): Promise<(profileId: string) => InstrumentSlotConfig> {
  const snap = await snapshot();
  return (profileId: string) => snap.slots.get(profileId) ?? DEFAULT_SLOT;
}

/**
 * Key mappings for a set of instruments, by instrument id — one query for their
 * profile ids, however many there are. An instrument that does not exist is
 * simply absent from the map.
 */
export async function slotConfigsForInstruments(instrumentIds: string[]): Promise<Map<string, InstrumentSlotConfig>> {
  const out = new Map<string, InstrumentSlotConfig>();
  if (instrumentIds.length === 0) return out;
  const [snap, rows] = await Promise.all([
    snapshot(),
    prisma.instrument.findMany({ where: { id: { in: instrumentIds } }, select: { id: true, profileId: true } }),
  ]);
  for (const r of rows) out.set(r.id, snap.slots.get(r.profileId) ?? DEFAULT_SLOT);
  return out;
}

/**
 * Every offset key ANY profile lists, folded. Used where a key must be judged
 * with no instrument in hand (role screens, a device's attribute report, a
 * downlink): such a key is hidden from non-super-admins and never sent to a
 * device. Wider than per-profile on purpose — failing toward hiding.
 */
export async function allOffsetKeys(): Promise<Set<string>> {
  const snap = await snapshot();
  const keys = new Set<string>();
  for (const slot of snap.slots.values()) {
    for (const k of [...slot.offsetKeys.temperature, ...slot.offsetKeys.humidity]) keys.add(k);
  }
  return keys;
}

/** The measurement-type registry, in display order. */
export async function loadMeasurementTypes(): Promise<MeasurementType[]> {
  const rows = await prisma.measurementType.findMany({ orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] });
  return rows.map((r) => ({ code: r.code, name: r.name, unit: r.unit, sortOrder: r.sortOrder }));
}
