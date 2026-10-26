/**
 * The ONE per-profile measurement resolver, against the real test database.
 *
 * What it must guarantee: an instrument's key mappings come from ITS profile;
 * a never-customised profile (NULL) reads as the shipped defaults; and a write
 * is visible on the next read without waiting out the 10 s cache, because the
 * dashboard polls every few seconds right after an admin saves.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DEFAULT_PROFILE_MEASUREMENTS, slotConfigFromMeasurements } from '@digilog/shared';
import { prisma } from '../../../lib/prisma.js';
import {
  slotConfigForProfile, slotConfigsForInstruments, allOffsetKeys, loadMeasurementTypes,
} from '../profile-measurements.js';
import { setFixtureMeasurements } from '../../../test-support/fixture-measurements.js';

const STAMP = Date.now();
let profileId = '';
let instrumentId = '';

beforeAll(async () => {
  const p = await prisma.instrumentProfile.create({ data: { name: `PM-Resolver-${STAMP}` } });
  profileId = p.id;
  const i = await prisma.instrument.create({
    data: { code: `PM-RES-${STAMP}`, name: 'resolver fixture', profileId },
  });
  instrumentId = i.id;
});

afterAll(async () => {
  await prisma.instrument.deleteMany({ where: { id: instrumentId } });
  await prisma.instrumentProfile.deleteMany({ where: { id: profileId } });
});

describe('profile measurement resolver', () => {
  it('reads a never-customised profile (NULL) as the shipped defaults', async () => {
    expect(await slotConfigForProfile(profileId)).toEqual(slotConfigFromMeasurements(DEFAULT_PROFILE_MEASUREMENTS));
  });

  it('sees a write at once — no 10 s wait', async () => {
    await slotConfigsForInstruments([instrumentId]); // warm the cache
    await setFixtureMeasurements(profileId, (ms) => ms.filter((m) => m.code !== 'HUMIDITY'));
    const cfg = (await slotConfigsForInstruments([instrumentId])).get(instrumentId)!;
    expect(cfg.measured.humidity).toBe(false);
    expect(cfg.measured.temperature).toBe(true);
  });

  it('names every offset key any profile lists, folded', async () => {
    await setFixtureMeasurements(profileId, (ms) => ms.map((m) => (m.code === 'TEMPERATURE' ? { ...m, offsetKeys: ['Cal T PM'] } : m)));
    const keys = await allOffsetKeys();
    expect(keys.has('cal t pm')).toBe(true);
  });

  it('lists the registry in sort order', async () => {
    const types = await loadMeasurementTypes();
    expect(types.slice(0, 2).map((t) => [t.code, t.unit])).toEqual([['TEMPERATURE', '°C'], ['HUMIDITY', '%RH']]);
  });
});
