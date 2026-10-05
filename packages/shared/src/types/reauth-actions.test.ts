import { describe, it, expect } from 'vitest';
import { REAUTH_ACTIONS, REAUTH_ACTION_CATEGORIES } from './reauth-actions.js';

/**
 * Audit 2026-10-03, SEC-7: the instrument registry mutations carried no
 * configurable e-signature while their sibling, the functional-location
 * routes, did — and no action existed, so the gap could not be closed by
 * configuration. These five are that configuration surface.
 */
describe('REAUTH_ACTIONS — instrument registry (SEC-7)', () => {
  it.each([
    'CREATE_INSTRUMENT',
    'UPDATE_INSTRUMENT',
    'DELETE_INSTRUMENT',
    'UPDATE_INSTRUMENT_PROFILE',
    'DELETE_INSTRUMENT_PROFILE',
  ] as const)('%s exists under Configuration, beside the functional-location trio', (key) => {
    expect(REAUTH_ACTIONS[key]).toBeDefined();
    expect(REAUTH_ACTIONS[key].category).toBe('Configuration');
    expect(REAUTH_ACTIONS[key].label.length).toBeGreaterThan(0);
  });

  it('every action names a category the editors iterate — or its policy can never be set', () => {
    const known = new Set<string>(REAUTH_ACTION_CATEGORIES);
    for (const [key, def] of Object.entries(REAUTH_ACTIONS)) {
      expect(known.has(def.category), `${key} → ${def.category}`).toBe(true);
    }
  });

  // The counts root CLAUDE.md states. Re-derive before moving either.
  it('holds 55 actions in 8 categories', () => {
    expect(Object.keys(REAUTH_ACTIONS)).toHaveLength(55);
    expect(REAUTH_ACTION_CATEGORIES).toHaveLength(8);
  });

  // The three token actions are always-on gates (`enforceReauthAlways`) and a
  // toggle for them would do nothing — see the comment in reauth-actions.ts.
  it('still does not list the always-on token gates', () => {
    for (const k of ['REVEAL_INSTRUMENT_TOKEN', 'SET_INSTRUMENT_TOKEN', 'REGENERATE_INSTRUMENT_TOKEN']) {
      expect((REAUTH_ACTIONS as Record<string, unknown>)[k]).toBeUndefined();
    }
  });
});
