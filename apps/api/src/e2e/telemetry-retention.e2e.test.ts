import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { buildApp, loginAs, authGet, authPut } from './test-helper.js';
import { retentionSettings } from '../workers/telemetry-partition.worker.js';
import { TELEMETRY_RETENTION_CONFIG_KEY, TELEMETRY_RETENTION_DEFAULTS } from '../modules/config/defs/telemetry-retention.def.js';

/**
 * The `telemetry-retention` config def (2026-10-05; audit 2026-10-03, DATA-9).
 * The worker read this row for months with no def behind it. Now: SUPER_ADMIN
 * reads and writes it through the dynamic routes (every write a CONFIG_CHANGED
 * row), a non-admin is refused, an unsafe value is refused, and what is saved
 * is what the worker reads back.
 */
describe('telemetry-retention config', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let operatorToken: string;
  let base: { configValue: unknown; configType: string } | null = null;

  beforeAll(async () => {
    app = await buildApp();
    adminToken = await loginAs(app);
    operatorToken = await loginAs(app, 'RB0001', 'Test@1234');
    const row = await prisma.systemConfig.findUnique({ where: { configKey: TELEMETRY_RETENTION_CONFIG_KEY } });
    base = row ? { configValue: row.configValue, configType: row.configType } : null;
  });

  afterAll(async () => {
    if (base === null) {
      await prisma.systemConfig.deleteMany({ where: { configKey: TELEMETRY_RETENTION_CONFIG_KEY } });
    } else {
      await prisma.systemConfig.upsert({
        where: { configKey: TELEMETRY_RETENTION_CONFIG_KEY },
        create: { configKey: TELEMETRY_RETENTION_CONFIG_KEY, configValue: base.configValue as object, configType: base.configType },
        update: { configValue: base.configValue as object },
      });
    }
    await app.close();
  });

  it('is in the manifest for SUPER_ADMIN and reads back its defaults on a fresh row', async () => {
    const manifest = await authGet(app, '/api/config/registry/manifest', adminToken);
    expect(manifest.statusCode).toBe(200);
    const entry = (JSON.parse(manifest.body) as Array<{ moduleKey: string; hasCustomPage: boolean }>).find((m) => m.moduleKey === TELEMETRY_RETENTION_CONFIG_KEY);
    expect(entry).toBeDefined();
    expect(entry?.hasCustomPage).toBe(false);

    const res = await authGet(app, `/api/config/dynamic/${TELEMETRY_RETENTION_CONFIG_KEY}`, adminToken);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.monthsAhead).toBe(TELEMETRY_RETENTION_DEFAULTS.monthsAhead);
    expect(body.dropEnabled).toBe(TELEMETRY_RETENTION_DEFAULTS.dropEnabled);
    expect(body.retentionMonths).toBe(TELEMETRY_RETENTION_DEFAULTS.retentionMonths);
  });

  it('is SUPER_ADMIN-only, read and write', async () => {
    expect((await authGet(app, `/api/config/dynamic/${TELEMETRY_RETENTION_CONFIG_KEY}`, operatorToken)).statusCode).toBe(403);
    expect((await authPut(app, `/api/config/dynamic/${TELEMETRY_RETENTION_CONFIG_KEY}`, operatorToken, { monthsAhead: 3, dropEnabled: true, retentionMonths: 1 })).statusCode).toBe(403);
  });

  it('refuses fewer than two months ahead — one missed run must never stop ingest — and a zero retention', async () => {
    expect((await authPut(app, `/api/config/dynamic/${TELEMETRY_RETENTION_CONFIG_KEY}`, adminToken, { monthsAhead: 1, dropEnabled: false, retentionMonths: 12 })).statusCode).toBe(400);
    expect((await authPut(app, `/api/config/dynamic/${TELEMETRY_RETENTION_CONFIG_KEY}`, adminToken, { monthsAhead: 3, dropEnabled: true, retentionMonths: 0 })).statusCode).toBe(400);
    expect((await authPut(app, `/api/config/dynamic/${TELEMETRY_RETENTION_CONFIG_KEY}`, adminToken, { monthsAhead: 3, dropEnabled: 'yes', retentionMonths: 12 })).statusCode).toBe(400);
  });

  it('a saved value is what the worker reads back, and the save is audited', async () => {
    const res = await authPut(app, `/api/config/dynamic/${TELEMETRY_RETENTION_CONFIG_KEY}`, adminToken, { monthsAhead: 4, dropEnabled: true, retentionMonths: 18 });
    expect(res.statusCode).toBe(200);
    const settings = await retentionSettings();
    expect(settings).toEqual({ monthsAhead: 4, dropEnabled: true, retentionMonths: 18 });
    const audit = await prisma.auditTrail.findFirst({
      where: { action: 'CONFIG_CHANGED', targetId: TELEMETRY_RETENTION_CONFIG_KEY }, orderBy: { timestamp: 'desc' },
    });
    expect(audit).toBeTruthy();
  });
});
