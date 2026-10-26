import { coerceProfileMeasurements, profileMeasurementsSchema, type ProfileMeasurement } from '@digilog/shared';
import { prisma } from '../lib/prisma.js';
import { invalidateProfileMeasurementsCache } from '../modules/instruments/profile-measurements.js';

/**
 * Change a fixture profile's measurements — what a test used to do by writing
 * the GLOBAL `telemetry-slots` / `alarm-limits` / `sensor-range-alarms` /
 * `sensor-offsets` key lists, before those lists moved onto the profile
 * (2026-10-26). `patch` receives the profile's current list (NULL reads as the
 * defaults) and returns the new one; the result is validated exactly as the
 * route validates, and the resolver cache is dropped so the next read sees it.
 */
export async function setFixtureMeasurements(
  profileId: string,
  patch: (ms: ProfileMeasurement[]) => ProfileMeasurement[],
): Promise<ProfileMeasurement[]> {
  const row = await prisma.instrumentProfile.findUniqueOrThrow({ where: { id: profileId }, select: { measurements: true } });
  const next = profileMeasurementsSchema.parse(patch(coerceProfileMeasurements(row.measurements)));
  await prisma.instrumentProfile.update({ where: { id: profileId }, data: { measurements: next } });
  invalidateProfileMeasurementsCache();
  return next;
}

/**
 * Edit ONE measurement of a fixture profile by code — the common case. A code
 * the profile does not carry is an error, not a silent no-op.
 */
export async function patchFixtureMeasurement(
  profileId: string,
  code: string,
  patch: (m: ProfileMeasurement) => ProfileMeasurement,
): Promise<ProfileMeasurement[]> {
  return setFixtureMeasurements(profileId, (ms) => {
    if (!ms.some((m) => m.code === code)) throw new Error(`fixture profile has no ${code} measurement`);
    return ms.map((m) => (m.code === code ? patch(structuredClone(m)) : m));
  });
}
