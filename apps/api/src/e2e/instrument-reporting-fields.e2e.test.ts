import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs, authGet } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';

/**
 * The instrument LIST and DETAIL carry the server's own verdict —
 * `reporting` and the interval it judged by, `effectiveExpectedIntervalSec` —
 * so no page re-derives it from the bare `expectedIntervalSec` column (which
 * made a silent TCP/IP instrument read "reporting" for a day, root CLAUDE.md
 * "never reconstruct server-side decisions in the client").
 */
describe('instrument list and detail: reporting + effectiveExpectedIntervalSec', () => {
  let app: FastifyInstance;
  let token: string;
  const tag = Date.now();
  let tcpProfileId = '';
  const ids: Record<string, string> = {};
  const created: string[] = [];

  beforeAll(async () => {
    app = await buildApp();
    token = await loginAs(app);
    tcpProfileId = (await prisma.instrumentProfile.create({
      data: { name: `RPT-TCP-${tag}`, connection: 'MODBUS_TCP' },
    })).id;
    const pushProfileId = await fixtureProfileId('fixture:instrument-reporting-fields');
    const threeMinAgo = new Date(Date.now() - 3 * 60 * 1000);
    const specs = [
      // 45 s is each instrument's OWN read interval (CR-1) — no default, so the
      // answer cannot come from a constant or from the profile.
      { key: 'tcp', code: `RPT-TCP-${tag}`, profileId: tcpProfileId, extra: { modbusHost: '10.254.4.1', modbusPort: 502, modbusUnitId: 1, modbusIntervalSec: 45 } },
      { key: 'tcpOwn', code: `RPT-OWN-${tag}`, profileId: tcpProfileId, extra: { modbusHost: '10.254.4.2', modbusPort: 502, modbusUnitId: 1, modbusIntervalSec: 45, expectedIntervalSec: 600 } },
      { key: 'push', code: `RPT-PUSH-${tag}`, profileId: pushProfileId, extra: {} },
    ];
    for (const sp of specs) {
      const row = await prisma.instrument.create({
        data: { code: sp.code, name: sp.code, profileId: sp.profileId, lastSeenAt: threeMinAgo, ...sp.extra },
      });
      ids[sp.key] = row.id;
      created.push(row.id);
    }
  });

  afterAll(async () => {
    await prisma.instrument.deleteMany({ where: { id: { in: created } } });
    await prisma.instrumentProfile.deleteMany({ where: { id: tcpProfileId } });
    await app.close();
  });

  const detail = async (id: string) => {
    const res = await authGet(app, `/api/instruments/${id}`, token);
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as { reporting: boolean; effectiveExpectedIntervalSec: number | null };
  };

  it('DETAIL: a TCP/IP instrument silent 3 min is not reporting and says its read interval', async () => {
    expect(await detail(ids.tcp)).toMatchObject({ reporting: false, effectiveExpectedIntervalSec: 45 });
  });

  it('DETAIL: its own expected interval wins; 3 min is inside 2 x 600 s', async () => {
    expect(await detail(ids.tcpOwn)).toMatchObject({ reporting: true, effectiveExpectedIntervalSec: 600 });
  });

  it('DETAIL: a push instrument is unchanged - no interval, the site window decides', async () => {
    expect(await detail(ids.push)).toMatchObject({ reporting: true, effectiveExpectedIntervalSec: null });
  });

  it('LIST carries the same two fields per row', async () => {
    const res = await authGet(app, `/api/instruments?search=${encodeURIComponent(`-${tag}`)}&limit=50`, token);
    expect(res.statusCode).toBe(200);
    const rows = (JSON.parse(res.body) as { data: { id: string; reporting: boolean; effectiveExpectedIntervalSec: number | null }[] }).data;
    const by = (id: string) => rows.find((r) => r.id === id)!;
    expect(by(ids.tcp)).toMatchObject({ reporting: false, effectiveExpectedIntervalSec: 45 });
    expect(by(ids.tcpOwn)).toMatchObject({ reporting: true, effectiveExpectedIntervalSec: 600 });
    expect(by(ids.push)).toMatchObject({ reporting: true, effectiveExpectedIntervalSec: null });
  });
});
