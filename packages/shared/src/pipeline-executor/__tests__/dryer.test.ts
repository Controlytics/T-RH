/**
 * Phase 8.5 — dryer.ts unit tests.
 */
import { describe, expect, it } from 'vitest';
import {
  assertDryerActionValid,
  assertDryerDurationValid,
  assertDryerHalfTimeBeforeLeavingDryIn,
  assertDryerHalfTimeElapsed,
  assertDryerStarted,
  assertInDryInForReadings,
} from '../index.js';
import type { CycleSlice, LocalContext } from '../index.js';

const baseCycle: CycleSlice = {
  id: 'c1',
  cycleCode: 'CC-1',
  filterId: 'f1',
  profileId: 'p1',
  profileVersion: 1,
  status: 'IN_PROGRESS',
  cleaningAreaId: null,
  equipmentGroupId: null,
  equipmentGroupVersionPin: null,
  checklistVersionPins: null,
  dryerStartedAt: null,
  dryerDurationMinutes: null,
  dryerReadingsSubmitted: false,
  cleaningReasonKey: 'ROUTINE',
  cleaningReasonLabel: 'Routine',
  startedAt: new Date(),
  completedAt: null,
  terminatedAt: null,
};

function ctxAt(now: number): LocalContext {
  return {
    profile: { id: 'p1', lineageId: 'l1', name: 'P', flowMode: 'SEQUENTIAL', version: 1, status: 'ACTIVE', cleaningReasons: {}, nodes: [], edges: [] },
    cycle: baseCycle,
    events: [],
    stageLookup: {},
    filter: { id: 'f1', name: 'F', parentId: null, filterProfileId: null, currentLifecycleState: null, currentCycleId: null, filterSet: null, block: null, area: null, ahu: null },
    equipmentGroup: null,
    checklistProfile: null,
    assetTemplate: null,
    user: { id: 'u', role: 'OPERATOR', permissions: [] },
    now,
  };
}

describe('assertDryerActionValid', () => {
  it('passes when no SET_DURATION action', () => {
    expect(assertDryerActionValid(ctxAt(0), null, 'WASH_IN')).toEqual({ ok: true });
    expect(assertDryerActionValid(ctxAt(0), 'SUBMIT_READINGS', 'WASH_IN')).toEqual({ ok: true });
  });
  it('passes when SET_DURATION with target DRY_IN', () => {
    expect(assertDryerActionValid(ctxAt(0), 'SET_DURATION', 'DRY_IN')).toEqual({ ok: true });
  });
  it('rejects with INVALID_DRYER_ACTION when SET_DURATION targets non-DRY_IN', () => {
    expect(assertDryerActionValid(ctxAt(0), 'SET_DURATION', 'WASH_OUT')).toMatchObject({
      ok: false,
      code: 'INVALID_DRYER_ACTION',
      message: 'SET_DURATION only valid for DRY_IN',
    });
  });
});

describe('assertDryerDurationValid', () => {
  it('passes for positive duration', () => {
    expect(assertDryerDurationValid(ctxAt(0), 60)).toEqual({ ok: true });
  });
  it('rejects null / undefined / 0 with INVALID_DURATION', () => {
    expect(assertDryerDurationValid(ctxAt(0), null)).toMatchObject({ ok: false, code: 'INVALID_DURATION' });
    expect(assertDryerDurationValid(ctxAt(0), 0)).toMatchObject({ ok: false, code: 'INVALID_DURATION' });
    expect(assertDryerDurationValid(ctxAt(0), undefined)).toMatchObject({ ok: false, code: 'INVALID_DURATION' });
  });
});

describe('assertInDryInForReadings', () => {
  it('passes when not SUBMIT_READINGS', () => {
    expect(assertInDryInForReadings(ctxAt(0), 'WASH_IN', null)).toEqual({ ok: true });
  });
  it('passes when SUBMIT_READINGS and currentState DRY_IN', () => {
    expect(assertInDryInForReadings(ctxAt(0), 'DRY_IN', 'SUBMIT_READINGS')).toEqual({ ok: true });
  });
  it('rejects with NOT_IN_DRY_IN when current state is not DRY_IN', () => {
    expect(assertInDryInForReadings(ctxAt(0), 'WASH_IN', 'SUBMIT_READINGS')).toMatchObject({
      ok: false,
      code: 'NOT_IN_DRY_IN',
    });
  });
});

