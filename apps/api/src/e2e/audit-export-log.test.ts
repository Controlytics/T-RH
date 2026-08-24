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
        reportType: 'Audit Trail', format: 'PDF', recordCount: 42, period: 'All Time',
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
    expect(after.format).toBe('PDF');
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
      payload: { reportType: 'Filters', format: 'Excel', recordCount: 1, remarks: 'test' },
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
      payload: { reportType: 'Filters', format: 'PDF', recordCount: 1 },
    });
    expect(res.statusCode).toBe(400);
    // Fastify/ajv's own "must have required property 'remarks'" message names
    // the field — assert on that rather than a hand-written string so this
    // doesn't silently drift from whatever ajv actually says.
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
      payload: { reportType: 'Filters', format: 'PDF', recordCount: 1, remarks: '   ' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('VALIDATION_ERROR');
  });

  describe('DOWNLOAD_REPORT reauth gate', () => {
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
        payload: { reportType: 'Audit Trail', format: 'PDF', recordCount: 1, remarks: 'reauth check' },
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
        payload: { reportType: 'Audit Trail', format: 'PDF', recordCount: 1, remarks: 'reauth check' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('accepts the download once the correct password is supplied', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/audit/report-export-log',
        headers: { authorization: `Bearer ${token}`, 'x-reauth-password': TEST_PASSWORD },
        payload: { reportType: 'Audit Trail', format: 'PDF', recordCount: 1, remarks: 'reauth check' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
    });
  });
});
