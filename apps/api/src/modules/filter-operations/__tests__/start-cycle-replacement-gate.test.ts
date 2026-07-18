/**
 * start-cycle — AHU overdue-replacement gate (2026-07-16, Task 3).
 *
 * A filter parented to an AHU with an overdue (approved, unmet-qty,
 * windowEnd-in-the-past) ReplacementScheduleEntry cannot START a new cleaning
 * cycle online. Offline replay is exempt — the offline client already gated
 * this at scan time; re-checking on replay could strand a legitimately-queued
 * start (mirrors validateBlockChange's replay auto-pass).
 *
 * Test-infra notes (mirrors advance-with-checklist-atomic.test.ts)
 * ------------------------------------------------------------------
 * - Real Fastify (in-process `inject()`), real Prisma, real auth, against
 *   `digilog_test_db`. Unique SUPER_ADMIN per file so the shared `admin`
 *   login race can't touch us.
 * - Online path is asserted end-to-end via `app.inject`.
 * - The offline-replay exemption is asserted by calling `startCycleImpl`
 *   directly with `ctx.isOfflineReplay = true` — forging a valid HMAC
 *   `x-offline-replay-token` over HTTP is out of scope for this file (the
 *   rest of the suite doesn't do it either); direct unit invocation is the
 *   documented fallback in the task brief.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';

import authPlugin from '../../../plugins/auth.js';
import rbacPlugin from '../../../plugins/rbac.js';
import authRoutes from '../../auth/routes.js';
import filterOperationsRoutes from '../routes.js';
import { prisma } from '../../../lib/prisma.js';
import { hashPassword } from '../../../lib/password.js';
import { AppError } from '../../../lib/errors.js';
import { loginAs } from '../../../e2e/test-helper.js';
import { randomUUID } from 'node:crypto';

import { startCycleImpl } from '../cycle-write/start-cycle.js';
import { FilterOperationsService } from '../filter-operations.service.js';
import type { RequestContext } from '../../../types/context.js';

const SUFFIX = Date.now().toString(36).slice(-4).toUpperCase();
const SCG_USERNAME = `SCGT${SUFFIX}`.slice(0, 16).toUpperCase();
const SCG_PASSWORD = 'ScgTest@Digilog#9';
const REASON_KEY = 'ROUTINE';

// UTC date-only string offset from today by `days`.
function dayISO(days: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, ajv: { customOptions: { keywords: ['example'] } } });
  await app.register(cors, { origin: true, credentials: true });
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  await app.register(authPlugin);
  await app.register(rbacPlugin);
  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({
        error: err.code, message: err.message, ...(err.details ? { details: err.details } : {}),
      });
    }
    if ((err as any).code === 'FST_ERR_VALIDATION' || (err as any).validation) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: err.message });
    }
    return reply.code(err.statusCode ?? 500).send({ error: err.message || 'Internal Server Error' });
  });
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(filterOperationsRoutes, { prefix: '/api/filters' });
  await app.ready();
  return app;
}

describe('POST /:id/start-cycle — AHU overdue-replacement gate', () => {
  let app: FastifyInstance;
  let authHeaders: Record<string, string>;
  let authedUser: { userSub: string };

  let filterTemplateId = '';
  let cleaningProfileId = '';
  let filterProfileId = '';

  let ahuId = '';
  let blockedFilterId = '';
  let scheduleId = '';
  let entryId = '';

  const createdFilterIds: string[] = [];

  /** A filter bound to the given FilterProfile, parented to `parentId`. */
  async function makeFilter(parentId: string | undefined, label: string): Promise<string> {
    const id = (await prisma.assetInstance.create({
      data: {
        name: `SCG-${label}-${SUFFIX}`,
        templateId: filterTemplateId,
        ...(parentId ? { parentId } : {}),
        isActive: true, status: 'Active',
      },
    })).id;
    await prisma.filterDetails.create({
      data: { assetInstanceId: id, filterProfileId, currentCycleId: null, currentLifecycleState: null },
    });
    createdFilterIds.push(id);
    return id;
  }

  beforeAll(async () => {
    const passwordHash = await hashPassword(SCG_PASSWORD);
    const user = await prisma.user.upsert({
      where: { username: SCG_USERNAME },
      update: {
        passwordHash, role: 'SUPER_ADMIN', status: 'ENABLED', forcePasswordChange: false,
        isTemporaryPassword: false, failedLoginAttempts: 0, lockedAt: null, lockoutUntil: null,
      },
      create: {
        username: SCG_USERNAME, fullName: 'Start-Cycle Replacement Gate Test',
        email: `${SCG_USERNAME.toLowerCase()}@scg-test.local`, passwordHash,
        role: 'SUPER_ADMIN', status: 'ENABLED', forcePasswordChange: false,
        isTemporaryPassword: false, createdBy: 'scg-test',
      },
    });
    authedUser = { userSub: user.id };

    await prisma.templateKind.upsert({
      where: { code: 'FILTER' }, update: {},
      create: { code: 'FILTER', label: 'Filter', isSystem: true },
    });
    filterTemplateId = (await prisma.assetTemplate.create({
      data: { name: `SCG Filter Tpl ${SUFFIX}` , templateKind: 'FILTER' },
    })).id;

    // Simple START -> S1 -> END pipeline — the gate fires before any pipeline
    // resolution matters, but start-cycle still needs a resolvable profile.
    const cleaning = await prisma.filterCleaningProfile.create({
      data: {
        name: `SCG Profile ${SUFFIX}`,
        lineageId: randomUUID(),
        status: 'ACTIVE',
        createdBy: '00000000-0000-0000-0000-000000000001',
        cleaningReasons: [{ key: REASON_KEY, name: 'Routine', requiresJustification: false }],
        stages: {
          create: [
            { nodeType: 'START', stateKey: null, sortOrder: 0 },
            { nodeType: 'STAGE', stateKey: 'S1', sortOrder: 1 },
            { nodeType: 'END', stateKey: null, sortOrder: 2 },
          ],
        },
      },
      include: { stages: true },
    });
    cleaningProfileId = cleaning.id;
    const ordered = [...cleaning.stages].sort((a, b) => a.sortOrder - b.sortOrder);
    await prisma.filterPipelineConnection.createMany({
      data: ordered.slice(0, -1).map((from, i) => ({
        profileId: cleaning.id, fromStageId: from.id, toStageId: ordered[i + 1].id,
      })),
    });

    const fp = await prisma.filterProfile.create({
      data: { name: `SCG FP ${SUFFIX}`, cleaningProfileId: cleaning.id },
    });
    filterProfileId = fp.id;

    // AHU must be a REAL AssetInstance — assetInstance.parentId is a self-FK
    // with onDelete:Restrict (see blocked-filters.test.ts).
    ahuId = (await prisma.assetInstance.create({
      data: { name: `SCG-AHU-${SUFFIX}`, templateId: filterTemplateId },
    })).id;

    blockedFilterId = await makeFilter(ahuId, 'blocked');

    const sch = await prisma.replacementSchedule.create({
      data: { fileName: `scg-${SUFFIX}.xlsx`, status: 'ACTIVE', uploadedBy: randomUUID(), uploadedByName: 'scg-test' },
    });
    scheduleId = sch.id;
    // Overdue: windowEnd in the past, qty not fully met (no ReplacementExecution rows).
    const entry = await prisma.replacementScheduleEntry.create({
      data: {
        scheduleId: sch.id, ahuId, ahuName: `AHU-${SUFFIX}`, qty: 1,
        scheduleDate: dayISO(-10), toleranceDays: 0, windowStart: dayISO(-10), windowEnd: dayISO(-5),
        approvalStatus: 'APPROVED',
      },
    });
    entryId = entry.id;

    app = await buildApp();
    const token = await loginAs(app, SCG_USERNAME, SCG_PASSWORD);
    authHeaders = { authorization: `Bearer ${token}` };
  }, 60_000);

  afterAll(async () => {
    try {
      for (const id of createdFilterIds) {
        await prisma.filterEvent.deleteMany({ where: { filterId: id } });
        await prisma.cleaningCycle.deleteMany({ where: { filterId: id } });
        await prisma.filterDetails.deleteMany({ where: { assetInstanceId: id } });
      }
      if (entryId) await prisma.replacementExecution.deleteMany({ where: { entryId } }).catch(() => undefined);
      if (entryId) await prisma.replacementScheduleEntry.deleteMany({ where: { id: entryId } }).catch(() => undefined);
      if (scheduleId) await prisma.replacementSchedule.deleteMany({ where: { id: scheduleId } }).catch(() => undefined);
      for (const id of createdFilterIds) {
        await prisma.assetInstance.delete({ where: { id } }).catch(() => undefined);
      }
      if (ahuId) await prisma.assetInstance.delete({ where: { id: ahuId } }).catch(() => undefined);
      if (filterProfileId) await prisma.filterProfile.delete({ where: { id: filterProfileId } }).catch(() => undefined);
      if (cleaningProfileId) await prisma.filterCleaningProfile.delete({ where: { id: cleaningProfileId } }).catch(() => undefined);
      if (filterTemplateId) await prisma.assetTemplate.delete({ where: { id: filterTemplateId } }).catch(() => undefined);
    } catch { /* swallow — cleanup must never mask a real failure */ }
    try { await app.close(); } catch { /* swallow */ }
  }, 30_000);

  it('rejects start-cycle on a filter whose AHU replacement is overdue', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/filters/${blockedFilterId}/start-cycle`, headers: authHeaders,
      payload: { cleaningReasonKey: REASON_KEY, _currentPassword: SCG_PASSWORD },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('AHU_REPLACEMENT_OVERDUE');
  });

  it('wrote no cycle for the rejected start', async () => {
    const details = await prisma.filterDetails.findUnique({ where: { assetInstanceId: blockedFilterId } });
    expect(details!.currentCycleId).toBeNull();
    const count = await prisma.cleaningCycle.count({ where: { filterId: blockedFilterId } });
    expect(count).toBe(0);
  });

  it('allows an offline-replay start even when the AHU replacement is overdue (exemption)', async () => {
    const service = new FilterOperationsService();
    const ctx: RequestContext = {
      userId: SCG_USERNAME,
      userSub: authedUser.userSub,
      userRole: 'SUPER_ADMIN',
      ipAddress: '127.0.0.1',
      userAgent: 'vitest',
      sessionId: randomUUID(),
      isOfflineReplay: true,
    };

    const cycle = await startCycleImpl(service, ctx, blockedFilterId, {
      cleaningReasonKey: REASON_KEY,
    });

    expect(cycle).toBeTruthy();
    expect((cycle as any).filterId).toBe(blockedFilterId);
    expect((cycle as any).status).toBe('IN_PROGRESS');
  });
});
