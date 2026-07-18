/**
 * Phase 8.5 — bypass.ts unit tests.
 */
import { describe, expect, it } from 'vitest';
import {
  assertBypassAllowed,
  assertBypassTargetStateValid,
  assertCanBypassTo,
} from '../index.js';
import type { LocalContext, ProfileSlice } from '../index.js';

const ctx = {} as LocalContext;

describe('assertBypassAllowed', () => {
  it('passes when flowMode is BYPASS_ENABLED', () => {
    expect(assertBypassAllowed(ctx, 'BYPASS_ENABLED')).toEqual({ ok: true });
  });
  it('rejects with BYPASS_FORBIDDEN for STRICT or other modes', () => {
    expect(assertBypassAllowed(ctx, 'STRICT')).toMatchObject({
      ok: false,
      code: 'BYPASS_FORBIDDEN',
    });
    expect(assertBypassAllowed(ctx, 'SEQUENTIAL')).toMatchObject({
      ok: false,
      code: 'BYPASS_FORBIDDEN',
    });
    expect(assertBypassAllowed(ctx, null)).toMatchObject({
      ok: false,
      code: 'BYPASS_FORBIDDEN',
    });
  });
});

describe('assertBypassTargetStateValid', () => {
  it('passes when targetState is among valid stages', () => {
    expect(
      assertBypassTargetStateValid(ctx, 'WASH_OUT', ['WASH_IN', 'WASH_OUT', 'DRY_IN']),
    ).toEqual({ ok: true });
  });
  it('rejects with INVALID_TARGET when targetState is not among valid stages', () => {
    expect(
      assertBypassTargetStateValid(ctx, 'NONEXISTENT', ['WASH_IN', 'WASH_OUT']),
    ).toMatchObject({
      ok: false,
      code: 'INVALID_TARGET',
      message: 'Invalid target state: NONEXISTENT. Valid: WASH_IN, WASH_OUT',
    });
  });
  it('filters out null entries from validStates list', () => {
    expect(assertBypassTargetStateValid(ctx, 'WASH_IN', ['WASH_IN', null])).toEqual({
      ok: true,
    });
  });
});

describe('assertCanBypassTo (tape-friendly wrapper)', () => {
  function makeProfile(): ProfileSlice {
    return {
      id: 'p1',
      lineageId: 'l1',
      name: 'P',
      flowMode: 'BYPASS_ENABLED',
      version: 1,
      status: 'ACTIVE',
      cleaningReasons: {},
      nodes: [
        { id: 's1', stateKey: 'WASH_IN', nodeType: 'STAGE', configuration: {}, sortOrder: 1 },
        { id: 's2', stateKey: 'WASH_OUT', nodeType: 'STAGE', configuration: {}, sortOrder: 2 },
      ],
      edges: [],
    };
  }
  function makeCtx(currentLifecycleState: string | null): LocalContext {
    return {
      profile: makeProfile(),
      cycle: {} as never,
      events: [],
      stageLookup: {},
      filter: {
        id: 'f1',
        name: 'F',
        parentId: null,
        filterProfileId: null,
        currentLifecycleState,
        currentCycleId: null,
        filterSet: null,
        block: null,
        area: null,
        ahu: null,
      },
      equipmentGroup: null,
      checklistProfile: null,
      assetTemplate: null,
      user: { id: 'u', role: 'OPERATOR', permissions: [] },
      now: 0,
    };
  }

  it('passes when target stage exists and is not current state', () => {
    expect(assertCanBypassTo(makeCtx('WASH_IN'), 'WASH_OUT')).toEqual({ ok: true });
  });
  it('rejects with INVALID_TARGET when target is current state', () => {
    expect(assertCanBypassTo(makeCtx('WASH_IN'), 'WASH_IN')).toMatchObject({
      ok: false,
      code: 'INVALID_TARGET',
    });
  });
  it('rejects when target not in pipeline', () => {
    expect(assertCanBypassTo(makeCtx('WASH_IN'), 'NONEXISTENT')).toMatchObject({
      ok: false,
      code: 'INVALID_TARGET',
    });
  });
});
