/**
 * Instrument + equipment-group guards (Phase 8.5).
 *
 * Pure portions of advance() in
 * `apps/api/src/modules/filter-operations/filter-operations.service.ts`
 * (lines 1287-1424). Instrument-reading + equipment-group validation.
 *
 * Hybrid guards (#30 single-group-per-block, #32 version-pin-exists) keep
 * their pure shape here; the server's wrapper does a live DB re-check after
 * the transaction loads truth. See inventory § "Hybrid Guards' Server-Side
 * Delta".
 */
import type { GuardResult, LocalContext, TapeInstrument } from './types.js';

/** Guard #20: equipment group must be active when provided. */
export function assertEquipmentGroupValid(
  _ctx: LocalContext,
  groupId: string | null | undefined,
  group: { id: string; isActive: boolean } | null | undefined,
): GuardResult {
  if (!groupId) return { ok: true };
  if (!group || !group.isActive) {
    return {
      ok: false,
      code: 'INVALID_EQUIPMENT_GROUP',
      message: 'Equipment group not found or inactive',
    };
  }
  return { ok: true };
}

/** Guard #27: instrument reading required (per instrument). */
export function assertInstrumentReadingRequired(
  _ctx: LocalContext,
  reading: unknown,
  instrument: { description?: string; instrumentId?: string },
): GuardResult {
  if (reading === undefined || reading === null) {
    return {
      ok: false,
      code: 'READING_REQUIRED',
      message: `Reading required for ${instrument.description ?? '(unknown)'} (${instrument.instrumentId ?? '?'})`,
    };
  }
  return { ok: true };
}

/** Guard #28: instrument reading numeric. */
export function assertInstrumentReadingValid(
  _ctx: LocalContext,
  reading: unknown,
  instrument: { description?: string },
): GuardResult {
  const val = Number(reading);
  if (isNaN(val)) {
    return {
      ok: false,
      code: 'INVALID_READING',
      message: `Invalid reading value for ${instrument.description ?? '(unknown)'}`,
    };
  }
  return { ok: true };
}

/** Guard #29: instrument reading inside operating range. */
export function assertInstrumentReadingInRange(
  _ctx: LocalContext,
  reading: number,
  instrument: { description?: string; operatingMin: number; operatingMax: number },
): GuardResult {
  if (reading < instrument.operatingMin || reading > instrument.operatingMax) {
    return {
      ok: false,
      code: 'READING_OUT_OF_RANGE',
      message: `${instrument.description ?? '(unknown)'} reading ${reading} is outside operating range (${instrument.operatingMin}–${instrument.operatingMax})`,
    };
  }
  return { ok: true };
}

/**
 * Composite guard wrapping #27 + #28 + #29 over the full set of instruments
 * for a stage. Throws on the first failure preserving the original error
 * code so server-side parity with advance():1404-1424 is exact.
 */
export function assertAllInstrumentReadings(
  ctx: LocalContext,
  readings: Record<string, unknown>,
  stageInstruments: TapeInstrument[],
): GuardResult {
  for (const inst of stageInstruments) {
    const r = readings[inst.id];
    const required = assertInstrumentReadingRequired(ctx, r, inst);
    if (!required.ok) return required;
    const valid = assertInstrumentReadingValid(ctx, r, inst);
    if (!valid.ok) return valid;
    const val = Number(r);
    const inRange = assertInstrumentReadingInRange(ctx, val, inst);
    if (!inRange.ok) return inRange;
  }
  return { ok: true };
}

/**
 * Guard #30 (hybrid): auto-resolve equipment group when block has multiple.
 *
 * Pure portion: `groupCount <= 1`. Server's wrapper does the live DB lookup
 * (`equipmentGroup.findMany({ blockId, isActive: true })`) and passes the
 * count here.
 */
export function assertSingleEquipmentGroupPerBlock(
  _ctx: LocalContext,
  blockGroupCount: number,
): GuardResult {
  if (blockGroupCount > 1) {
    return {
      ok: false,
      code: 'MULTIPLE_EQUIPMENT_GROUPS',
      message: 'Multiple equipment groups found for this block. Please select one.',
    };
  }
  return { ok: true };
}

/** Guard #31: equipment group must be selected before submitting readings. */
export function assertEquipmentGroupSelected(
  _ctx: LocalContext,
  cycleGroupId: string | null | undefined,
): GuardResult {
  if (!cycleGroupId) {
    return {
      ok: false,
      code: 'NO_EQUIPMENT_GROUP',
      message: 'Equipment group must be selected before submitting readings',
    };
  }
  return { ok: true };
}

/**
 * Guard #32 (hybrid): equipment group version pin must exist (or live row
 * version must equal the pin when the snapshot row is missing).
 *
 * Pure portion: given pin + live version + snapshotExists, validate. Server
 * provides the inputs from prisma in its wrapper.
 *
 * Mirrors advance() lines 1376-1387.
 */
export function assertEquipmentGroupVersionExists(
  _ctx: LocalContext,
  cyclePin: number | null | undefined,
  liveGroupVersion: number | null | undefined,
  snapshotExists: boolean,
): GuardResult {
  if (cyclePin === null || cyclePin === undefined) return { ok: true };
  if (snapshotExists) return { ok: true };
  if (liveGroupVersion === null || liveGroupVersion === undefined) {
    return {
      ok: false,
      code: 'GROUP_VERSION_MISSING',
      message: `Equipment group version ${cyclePin} pinned by this cycle is missing.`,
    };
  }
  if (liveGroupVersion === cyclePin) return { ok: true };
  return {
    ok: false,
    code: 'GROUP_VERSION_MISSING',
    message: `Equipment group version ${cyclePin} pinned by this cycle is missing from the version sidecar; live group is at v${liveGroupVersion}. Investigate before submitting readings.`,
  };
}
