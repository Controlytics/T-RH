/**
 * Phase 8.5 — instruments.ts unit tests.
 */
import { describe, expect, it } from 'vitest';
import {
  assertAllInstrumentReadings,
  assertEquipmentGroupSelected,
  assertEquipmentGroupValid,
  assertEquipmentGroupVersionExists,
  assertInstrumentReadingInRange,
  assertInstrumentReadingRequired,
  assertInstrumentReadingValid,
  assertSingleEquipmentGroupPerBlock,
} from '../index.js';
import type { LocalContext, TapeInstrument } from '../index.js';

const ctx = {} as LocalContext;

const inst: TapeInstrument = {
  id: 'i1',
  description: 'Temp Probe',
  instrumentId: 'TP-01',
  stageKey: 'DRY_IN',
  uom: '°C',
  operatingMin: 50,
  operatingMax: 100,
};

describe('assertEquipmentGroupValid', () => {
  it('passes when groupId is null', () => {
    expect(assertEquipmentGroupValid(ctx, null, null)).toEqual({ ok: true });
  });
  it('passes when group is active', () => {
    expect(assertEquipmentGroupValid(ctx, 'g1', { id: 'g1', isActive: true })).toEqual({ ok: true });
  });
  it('rejects with INVALID_EQUIPMENT_GROUP when group is null', () => {
    expect(assertEquipmentGroupValid(ctx, 'g1', null)).toMatchObject({
      ok: false,
      code: 'INVALID_EQUIPMENT_GROUP',
    });
  });
  it('rejects with INVALID_EQUIPMENT_GROUP when group is inactive', () => {
    expect(assertEquipmentGroupValid(ctx, 'g1', { id: 'g1', isActive: false })).toMatchObject({
      ok: false,
      code: 'INVALID_EQUIPMENT_GROUP',
    });
  });
});

describe('assertInstrumentReadingRequired', () => {
  it('passes when reading present', () => {
    expect(assertInstrumentReadingRequired(ctx, 75, inst)).toEqual({ ok: true });
  });
  it('rejects with READING_REQUIRED when reading is null/undefined', () => {
    expect(assertInstrumentReadingRequired(ctx, null, inst)).toMatchObject({
      ok: false,
      code: 'READING_REQUIRED',
      message: 'Reading required for Temp Probe (TP-01)',
    });
    expect(assertInstrumentReadingRequired(ctx, undefined, inst)).toMatchObject({
      ok: false,
      code: 'READING_REQUIRED',
    });
  });
});

describe('assertInstrumentReadingValid', () => {
  it('passes for numeric readings', () => {
    expect(assertInstrumentReadingValid(ctx, 75, inst)).toEqual({ ok: true });
    expect(assertInstrumentReadingValid(ctx, '75.5', inst)).toEqual({ ok: true });
  });
  it('rejects with INVALID_READING for non-numeric', () => {
    expect(assertInstrumentReadingValid(ctx, 'abc', inst)).toMatchObject({
      ok: false,
      code: 'INVALID_READING',
    });
  });
});

describe('assertInstrumentReadingInRange', () => {
  it('passes within range', () => {
    expect(assertInstrumentReadingInRange(ctx, 75, inst)).toEqual({ ok: true });
    expect(assertInstrumentReadingInRange(ctx, 50, inst)).toEqual({ ok: true });
    expect(assertInstrumentReadingInRange(ctx, 100, inst)).toEqual({ ok: true });
  });
  it('rejects with READING_OUT_OF_RANGE below min', () => {
    expect(assertInstrumentReadingInRange(ctx, 49, inst)).toMatchObject({
      ok: false,
      code: 'READING_OUT_OF_RANGE',
    });
  });
  it('rejects with READING_OUT_OF_RANGE above max', () => {
    expect(assertInstrumentReadingInRange(ctx, 101, inst)).toMatchObject({
      ok: false,
      code: 'READING_OUT_OF_RANGE',
    });
  });
});

describe('assertAllInstrumentReadings (composite)', () => {
  it('passes when all readings valid + in range', () => {
    expect(assertAllInstrumentReadings(ctx, { i1: 75 }, [inst])).toEqual({ ok: true });
  });
  it('first failure short-circuits with the right code', () => {
    expect(assertAllInstrumentReadings(ctx, {}, [inst])).toMatchObject({
      ok: false,
      code: 'READING_REQUIRED',
    });
    expect(assertAllInstrumentReadings(ctx, { i1: 'abc' }, [inst])).toMatchObject({
      ok: false,
      code: 'INVALID_READING',
    });
    expect(assertAllInstrumentReadings(ctx, { i1: 200 }, [inst])).toMatchObject({
      ok: false,
      code: 'READING_OUT_OF_RANGE',
    });
  });
});

describe('assertSingleEquipmentGroupPerBlock', () => {
  it('passes when 0 or 1 group', () => {
    expect(assertSingleEquipmentGroupPerBlock(ctx, 0)).toEqual({ ok: true });
    expect(assertSingleEquipmentGroupPerBlock(ctx, 1)).toEqual({ ok: true });
  });
  it('rejects with MULTIPLE_EQUIPMENT_GROUPS when count > 1', () => {
    expect(assertSingleEquipmentGroupPerBlock(ctx, 2)).toMatchObject({
      ok: false,
      code: 'MULTIPLE_EQUIPMENT_GROUPS',
    });
  });
});

describe('assertEquipmentGroupSelected', () => {
  it('passes when groupId set', () => {
    expect(assertEquipmentGroupSelected(ctx, 'g1')).toEqual({ ok: true });
  });
  it('rejects with NO_EQUIPMENT_GROUP when null', () => {
    expect(assertEquipmentGroupSelected(ctx, null)).toMatchObject({
      ok: false,
      code: 'NO_EQUIPMENT_GROUP',
    });
  });
});

describe('assertEquipmentGroupVersionExists', () => {
  it('passes when no pin', () => {
    expect(assertEquipmentGroupVersionExists(ctx, null, 1, false)).toEqual({ ok: true });
  });
  it('passes when snapshot exists', () => {
    expect(assertEquipmentGroupVersionExists(ctx, 5, 7, true)).toEqual({ ok: true });
  });
  it('passes when liveVersion equals pin (lazy first-version case)', () => {
    expect(assertEquipmentGroupVersionExists(ctx, 1, 1, false)).toEqual({ ok: true });
  });
  it('rejects with GROUP_VERSION_MISSING when pin and live diverge with no snapshot', () => {
    expect(assertEquipmentGroupVersionExists(ctx, 3, 5, false)).toMatchObject({
      ok: false,
      code: 'GROUP_VERSION_MISSING',
    });
  });
  it('rejects with GROUP_VERSION_MISSING when liveVersion is null', () => {
    expect(assertEquipmentGroupVersionExists(ctx, 3, null, false)).toMatchObject({
      ok: false,
      code: 'GROUP_VERSION_MISSING',
    });
  });
});