describe('assertDryerStarted', () => {
  it('passes when not SUBMIT_READINGS', () => {
    expect(assertDryerStarted(ctxAt(0), baseCycle, null)).toEqual({ ok: true });
  });
  it('passes when dryerStartedAt + duration are set', () => {
    const c = { ...baseCycle, dryerStartedAt: new Date(), dryerDurationMinutes: 60 };
    expect(assertDryerStarted(ctxAt(0), c, 'SUBMIT_READINGS')).toEqual({ ok: true });
  });
  it('rejects with DRYER_NOT_STARTED when dryerStartedAt missing', () => {
    expect(assertDryerStarted(ctxAt(0), baseCycle, 'SUBMIT_READINGS')).toMatchObject({
      ok: false,
      code: 'DRYER_NOT_STARTED',
    });
  });
});

describe('assertDryerHalfTimeElapsed', () => {
  const startedAt = new Date('2026-05-02T10:00:00Z');
  const cycleWithDryer = { ...baseCycle, dryerStartedAt: startedAt, dryerDurationMinutes: 60 };

  it('passes when not SUBMIT_READINGS', () => {
    expect(assertDryerHalfTimeElapsed(ctxAt(0), baseCycle, null)).toEqual({ ok: true });
  });
  it('passes when offlineTime is supplied (offline replay)', () => {
    expect(
      assertDryerHalfTimeElapsed(ctxAt(0), cycleWithDryer, 'SUBMIT_READINGS', new Date()),
    ).toEqual({ ok: true });
  });
  it('passes when half-time has elapsed', () => {
    const now = startedAt.getTime() + 31 * 60_000; // 31 min into 60 min run
    expect(assertDryerHalfTimeElapsed(ctxAt(now), cycleWithDryer, 'SUBMIT_READINGS')).toEqual({
      ok: true,
    });
  });
  it('rejects with DRYER_NOT_READY + remainingMin when too early', () => {
    const now = startedAt.getTime() + 10 * 60_000; // 10 min in, half = 30
    const r = assertDryerHalfTimeElapsed(ctxAt(now), cycleWithDryer, 'SUBMIT_READINGS');
    expect(r).toMatchObject({
      ok: false,
      code: 'DRYER_NOT_READY',
      details: { remainingMin: 20 },
    });
  });
});

describe('assertDryerHalfTimeBeforeLeavingDryIn', () => {
  const startedAt = new Date('2026-05-02T10:00:00Z');
  const cycleWithDryer = { ...baseCycle, dryerStartedAt: startedAt, dryerDurationMinutes: 60 };

  it('passes when current state is not DRY_IN', () => {
    expect(
      assertDryerHalfTimeBeforeLeavingDryIn(ctxAt(0), cycleWithDryer, 'WASH_IN', 'WASH_OUT'),
    ).toEqual({ ok: true });
  });
  it('passes when target is also DRY_IN (in-place)', () => {
    expect(
      assertDryerHalfTimeBeforeLeavingDryIn(ctxAt(0), cycleWithDryer, 'DRY_IN', 'DRY_IN'),
    ).toEqual({ ok: true });
  });
  it('passes when offlineTime is supplied', () => {
    expect(
      assertDryerHalfTimeBeforeLeavingDryIn(
        ctxAt(0),
        cycleWithDryer,
        'DRY_IN',
        'DRY_OUT',
        new Date(),
      ),
    ).toEqual({ ok: true });
  });
  it('passes when half-time elapsed', () => {
    const now = startedAt.getTime() + 31 * 60_000;
    expect(
      assertDryerHalfTimeBeforeLeavingDryIn(ctxAt(now), cycleWithDryer, 'DRY_IN', 'DRY_OUT'),
    ).toEqual({ ok: true });
  });
  it('rejects with DRYER_NOT_READY when leaving DRY_IN too early', () => {
    const now = startedAt.getTime() + 5 * 60_000;
    const r = assertDryerHalfTimeBeforeLeavingDryIn(ctxAt(now), cycleWithDryer, 'DRY_IN', 'DRY_OUT');
    expect(r).toMatchObject({
      ok: false,
      code: 'DRYER_NOT_READY',
      message: expect.stringContaining('before leaving DRY_IN'),
    });
  });
});
