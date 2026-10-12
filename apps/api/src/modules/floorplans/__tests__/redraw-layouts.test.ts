import { describe, it, expect } from 'vitest';
import { duplicateRoomCodes, carriedLimits, describeLimits } from '../redraw.js';
import { QC2_ROOMS } from '../qc-layout-2.js';
import { MICROBIOLOGY_LAYOUT } from '../microbiology-layout.js';
import { QC3_LAYOUT } from '../qc3-layout.js';
import { MODULE_E_LAYOUT } from '../module-e-layout.js';
import { MODULE_F_GROUND_LAYOUT, MODULE_F_FIRST_LAYOUT } from '../module-f-layout.js';

/**
 * The draw scripts now REFUSE a layout that repeats a room code ignoring case
 * (audit 2026-10-12 finding 1: the carry-over by code would put one room's
 * limits on two). Every floor the scripts draw — and that the AWS deploy runs
 * with --apply — must pass that guard, or the deploy step stops on it.
 */
describe('every shipped trace passes the duplicate-code guard', () => {
  const floors: [string, { code: string }[]][] = [
    ['CWH — QC (draw-qc-layout-2)', QC2_ROOMS],
    [MICROBIOLOGY_LAYOUT.planName, MICROBIOLOGY_LAYOUT.rooms],
    [QC3_LAYOUT.planName, QC3_LAYOUT.rooms],
    [MODULE_E_LAYOUT.planName, MODULE_E_LAYOUT.rooms],
    [MODULE_F_GROUND_LAYOUT.planName, MODULE_F_GROUND_LAYOUT.rooms],
    [MODULE_F_FIRST_LAYOUT.planName, MODULE_F_FIRST_LAYOUT.rooms],
  ];
  for (const [name, rooms] of floors) {
    it(name, () => {
      expect(rooms.length).toBeGreaterThan(0);
      expect(duplicateRoomCodes(rooms.map((r) => r.code))).toEqual([]);
    });
  }

  it('the guard itself compares ignoring case', () => {
    expect(duplicateRoomCodes(['CWH-I/017', 'cwh-i/017', 'CWH-I/017 (3.5KL BLENDER)'])).toEqual(['CWH-I/017']);
  });

  it('carriedLimits / describeLimits', () => {
    expect(carriedLimits(undefined)).toEqual({ tempMin: null, tempMax: null, rhMin: null, rhMax: null });
    expect(describeLimits(carriedLimits({ tempMin: 0, rhMax: 65 }))).toBe('T 0..-  RH -..65');
  });
});
