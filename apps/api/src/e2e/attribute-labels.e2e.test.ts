import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { ATTRIBUTE_LABELS_CONFIG_KEY } from '@digilog/shared';
import { prisma } from '../lib/prisma.js';
import { buildApp, loginAs, authGet, authPut } from './test-helper.js';

/**
 * Attribute display names (2026-09-16): the `attribute-labels` config def and
 * the narrow-slice route every signed-in user reads it through.
 *
 * Two properties are protected. The MAP reaches a non-admin — the labels are
 * printed on the registration form, the Attributes panel and the Settings
 * widget, none of which are SUPER_ADMIN pages — while the EDITOR stays
 * SUPER_ADMIN-only, because hiding a config card is presentation and the server
 * refusing the PUT is the control. And what comes back is the COERCED map, so a
 * blank name or a case-duplicate never reaches a screen — the same reader the
 * browser falls back on, asserted over HTTP because Fastify strips anything the
 * response schema does not declare.
 */
describe('Attribute display names', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let operatorToken: string;
  let base: unknown;

  beforeAll(async () => {
    app = await buildApp();
    adminToken = await loginAs(app);
    operatorToken = await loginAs(app, 'RB0001', 'Test@1234');
    const existing = await prisma.systemConfig.findUnique({ where: { configKey: ATTRIBUTE_LABELS_CONFIG_KEY } });
    base = existing?.configValue ?? null;
  });

  afterAll(async () => {
    // Restore verbatim: the test DB's row is administered state, not a fixture.
    if (base === null) {
      await prisma.systemConfig.deleteMany({ where: { configKey: ATTRIBUTE_LABELS_CONFIG_KEY } });
    } else {
      // Upsert, not update: a test above deletes the row to prove the unset case.
      await prisma.systemConfig.upsert({
        where: { configKey: ATTRIBUTE_LABELS_CONFIG_KEY },
        create: { configKey: ATTRIBUTE_LABELS_CONFIG_KEY, configValue: base as object, configType: 'display' },
        update: { configValue: base as object },
      });
    }
    await app.close();
  });

  it('GET /current needs a login', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/config/attribute-labels/current' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /current is readable by a non-admin, and an unset row is an empty map', async () => {
    await prisma.systemConfig.deleteMany({ where: { configKey: ATTRIBUTE_LABELS_CONFIG_KEY } });
    const res = await authGet(app, '/api/config/attribute-labels/current', operatorToken);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ labels: {} });
  });

  it('the editor endpoint stays SUPER_ADMIN-only, read and write', async () => {
    const get = await authGet(app, '/api/config/dynamic/attribute-labels', operatorToken);
    expect(get.statusCode).toBe(403);
    const put = await authPut(app, '/api/config/dynamic/attribute-labels', operatorToken, {
      labels: { Building: 'Site' },
    });
    expect(put.statusCode).toBe(403);
  });

  it('a saved map reads back COERCED: trimmed, blanks dropped, one spelling per key', async () => {
    const put = await authPut(app, '/api/config/dynamic/attribute-labels', adminToken, {
      labels: {
        ' Enable_Temp_NMT ': ' High temperature alarm enabled ',
        Building: '   ',
        Room: 'Cleanroom',
        room: 'Other',
      },
    });
    expect(put.statusCode).toBe(200);

    const res = await authGet(app, '/api/config/attribute-labels/current', operatorToken);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Inner keys asserted one by one — a schema without `additionalProperties`
    // would strip the whole map to `{}` and a `toBeDefined` on `labels` would
    // still pass.
    expect(body.labels.Enable_Temp_NMT).toBe('High temperature alarm enabled');
    expect(body.labels.Building).toBeUndefined();
    expect(body.labels.Room).toBe('Cleanroom');
    expect(body.labels.room).toBeUndefined();
  });

  it('refuses a body that is not a key → name map', async () => {
    const put = await authPut(app, '/api/config/dynamic/attribute-labels', adminToken, {
      labels: ['Building'],
    });
    expect(put.statusCode).toBe(400);
  });

  it('refuses a name longer than the administered maximum', async () => {
    const put = await authPut(app, '/api/config/dynamic/attribute-labels', adminToken, {
      labels: { Building: 'x'.repeat(200) },
    });
    expect(put.statusCode).toBe(400);
  });
});
