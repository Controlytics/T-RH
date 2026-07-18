import { describe, it, expect } from 'vitest';
import { assertPmRole } from '../pm-workflow.js';

/**
 * Step 1 of the segregation-of-duties chain (upload) was decorative until
 * 2026-07-15: `cfg.uploadRole` was read by NO code, while steps 2 and 3
 * (reviewRole, approvalRole) were both asserted. The config def promises "Role
 * allowed to upload PM schedules" and the UI presents it as workflow Step 1.
 *
 * It was LIVE on the replacement path — uploadRole was SUPERVISOR while MANAGER,
 * QA and OPERATOR all held REPLACEMENT_SCHEDULE_UPLOAD.
 */
describe('assertPmRole — uploadRole enforcement', () => {
  it('allows the configured upload role', () => {
    expect(() => assertPmRole('SUPERVISOR', 'SUPERVISOR', 'upload', 'replacement schedules')).not.toThrow();
  });

  it('rejects a role that merely holds the upload PERMISSION', () => {
    // The exact live gap: OPERATOR holds REPLACEMENT_SCHEDULE_UPLOAD but the
    // configured uploader is SUPERVISOR.
    expect(() => assertPmRole('OPERATOR', 'SUPERVISOR', 'upload', 'replacement schedules'))
      .toThrowError(/Only users with role "SUPERVISOR" can upload replacement schedules/);
  });

  it('rejects MANAGER and QA too', () => {
    for (const role of ['MANAGER', 'QA']) {
      expect(() => assertPmRole(role, 'SUPERVISOR', 'upload', 'replacement schedules')).toThrow();
    }
  });

  it('SUPER_ADMIN is exempt', () => {
    expect(() => assertPmRole('SUPER_ADMIN', 'SUPERVISOR', 'upload', 'replacement schedules')).not.toThrow();
  });

  it('an UNSET uploadRole stays permissive — an unconfigured workflow must not lock everyone out', () => {
    expect(() => assertPmRole('OPERATOR', '', 'upload', 'replacement schedules')).not.toThrow();
  });

  it('throws 403 FORBIDDEN_ROLE, not a generic error', () => {
    try {
      assertPmRole('OPERATOR', 'SUPERVISOR', 'upload');
      throw new Error('should have thrown');
    } catch (e: any) {
      expect(e.statusCode).toBe(403);
      expect(e.code).toBe('FORBIDDEN_ROLE');
    }
  });
});
