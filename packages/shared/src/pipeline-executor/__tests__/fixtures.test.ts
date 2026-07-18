/**
 * Smoke tests for the LocalContext fixtures (Phase 8.5 prep).
 *
 * Each scenario builder must:
 *   1. Return a structurally-valid LocalContext (TS compile + presence checks).
 *   2. Honour partial overrides without losing the rest of the scenario shape.
 *   3. Default values must match the scenario name (e.g. midWash returns
 *      filter.currentLifecycleState='WASH_IN').
 */
import { describe, expect, it } from 'vitest';
import type { LocalContext } from '../index.js';
import {
  FIXTURE_NOW,
  FIXTURE_USER,
  bypassEnabledContext,
  dryInActiveContext,
  dryOutAwaitingReadingsContext,
  emptyCycleContext,
  lockedContext,
  midWashContext,
  pendingChecklistContext,
  terminatedContext,
} from './fixtures.js';

// ── helper: TS-level "is LocalContext" assertion via shape ────────────────

function assertIsLocalContext(ctx: LocalContext): void {
  expect(ctx.profile).toBeDefined();
  expect(ctx.profile.nodes.length).toBeGreaterThanOrEqual(5);
  expect(ctx.profile.edges.length).toBeGreaterThanOrEqual(4);
  expect(ctx.cycle).toBeDefined();
  expect(Array.isArray(ctx.events)).toBe(true);
  expect(ctx.stageLookup).toBeDefined();
  expect(ctx.filter).toBeDefined();
  expect(ctx.user).toBeDefined();
  expect(typeof ctx.now).toBe('number');
}

// ── builders × default + override ────────────────────────────────────────

const builders: Array<[string, (o?: Partial<LocalContext>) => LocalContext]> = [
  ['emptyCycleContext', emptyCycleContext],
  ['midWashContext', midWashContext],
  ['pendingChecklistContext', pendingChecklistContext],
  ['dryInActiveContext', dryInActiveContext],
  ['dryOutAwaitingReadingsContext', dryOutAwaitingReadingsContext],
  ['bypassEnabledContext', bypassEnabledContext],
  ['lockedContext', lockedContext],
  ['terminatedContext', terminatedContext],
];

describe('LocalContext fixtures — structural validity', () => {
  for (const [name, build] of builders) {
    it(`${name}() returns a valid LocalContext`, () => {
      assertIsLocalContext(build());
    });
  }
});

describe('LocalContext fixtures — overrides honoured', () => {
  for (const [name, build] of builders) {
    it(`${name}() respects partial overrides`, () => {
      const override = { now: 12345 } satisfies Partial<LocalContext>;
      const ctx = build(override);
      expect(ctx.now).toBe(12345);
      // Sanity: rest of the context still populated.
      expect(ctx.profile).toBeDefined();
      expect(ctx.filter).toBeDefined();
    });
  }

  it('overrides can replace nested slices wholesale (e.g. equipmentGroup)', () => {
    const ctx = dryOutAwaitingReadingsContext({ equipmentGroup: null });
    expect(ctx.equipmentGroup).toBeNull();
    // The cycle still references the original group id (override is shallow).
    expect(ctx.cycle.equipmentGroupId).toBe('eg-1');
  });
});

