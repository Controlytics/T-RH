import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { invalidateReauthCache } from '../lib/reauth-check.js';

/**
 * 2026-11-16 (audit 2026-11-07 S6-4): ACKNOWLEDGE_ALARM, APPROVE_REPORT and
 * REJECT_REPORT left the re-auth REGISTRY — their password is always verified.
 * An install's stored policy may still name them. The policy readers return
 * registry keys only, so neither policy screen counts a toggle it no longer
 * shows, and its next save drops the stale entry.
 */
let app: FastifyInstance;
let auth: Record<string, string>;
let policyBefore: { configValue: unknown } | null = null;

beforeAll(async () => {
  app = await buildApp();
  auth = { authorization: `Bearer ${await loginAs(app)}` };
  const row = await prisma.systemConfig.findUnique({ where: { configKey: 'action-reauth' } });
  policyBefore = row ? { configValue: row.configValue } : null;
  const stale = { ACKNOWLEDGE_ALARM: ['SUPER_ADMIN'], APPROVE_REPORT: ['SUPER_ADMIN'], DELETE_USER: ['SUPER_ADMIN'] };
  await prisma.systemConfig.upsert({
    where: { configKey: 'action-reauth' },
    update: { configValue: stale },
    create: { configKey: 'action-reauth', configValue: stale, configType: 'security', requiresReauth: false },
  });
  invalidateReauthCache();
});

afterAll(async () => {
  // Restore FIRST: other suites read this row.
  if (policyBefore) {
    await prisma.systemConfig.update({ where: { configKey: 'action-reauth' }, data: { configValue: policyBefore.configValue as never } });
  } else {
    await prisma.systemConfig.deleteMany({ where: { configKey: 'action-reauth' } });
  }
  invalidateReauthCache();
  await app.close();
});

describe('a stored policy naming an action that left the registry', () => {
  it('GET /api/config/action-reauth returns registry keys only', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/config/action-reauth', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ DELETE_USER: ['SUPER_ADMIN'] });
  });

  it('GET /api/config/action-reauth/my-actions lists registry keys only', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/config/action-reauth/my-actions', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().actions).toEqual(['DELETE_USER']);
  });
});
