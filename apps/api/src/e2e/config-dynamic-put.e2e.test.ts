import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs, authPut, ADMIN_PASSWORD } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { invalidateReauthCache } from '../lib/reauth-check.js';

/**
 * The generic dynamic config PUT (`modules/config/dynamic-routes.ts`).
 *
 *  - audit 2026-10-12 #2: the upsert and its CONFIG_CHANGED row are ONE
 *    transaction. Proved with a trigger refusing the audit insert: on the old
 *    code the value changed and no audit row recorded it.
 *  - audit 2026-10-12 #7: every setting's DECLARED type / min / max / length /
 *    options is enforced server-side from the def (33 of 35 defs have no zod
 *    schema, so `min`/`max` were presentation only), 400 naming the field; and
 *    the four SUPER_ADMIN defs that carried no re-auth action at all
 *    (report-downloads, report-approvers, sensor-offsets, telemetry-retention)
 *    now carry UPDATE_CONFIG_PAGE, so the Action Re-auth policy can switch it on.
 *
 * Every config row this file touches is captured first and restored FIRST in
 * afterAll (the 2026-08-31 incident).
 */
const KEYS = ['export-limit', 'report-downloads', 'instrument-activity', 'audit-hard-delete', 'action-reauth', 'sensor-offsets', 'telemetry-retention', 'report-approvers'] as const;
const originals = new Map<string, { configValue: unknown; configType: string; requiresReauth: boolean } | null>();
const STAMP = String(Date.now()).slice(-6);
const FN = `cfg_refuse_audit_${STAMP}`;
const TRG = `cfg_refuse_audit_trg_${STAMP}`;

let app: FastifyInstance;
let token = '';
const put = (key: string, body: unknown, password?: string) => authPut(app, `/api/config/dynamic/${key}`, token, body, password);
const valueOf = async (key: string) => (await prisma.systemConfig.findUnique({ where: { configKey: key } }))?.configValue;

async function dropTrigger() {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${TRG} ON audit_trail`);
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${FN}()`);
}

beforeAll(async () => {
  app = await buildApp();
  token = await loginAs(app);
  for (const key of KEYS) {
    const row = await prisma.systemConfig.findUnique({ where: { configKey: key } });
    originals.set(key, row ? { configValue: row.configValue, configType: row.configType, requiresReauth: row.requiresReauth } : null);
  }
});

afterAll(async () => {
  for (const key of KEYS) {
    try {
      const o = originals.get(key);
      if (o) await prisma.systemConfig.upsert({ where: { configKey: key }, update: o as never, create: { configKey: key, ...o } as never });
      else await prisma.systemConfig.deleteMany({ where: { configKey: key } });
    } catch (e) { console.error(`${key} restore failed`, e); }
  }
  invalidateReauthCache();
  try { await dropTrigger(); } catch (e) { console.error('trigger cleanup failed', e); }
  await app.close();
});

describe('#2 — the config change and its CONFIG_CHANGED row are one transaction', () => {
  it('an audit insert that fails leaves the stored value UNCHANGED', async () => {
    await prisma.systemConfig.upsert({
      where: { configKey: 'audit-hard-delete' },
      update: { configValue: { enabled: false } },
      create: { configKey: 'audit-hard-delete', configValue: { enabled: false }, configType: 'security', requiresReauth: false },
    });
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION ${FN}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'CONFIG_CHANGED' AND NEW.target_id = 'audit-hard-delete' THEN RAISE EXCEPTION 'test: audit insert refused'; END IF;
        RETURN NEW;
      END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER ${TRG} BEFORE INSERT ON audit_trail FOR EACH ROW EXECUTE FUNCTION ${FN}()`);
    try {
      const res = await put('audit-hard-delete', { enabled: true }, ADMIN_PASSWORD);
      expect(res.statusCode).toBe(500);
    } finally {
      await dropTrigger();
    }
    expect(await valueOf('audit-hard-delete')).toEqual({ enabled: false });
  });
});

describe('#7 — each setting is validated against its own declaration', () => {
  it('a number below its min, above its max, or not a number at all is refused, naming the field', async () => {
    const below = await put('export-limit', { maxRecords: 0, message: 'too many' });
    expect(below.statusCode).toBe(400);
    expect(below.json()).toMatchObject({ error: 'VALIDATION_ERROR', field: 'maxRecords' });
    const above = await put('export-limit', { maxRecords: 10_000_000_000, message: 'too many' });
    expect(above.statusCode).toBe(400);
    expect(above.json().field).toBe('maxRecords');
    const nan = await put('export-limit', { maxRecords: 'lots', message: 'too many' });
    expect(nan.statusCode).toBe(400);
    expect(nan.json().field).toBe('maxRecords');
    const okRes = await put('export-limit', { maxRecords: 500, message: 'too many' });
    expect(okRes.statusCode).toBe(200);
    expect(await valueOf('export-limit')).toMatchObject({ maxRecords: 500 });
  });

  it('a string over its maxLength is refused', async () => {
    const res = await put('export-limit', { maxRecords: 500, message: 'x'.repeat(501) });
    expect(res.statusCode).toBe(400);
    expect(res.json().field).toBe('message');
  });

  it('a select value outside its options is refused; a boolean must be a boolean', async () => {
    const bogus = await put('report-downloads', { dataReportMode: 'BOGUS' });
    expect(bogus.statusCode).toBe(400);
    expect(bogus.json().field).toBe('dataReportMode');
    const notBool = await put('report-downloads', { dataReportMode: 'REQUEST', dataReportRemarks: 'yes' });
    expect(notBool.statusCode).toBe(400);
    expect(notBool.json().field).toBe('dataReportRemarks');
  });

  it('a value nothing was stored for, and keys the def does not declare, still pass (wholesale writes)', async () => {
    const res = await put('instrument-activity', { ...((await valueOf('instrument-activity')) as object), activeWindowMinutes: 30, someFutureKey: 'kept' });
    expect(res.statusCode).toBe(200);
  });
});

describe('#7 — the four SUPER_ADMIN defs without a re-auth action now carry UPDATE_CONFIG_PAGE', () => {
  it.each(['report-downloads', 'report-approvers', 'sensor-offsets', 'telemetry-retention'])(
    '%s asks for the password once the policy requires UPDATE_CONFIG_PAGE',
    async (key) => {
      await prisma.systemConfig.upsert({
        where: { configKey: 'action-reauth' },
        update: { configValue: { UPDATE_CONFIG_PAGE: ['SUPER_ADMIN'] } },
        create: { configKey: 'action-reauth', configValue: { UPDATE_CONFIG_PAGE: ['SUPER_ADMIN'] }, configType: 'security', requiresReauth: false },
      });
      invalidateReauthCache();
      try {
        const body = (await valueOf(key)) as Record<string, unknown>;
        const without = await put(key, { ...body });
        expect(without.statusCode).toBe(401);
        expect(without.json()).toMatchObject({ error: 'REAUTH_REQUIRED', action: 'UPDATE_CONFIG_PAGE' });
        const withPw = await put(key, { ...body }, ADMIN_PASSWORD);
        expect(withPw.statusCode).toBe(200);
      } finally {
        const o = originals.get('action-reauth');
        if (o) await prisma.systemConfig.update({ where: { configKey: 'action-reauth' }, data: o as never });
        else await prisma.systemConfig.deleteMany({ where: { configKey: 'action-reauth' } });
        invalidateReauthCache();
      }
    },
  );
});