describe('LocalContext fixtures — defaults match scenario names', () => {
  it('emptyCycleContext: cycle.status=NONE, no events, no current state', () => {
    const ctx = emptyCycleContext();
    expect(ctx.cycle.status).toBe('NONE');
    expect(ctx.events).toEqual([]);
    expect(ctx.filter.currentLifecycleState).toBeNull();
    expect(ctx.filter.currentCycleId).toBeNull();
  });

  it('midWashContext: cycle in progress at WASH_IN, no checklist gate', () => {
    const ctx = midWashContext();
    expect(ctx.cycle.status).toBe('IN_PROGRESS');
    expect(ctx.filter.currentLifecycleState).toBe('WASH_IN');
    expect(ctx.stageLookup['WASH_IN']?.pendingChecklistProfileIds).toEqual([]);
    expect(ctx.checklistProfile).toBeNull();
  });

  it('pendingChecklistContext: WASH_IN with pending checklist + cached questions', () => {
    const ctx = pendingChecklistContext();
    expect(ctx.cycle.status).toBe('IN_PROGRESS');
    expect(ctx.filter.currentLifecycleState).toBe('WASH_IN');
    expect(ctx.stageLookup['WASH_IN']?.pendingChecklistProfileIds).toContain('cl-prof-1');
    expect(ctx.checklistProfile?.id).toBe('cl-prof-1');
    expect(ctx.checklistProfile?.questions.length).toBeGreaterThan(0);
    // No CHECKLIST_COMPLETED event yet.
    expect(ctx.events.some(e => e.eventType === 'CHECKLIST_COMPLETED')).toBe(false);
    // cycle has the version pin recorded.
    expect(ctx.cycle.checklistVersionPins?.['cl-prof-1']).toBe(2);
  });

  it('dryInActiveContext: DRY_IN with dryer started 30min ago, 60min duration', () => {
    const ctx = dryInActiveContext();
    expect(ctx.filter.currentLifecycleState).toBe('DRY_IN');
    expect(ctx.cycle.dryerDurationMinutes).toBe(60);
    expect(ctx.cycle.dryerStartedAt).not.toBeNull();
    const startedAt = ctx.cycle.dryerStartedAt as Date;
    const elapsedMin = (FIXTURE_NOW - startedAt.getTime()) / 60_000;
    expect(elapsedMin).toBeCloseTo(30);
    expect(ctx.cycle.dryerReadingsSubmitted).toBe(false);
  });

  it('dryOutAwaitingReadingsContext: DRY_OUT with equipment group + dryer done', () => {
    const ctx = dryOutAwaitingReadingsContext();
    expect(ctx.filter.currentLifecycleState).toBe('DRY_OUT');
    expect(ctx.equipmentGroup).not.toBeNull();
    expect(ctx.equipmentGroup?.instruments.length).toBeGreaterThan(0);
    expect(ctx.cycle.equipmentGroupId).toBe(ctx.equipmentGroup?.id);
    expect(ctx.cycle.equipmentGroupVersionPin).toBe(ctx.equipmentGroup?.version);
    expect(ctx.cycle.dryerReadingsSubmitted).toBe(true);
  });

  it('bypassEnabledContext: profile.flowMode=BYPASS_ENABLED', () => {
    const ctx = bypassEnabledContext();
    expect(ctx.profile.flowMode).toBe('BYPASS_ENABLED');
    expect(ctx.cycle.status).toBe('IN_PROGRESS');
  });

  it('lockedContext: profile.flowMode=LOCKED', () => {
    const ctx = lockedContext();
    expect(ctx.profile.flowMode).toBe('LOCKED');
    expect(ctx.cycle.status).toBe('IN_PROGRESS');
  });

  it('terminatedContext: cycle.status=TERMINATED, terminatedAt set, filter unlinked', () => {
    const ctx = terminatedContext();
    expect(ctx.cycle.status).toBe('TERMINATED');
    expect(ctx.cycle.terminatedAt).not.toBeNull();
    expect(ctx.filter.currentLifecycleState).toBeNull();
    expect(ctx.filter.currentCycleId).toBeNull();
    expect(ctx.events.some(e => e.eventType === 'CYCLE_TERMINATED')).toBe(true);
  });
});

describe('LocalContext fixtures — shared constants', () => {
  it('FIXTURE_NOW is a stable epoch ms value', () => {
    expect(FIXTURE_NOW).toBe(new Date('2026-05-02T12:00:00Z').getTime());
  });

  it('FIXTURE_USER is OPERATOR with FILTER_OPERATE permission', () => {
    expect(FIXTURE_USER.role).toBe('OPERATOR');
    expect(FIXTURE_USER.permissions).toContain('FILTER_OPERATE');
  });
});
