import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { invalidateReauthCache } from '../lib/reauth-check.js';

/**
 * Bug fix (2026-07-08): downloading/generating any report must itself be an
 * auditable event. The exports are client-side, so POST /api/audit/report-export-log
 * is the only place they're captured. This verifies the endpoint writes a
 * REPORT_GENERATED row with the report type, format + record count.
 *
 * 2026-08-24: the plan `2026-08-24-instrument-trend-page.md` Task 2 made
 * `remarks` required and gated the route behind `enforceReauth('DOWNLOAD_REPORT')`
 * — a §11 record must state its reason and, when the role's policy demands it,
 * carry a signature. Covered below alongside the pre-existing tests.
 */
const TEST_USERNAME = 'audit_export_admin';
const TEST_PASSWORD = 'AuditExport@Test1';

async function ensureUser() {
  const { hashPassword } = await import('../lib/password.js');
  const passwordHash = await hashPassword(TEST_PASSWORD);
  await prisma.user.upsert({
    where: { username: TEST_USERNAME },
    update: {
      passwordHash, role: 'SUPER_ADMIN', status: 'ENABLED',
      forcePasswordChange: false, isTemporaryPassword: false,
      failedLoginAttempts: 0, lockedAt: null, lockoutUntil: null,
    },
    create: {
      username: TEST_USERNAME, passwordHash,
      fullName: 'Audit Export Test', email: 'audit-export@test.example',
      role: 'SUPER_ADMIN', status: 'ENABLED',
      forcePasswordChange: false, isTemporaryPassword: false,
    },
  });
}

