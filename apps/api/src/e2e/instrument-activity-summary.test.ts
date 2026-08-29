import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs, authGet } from './test-helper.js';
import { prisma } from '../lib/prisma.js';

/**
 * "Active" means REPORTING, not ENABLED.
 *
 * This suite exists because the dashboard first counted `Instrument.isActive`,
 * the administrator's enable/disable flag. Every instrument on the installation
 * was enabled, so every card read "101 active · 0 inactive" while nothing had
 * reported for two days: true of the column, useless on a monitoring
 * dashboard, and the operator spotted it before any test did.
 *
 * The distinguishing case is therefore an instrument that is ENABLED but has
 * not reported. Counting isActive calls it active; the product's own
 * definition (Configuration → Instrument Activity, implemented once as
 * `isInstrumentReporting`) calls it inactive. Every test below turns on it.
 */
describe('instrument activity summary', () => {
  let app: FastifyInstance;
  let token: string;
  const created: string[] = [];
  let profileId: string;

  const mk = async (code: string, lastSeenAt: Date | null, expectedIntervalSec: number | null = null) => {
    const row = await prisma.instrument.create({
      data: {
        code, name: code, profileId, isActive: true, lastSeenAt, expectedIntervalSec,
      },
    });
    created.push(row.id);
    return row;
  };

  const summary = async () => {
    const res = await authGet(app, '/api/instruments/activity-summary', token);
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as { total: number; active: number; activeWindowMinutes: number };
  };

  beforeAll(async () => {
    app = await buildApp();
    token = await loginAs(app);
    const p = await prisma.instrumentProfile.findFirst({ select: { id: true } });
    if (!p) throw new Error('fixture: expected an instrument profile');
    profileId = p.id;
  });

  afterAll(async () => {
    await prisma.instrument.deleteMany({ where: { id: { in: created } } });
    await app.close();
  });

  it('routes to the summary handler, not to /:id', async () => {
    const res = await authGet(app, '/api/instruments/activity-summary', token);
    // A 400 "malformed uuid" here would mean `/:id` claimed the path.
    expect(res.statusCode).toBe(200);
  });

  it('reports the fallback window so a caller can explain the split', async () => {
    const s = await summary();
    expect(s.activeWindowMinutes).toBeGreaterThan(0);
  });

  // THE REGRESSION TEST. Enabled, never reported -> NOT active.
  it('does not count an enabled instrument that has never reported', async () => {
    const before = await summary();
    await mk(`ZZACT-never-${Date.now()}`, null);
    const after = await summary();
    expect(after.total).toBe(before.total + 1);
    expect(after.active).toBe(before.active);
  });

  // Enabled, reported long ago -> NOT active. This is the case that made every
  // card read 101/0 on a plant that had been silent for two days.
  it('does not count an enabled instrument that stopped reporting', async () => {
    const before = await summary();
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await mk(`ZZACT-stale-${Date.now()}`, longAgo);
    const after = await summary();
    expect(after.total).toBe(before.total + 1);
    expect(after.active).toBe(before.active);
  });

  it('counts an instrument reporting right now', async () => {
    const before = await summary();
    await mk(`ZZACT-fresh-${Date.now()}`, new Date());
    const after = await summary();
    expect(after.total).toBe(before.total + 1);
    expect(after.active).toBe(before.active + 1);
  });

  // An instrument declaring its own interval is judged against that contract,
  // not the site fallback — otherwise a rig read once a shift is libelled as
  // dead every time the fallback window is shorter than its cadence.
  it('judges an instrument against its own expected interval', async () => {
    const before = await summary();
    // Reported 2 hours ago, but declares a 4-hour cadence: still reporting.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await mk(`ZZACT-slow-${Date.now()}`, twoHoursAgo, 4 * 60 * 60);
    const after = await summary();
    expect(after.active).toBe(before.active + 1);
  });

  it('active never exceeds total', async () => {
    const s = await summary();
    expect(s.active).toBeLessThanOrEqual(s.total);
    expect(s.active).toBeGreaterThanOrEqual(0);
  });

  it('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/instruments/activity-summary' });
    expect(res.statusCode).toBe(401);
  });
});

/**
 * The same rule has to hold on the location cards, or the headline and the
 * cards beneath it describe different populations — which is the specific way
 * this defect would come back.
 */
describe('functional-location counts use the same definition', () => {
  let app: FastifyInstance;
  let token: string;
  const created: string[] = [];
  let blockId: string;
  let profileId: string;

  beforeAll(async () => {
    app = await buildApp();
    token = await loginAs(app);
    const p = await prisma.instrumentProfile.findFirst({ select: { id: true } });
    if (!p) throw new Error('fixture: expected an instrument profile');
    profileId = p.id;
    const block = await prisma.functionalLocation.create({
      data: { name: `ZZActBlock ${Date.now()}`, type: 'BLOCK' },
    });
    blockId = block.id;
  });

  afterAll(async () => {
    await prisma.instrument.deleteMany({ where: { id: { in: created } } });
    await prisma.functionalLocation.deleteMany({ where: { id: blockId } });
    await app.close();
  });

  it('counts a silent instrument in total but not in active', async () => {
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    for (const [code, seen] of [
      [`ZZFL-fresh-${Date.now()}`, new Date()],
      [`ZZFL-stale-${Date.now()}`, longAgo],
    ] as const) {
      const row = await prisma.instrument.create({
        data: {
          code: String(code), name: String(code), profileId,
          isActive: true, lastSeenAt: seen, functionalLocationId: blockId,
        },
      });
      created.push(row.id);
    }

    const res = await authGet(app, '/api/functional-locations', token);
    const body = JSON.parse(res.body);
    const list = Array.isArray(body) ? body : body.data ?? [];
    const block = list.find((n: any) => n.id === blockId);

    expect(block.totalCount).toBe(2);
    // Both are ENABLED. Only one is reporting.
    expect(block.activeCount).toBe(1);
  });
});
