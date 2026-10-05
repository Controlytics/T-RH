import { describe, it, expect, beforeEach } from 'vitest';
import { shouldFire, releaseCooldown, resetCooldowns } from '../cooldown.js';

describe('cooldown', () => {
  beforeEach(() => resetCooldowns());

  it('always fires when the cooldown is zero', () => {
    expect(shouldFire('RAISED', 'T1', 0, 1000)).toBe(true);
    expect(shouldFire('RAISED', 'T1', 0, 1001)).toBe(true);
  });

  it('suppresses a second RAISED inside the window', () => {
    expect(shouldFire('RAISED', 'T1', 60, 0)).toBe(true);
    expect(shouldFire('RAISED', 'T1', 60, 30_000)).toBe(false);
    expect(shouldFire('RAISED', 'T1', 60, 60_000)).toBe(true);
  });

  it('tracks targets independently', () => {
    expect(shouldFire('RAISED', 'T1', 60, 0)).toBe(true);
    expect(shouldFire('RAISED', 'T2', 60, 0)).toBe(true);
  });

  // The rule the design calls out by name: never rate-limit the off switch.
  it('never suppresses CLEARED or ACKNOWLEDGED', () => {
    expect(shouldFire('RAISED', 'T1', 3600, 0)).toBe(true);
    expect(shouldFire('CLEARED', 'T1', 3600, 1)).toBe(true);
    expect(shouldFire('ACKNOWLEDGED', 'T1', 3600, 2)).toBe(true);
    expect(shouldFire('CLEARED', 'T1', 3600, 3)).toBe(true);
  });

  it('does not let CLEARED reset the RAISED window', () => {
    expect(shouldFire('RAISED', 'T1', 60, 0)).toBe(true);
    expect(shouldFire('CLEARED', 'T1', 60, 10_000)).toBe(true);
    expect(shouldFire('RAISED', 'T1', 60, 20_000)).toBe(false);
  });

  it('never suppresses a TEST fire', () => {
    expect(shouldFire('RAISED', 'T1', 3600, 0)).toBe(true);
    expect(shouldFire('TEST', 'T1', 3600, 1)).toBe(true);
  });

  // Audit 2026-10-03, INGEST-12: a claim for a raise that never reached the
  // device must not suppress the next one.
  describe('releaseCooldown', () => {
    it('a released claim lets the next RAISED inside the window fire', () => {
      expect(shouldFire('RAISED', 'T1', 60, 0)).toBe(true);
      releaseCooldown('T1', 0);
      expect(shouldFire('RAISED', 'T1', 60, 10_000)).toBe(true);
    });

    it('releasing a claim that is not the recorded one changes nothing', () => {
      expect(shouldFire('RAISED', 'T1', 60, 0)).toBe(true);
      // A newer successful raise — a release for the OLD claim must not clear it.
      expect(shouldFire('RAISED', 'T1', 60, 70_000)).toBe(true);
      releaseCooldown('T1', 0);
      expect(shouldFire('RAISED', 'T1', 60, 80_000)).toBe(false);
    });

    it('a release for an unknown target is a no-op', () => {
      expect(() => releaseCooldown('nope', 0)).not.toThrow();
    });
  });
});