describe('POST /api/audit/report-export-log', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    await ensureUser();
    token = await loginAs(app, TEST_USERNAME, TEST_PASSWORD);
  });

  afterAll(async () => {
    await app.close();
  });

  it('writes a REPORT_GENERATED audit row with the username, report type, format, count + remarks', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/audit/report-export-log',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        reportType: 'Audit Trail', format: 'Excel', recordCount: 42, period: 'All Time',
        remarks: 'Monthly compliance review',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });

    const row = await prisma.auditTrail.findFirst({
      where: { action: 'REPORT_GENERATED', targetType: 'Audit Trail', userRole: 'SUPER_ADMIN' },
      orderBy: { timestamp: 'desc' },
    });
    expect(row).toBeTruthy();
    // userId must be the human username, NOT the UUID sub (the reported bug).
    expect(row!.userId).toBe(TEST_USERNAME);
    const after = row!.afterValue as Record<string, unknown>;
    expect(after.reportType).toBe('Audit Trail');
    expect(after.format).toBe('Excel');
    expect(after.recordCount).toBe(42);
    // The whole point of the field: the reason must reach the audit row, both
    // in the structured payload and in the human-readable `reason` string.
    expect(after.remarks).toBe('Monthly compliance review');
    expect(row!.reason).toContain('Monthly compliance review');
  });

  it('rejects an unauthenticated request (route is gated, not open)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/audit/report-export-log',
      payload: { reportType: 'Audit Trail', format: 'Excel', recordCount: 1, remarks: 'test' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an invalid format', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/audit/report-export-log',
      headers: { authorization: `Bearer ${token}` },
      payload: { reportType: 'Filters', format: 'CSV', recordCount: 1, remarks: 'test' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a request with no remarks at all, naming the field', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/audit/report-export-log',
      headers: { authorization: `Bearer ${token}` },
      payload: { reportType: 'Audit Trail', format: 'Excel', recordCount: 1 },
    });
    expect(res.statusCode).toBe(400);
    // Since 2026-10-01 `remarks` is no longer schema-required (a PDF type may
    // switch it off), so the route's own check answers — and names the field.
    expect(JSON.stringify(res.json())).toMatch(/remarks/);
  });

  // A whitespace-only string satisfies the schema's `minLength: 1` (a single
  // space has length 1) but states no reason at all — a blank padded with
  // spaces is not a §11 record's reason. The route trims server-side and
  // 400s on the trimmed-empty result, rather than trusting the dialog's own
  // client-side trim (Task 3) as the only line of defence.
  it('rejects whitespace-only remarks', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/audit/report-export-log',
      headers: { authorization: `Bearer ${token}` },
      payload: { reportType: 'Audit Trail', format: 'Excel', recordCount: 1, remarks: '   ' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('VALIDATION_ERROR');
  });

  describe('DOWNLOAD_REPORT reauth gate (Excel — the per-role policy)', () => {
    let originalReauthRow: { configValue: any; configType: string; requiresReauth: boolean } | null = null;

    beforeAll(async () => {
      const existing = await prisma.systemConfig.findUnique({ where: { configKey: 'action-reauth' } });
      if (existing) {
        originalReauthRow = {
          configValue: existing.configValue,
          configType: existing.configType,
          requiresReauth: existing.requiresReauth,
        };
      }
      // Flat shape — see auth-profile-reauth.test.ts's header comment: the
      // seed writes a nested `{ actions: [...] }` shape that `enforceReauth`
      // does not read, so the gate never fires against the seeded row.
      await prisma.systemConfig.upsert({
        where: { configKey: 'action-reauth' },
        update: { configValue: { DOWNLOAD_REPORT: ['SUPER_ADMIN'] } as any, configType: 'security', requiresReauth: false },
        create: { configKey: 'action-reauth', configValue: { DOWNLOAD_REPORT: ['SUPER_ADMIN'] } as any, configType: 'security', requiresReauth: false },
      });
      invalidateReauthCache();
    });

    afterAll(async () => {
      if (originalReauthRow) {
        await prisma.systemConfig.update({ where: { configKey: 'action-reauth' }, data: originalReauthRow });
      } else {
        await prisma.systemConfig.deleteMany({ where: { configKey: 'action-reauth' } });
      }
      invalidateReauthCache();
    });

    beforeEach(() => invalidateReauthCache());

    it('rejects a download with no password when the role policy requires DOWNLOAD_REPORT reauth', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/audit/report-export-log',
        headers: { authorization: `Bearer ${token}` },
        payload: { reportType: 'Audit Trail', format: 'Excel', recordCount: 1, remarks: 'reauth check' },
      });
      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.error).toBe('REAUTH_REQUIRED');
      expect(body.action).toBe('DOWNLOAD_REPORT');
    });

    it('rejects the wrong password', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/audit/report-export-log',
        headers: { authorization: `Bearer ${token}`, 'x-reauth-password': 'DefinitelyWrong@1' },
        payload: { reportType: 'Audit Trail', format: 'Excel', recordCount: 1, remarks: 'reauth check' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('accepts the download once the correct password is supplied', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/audit/report-export-log',
        headers: { authorization: `Bearer ${token}`, 'x-reauth-password': TEST_PASSWORD },
        payload: { reportType: 'Audit Trail', format: 'Excel', recordCount: 1, remarks: 'reauth check' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
    });
  });
  /**
   * A PDF follows its REPORT TYPE's configuration (Configuration → Report
   * Downloads, 2026-10-01): refused when the type is reviewed, and the password
   * and remarks required exactly when the type says so. The row is pinned and
   * restored FIRST in afterAll.
   */
  describe('PDF — per report type (report-downloads)', () => {
    let original: { configValue: any; configType: string; requiresReauth: boolean } | null = null;
    const pin = async (value: Record<string, unknown>) => {
      await prisma.systemConfig.upsert({
        where: { configKey: 'report-downloads' },
        update: { configValue: value as any, configType: 'system', requiresReauth: false },
        create: { configKey: 'report-downloads', configValue: value as any, configType: 'system', requiresReauth: false },
      });
    };
    const post = (payload: Record<string, unknown>, password?: string) => app.inject({
      method: 'POST', url: '/api/audit/report-export-log',
      headers: { authorization: `Bearer ${token}`, ...(password ? { 'x-reauth-password': password } : {}) },
      payload: { reportType: 'Audit Trail', format: 'PDF', recordCount: 3, ...payload },
    });

    beforeAll(async () => {
      const row = await prisma.systemConfig.findUnique({ where: { configKey: 'report-downloads' } });
      if (row) original = { configValue: row.configValue, configType: row.configType, requiresReauth: row.requiresReauth };
      await pin({
        auditTrailMode: 'DIRECT', auditTrailRemarks: false, auditTrailPassword: false,
        dataReportMode: 'DIRECT', dataReportRemarks: true, dataReportPassword: true,
        // alarms left absent = REQUEST
      });
    });

    afterAll(async () => {
      if (original) await prisma.systemConfig.update({ where: { configKey: 'report-downloads' }, data: original });
      else await prisma.systemConfig.deleteMany({ where: { configKey: 'report-downloads' } });
    });

    it('a DIRECT type with remarks and password OFF downloads with neither — and the audit row says so', async () => {
      const res = await post({ reportKind: 'audit-trail' });
      expect(res.statusCode).toBe(200);
      const row = await prisma.auditTrail.findFirst({ where: { action: 'REPORT_GENERATED', userId: TEST_USERNAME }, orderBy: { timestamp: 'desc' } });
      expect((row!.afterValue as any).reportKind).toBe('audit-trail');
      expect((row!.afterValue as any).remarks).toBeNull();
    });

    it('a DIRECT type with password ON asks EVERY role (SUPER_ADMIN included), and accepts the right one', async () => {
      const none = await post({ reportKind: 'data-report', reportType: 'Instrument Time Series', remarks: 'x' });
      expect(none.statusCode).toBe(401);
      expect(none.json().error).toBe('REAUTH_REQUIRED');
      expect((await post({ reportKind: 'data-report', reportType: 'Instrument Time Series', remarks: 'x' }, 'Wrong@Pass1')).statusCode).toBe(401);
      expect((await post({ reportKind: 'data-report', reportType: 'Instrument Time Series', remarks: 'x' }, TEST_PASSWORD)).statusCode).toBe(200);
    });

    it('a DIRECT type with remarks ON refuses blank remarks', async () => {
      const res = await post({ reportKind: 'data-report', reportType: 'Instrument Time Series', remarks: '  ' }, TEST_PASSWORD);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('VALIDATION_ERROR');
    });

    it('a REQUEST type cannot be downloaded directly — this route is not a way round the approval', async () => {
      const res = await post({ reportKind: 'alarms', reportType: 'Alarms', remarks: 'x' }, TEST_PASSWORD);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('REPORT_REQUIRES_APPROVAL');
    });

    it('a reviewed report cannot borrow a Direct kind to get a download record (code review, 2026-10-01)', async () => {
      // audit-trail is Direct here; an Alarm Report labelled with it is refused.
      const res = await post({ reportKind: 'audit-trail', reportType: 'Alarms', remarks: 'x' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('REPORT_TYPE_MISMATCH');
    });

    it('Excel is accepted for the Audit Trail alone — it is not a way round a PDF type\'s review', async () => {
      const res = await post({ format: 'Excel', reportType: 'Alarms', remarks: 'x' }, TEST_PASSWORD);
      expect(res.statusCode).toBe(400);
    });

    it('a refused PDF is refused BEFORE the password — no password is asked for, none is counted', async () => {
      const res = await post({ reportKind: 'alarms', reportType: 'Alarms', remarks: 'x' });
      expect(res.statusCode).toBe(409);
      const blank = await post({ reportKind: 'data-report', reportType: 'Instrument Time Series', remarks: ' ' });
      expect(blank.statusCode).toBe(400);
    });

    it('a PDF with no or an unknown report kind is refused', async () => {
      expect((await post({ remarks: 'x' }, TEST_PASSWORD)).statusCode).toBe(400);
      expect((await post({ reportKind: 'Audit Trail', remarks: 'x' }, TEST_PASSWORD)).statusCode).toBe(400);
    });
  });
});
