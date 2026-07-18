import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';

/**
 * Bug fix (2026-07-08): downloading/generating any report must itself be an
 * auditable event. The exports are client-side, so POST /api/audit/report-export-log
 * is the only place they're captured. This verifies the endpoint writes a
 * REPORT_GENERATED row with the report type, format + record count.
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

  it('writes a REPORT_GENERATED audit row with the username, report type, format + count', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/audit/report-export-log',
      headers: { authorization: `Bearer ${token}` },
      payload: { reportType: 'Audit Trail', format: 'PDF', recordCount: 42, period: 'All Time' },
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
  });

  it('rejects an unauthenticated request (route is gated, not open)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/audit/report-export-log',
      payload: { reportType: 'Filters', format: 'Excel', recordCount: 1 },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an invalid format', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/audit/report-export-log',
      headers: { authorization: `Bearer ${token}` },
      payload: { reportType: 'Filters', format: 'CSV', recordCount: 1 },
    });
    expect(res.statusCode).toBe(400);
  });
});
