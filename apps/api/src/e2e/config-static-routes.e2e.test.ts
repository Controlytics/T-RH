/**
 * Audit 2026-10-03, API-18: the three static config PUTs — access-matrix,
 * export-options, report-page-titles — took their body unvalidated and asked
 * for no re-authentication. export-options in particular accepted ANY string
 * as a format, and the client reads an unknown value as BOTH, so a typo
 * silently granted every export. Each now validates its shape, re-auths, and
 * writes the row and its CONFIG_CHANGED audit row in one transaction (API-7).
 *
 * Every row touched is restored in `afterAll` — the suite shares
 * `compliance_core_db_test`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs, authGet, authPut, ADMIN_PASSWORD } from './test-helper.js';
import { prisma } from '../lib/prisma.js';

const KEYS = ['access-matrix', 'export-options', 'report-page-titles'] as const;

let app: FastifyInstance;
let admin: string;
const original = new Map<string, unknown | null>();

beforeAll(async () => {
  app = await buildApp();
  admin = await loginAs(app);
  for (const key of KEYS) {
    const row = await prisma.systemConfig.findUnique({ where: { configKey: key } });
    original.set(key, row ? row.configValue : null);
  }
});

afterAll(async () => {
  for (const key of KEYS) {
    const value = original.get(key);
    if (value === null || value === undefined) {
      await prisma.systemConfig.deleteMany({ where: { configKey: key } });
    } else {
      await prisma.systemConfig.update({ where: { configKey: key }, data: { configValue: value as any } });
    }
  }
  await app.close();
});

describe('PUT /api/config/export-options', () => {
  it('refuses a format outside NONE | PDF | EXCEL | BOTH (400), writing nothing', async () => {
    const before = await prisma.systemConfig.findUnique({ where: { configKey: 'export-options' } });
    const res = await authPut(app, '/api/config/export-options', admin, { OPERATOR: { audit: 'MAYBE' } }, ADMIN_PASSWORD);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('VALIDATION_ERROR');
    const after = await prisma.systemConfig.findUnique({ where: { configKey: 'export-options' } });
    expect(after?.configValue ?? null).toEqual(before?.configValue ?? null);
  });

  it('saves a valid matrix, reads it back, and audits it', async () => {
    const matrix = { OPERATOR: { audit: 'PDF', alarms: 'NONE' } };
    const res = await authPut(app, '/api/config/export-options', admin, matrix, ADMIN_PASSWORD);
    expect(res.statusCode).toBe(200);
    const read = JSON.parse((await authGet(app, '/api/config/export-options', admin)).body);
    expect(read).toEqual(matrix);
    const row = await prisma.auditTrail.findFirst({
      where: { action: 'CONFIG_CHANGED', targetId: 'export-options' }, orderBy: { timestamp: 'desc' },
    });
    expect(row?.afterValue).toEqual(matrix);
  });
});

describe('PUT /api/config/access-matrix', () => {
  it('refuses a module whose value is not a list of role names (400)', async () => {
    const res = await authPut(app, '/api/config/access-matrix', admin, { users: 'ADMIN' }, ADMIN_PASSWORD);
    expect(res.statusCode).toBe(400);
  });

  it('saves a valid matrix and reads it back', async () => {
    const matrix = { users: ['ADMIN', 'SUPER_ADMIN'], audit: ['SUPER_ADMIN'] };
    const res = await authPut(app, '/api/config/access-matrix', admin, matrix, ADMIN_PASSWORD);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse((await authGet(app, '/api/config/access-matrix', admin)).body)).toEqual(matrix);
  });
});

describe('PUT /api/config/report-page-titles', () => {
  it('refuses a key the page does not edit (400) — the row is served to every authenticated user', async () => {
    const res = await authPut(app, '/api/config/report-page-titles', admin, { companyName: 'X', evil: '<script>' }, ADMIN_PASSWORD);
    expect(res.statusCode).toBe(400);
  });

  it('saves the two identity fields and reads them back on /current', async () => {
    const res = await authPut(app, '/api/config/report-page-titles', admin, { companyName: 'E2E Co', appName: 'E2E App' }, ADMIN_PASSWORD);
    expect(res.statusCode).toBe(200);
    const cur = JSON.parse((await authGet(app, '/api/config/report-page-titles/current', admin)).body);
    expect(cur).toEqual({ companyName: 'E2E Co', appName: 'E2E App' });
  });
});
