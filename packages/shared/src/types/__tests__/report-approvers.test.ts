import { describe, it, expect } from 'vitest';
import { coerceApproverRoles, coerceApproverUserIds, coerceReportApprovers, REPORT_APPROVERS_CONFIG_KEY, REPORT_APPROVERS_NONE_MESSAGE } from '../report-approvers.js';

/**
 * Which roles may approve a report is administered by SUPER_ADMIN
 * (Configuration → Report Approvers, 2026-09-07). `coerceApproverRoles` is the
 * ONE reader of the stored value — the server's request check, the narrow-slice
 * route and the browser's picker all go through it, so a malformed row cannot
 * be read three ways.
 */
describe('coerceApproverRoles', () => {
  it('returns the stored role names, trimmed and de-duplicated', () => {
    expect(coerceApproverRoles({ approverRoles: [' QA ', 'QA', 'QC_HEAD'] })).toEqual(['QA', 'QC_HEAD']);
  });

  it('never returns SUPER_ADMIN — it is not an approving function, and a request "to any super admin" names nobody', () => {
    expect(coerceApproverRoles({ approverRoles: ['SUPER_ADMIN', 'QA'] })).toEqual(['QA']);
  });

  it('reads an absent, malformed or empty row as NO approver role, never as "anyone"', () => {
    expect(coerceApproverRoles(undefined)).toEqual([]);
    expect(coerceApproverRoles(null)).toEqual([]);
    expect(coerceApproverRoles({})).toEqual([]);
    expect(coerceApproverRoles({ approverRoles: 'QA' })).toEqual([]);
    expect(coerceApproverRoles({ approverRoles: [1, '', '  ', null] })).toEqual([]);
  });

  it('names the config key and the message a requester sees when nothing is configured', () => {
    expect(REPORT_APPROVERS_CONFIG_KEY).toBe('report-approvers');
    expect(REPORT_APPROVERS_NONE_MESSAGE).toMatch(/super admin/i);
    expect(REPORT_APPROVERS_NONE_MESSAGE).toMatch(/Report Settings/);
  });
});

describe('coerceApproverUserIds / coerceReportApprovers (2026-10-01)', () => {
  it('returns the stored user ids, trimmed and de-duplicated, and nothing for a malformed row', () => {
    expect(coerceApproverUserIds({ approverUserIds: [' a ', 'a', 'b', 3, ''] })).toEqual(['a', 'b']);
    expect(coerceApproverUserIds({ approverUserIds: 'a' })).toEqual([]);
    expect(coerceApproverUserIds(undefined)).toEqual([]);
  });

  it('reads both halves; an older row with roles only still works', () => {
    expect(coerceReportApprovers({ approverRoles: ['QA'] })).toEqual({ approverRoles: ['QA'], approverUserIds: [] });
    expect(coerceReportApprovers({ approverRoles: ['QA'], approverUserIds: ['u1'] })).toEqual({ approverRoles: ['QA'], approverUserIds: ['u1'] });
  });
});
