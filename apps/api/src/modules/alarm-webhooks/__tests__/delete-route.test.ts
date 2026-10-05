import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Audit 2026-10-03, API-20: `DELETE /api/alarm-webhooks/:id` counted
 * deliveries and then deleted in two statements. A delivery written between
 * them reached the RESTRICT foreign key, whose P2003 was unmapped — a 500 and a
 * SYSTEM_ERROR notification for a request the route answers 409 a moment
 * earlier. The e2e covers the count path; this drives the handler with a
 * transaction that fails the way the database does, which no e2e can time.
 */
// `vi.hoisted` so the object exists when the hoisted `vi.mock` factory runs.
const prisma = vi.hoisted(() => ({
  alarmWebhookTarget: { findUnique: vi.fn() },
  alarmWebhookDelivery: { count: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock('../../../lib/prisma.js', () => ({ prisma }));
vi.mock('../../../lib/reauth-check.js', () => ({ enforceReauth: vi.fn(async () => ({ ok: true })) }));
vi.mock('../../../lib/audit.js', () => ({ auditLog: vi.fn(async () => undefined) }));
vi.mock('../../../lib/build-context.js', () => ({
  buildContext: () => ({ userId: 'admin', userRole: 'SUPER_ADMIN', ipAddress: '::1', userAgent: 'test', sessionId: 's' }),
}));

import alarmWebhookRoutes from '../routes.js';
import { auditLog } from '../../../lib/audit.js';

const reply = () => {
  const r: any = { statusCode: 200, body: undefined };
  r.code = (c: number) => { r.statusCode = c; return r; };
  r.send = (b?: unknown) => { r.body = b; return r; };
  return r;
};

describe('DELETE /:id — the count, the delete and the audit row are one transaction', () => {
  const routes: Array<{ method: string; url: string; handler: any }> = [];
  const app: any = {
    requirePermission: vi.fn(() => vi.fn()),
    log: { error: vi.fn(), warn: vi.fn() },
  };
  for (const m of ['get', 'post', 'put', 'delete']) {
    app[m] = (url: string, _opts: any, handler: any) => routes.push({ method: m, url, handler });
  }
  const route = () => routes.find((r) => r.method === 'delete' && r.url === '/:id')!;
  const req = () => ({ params: { id: 't-1' }, body: { reason: 'decommissioned' }, headers: {}, user: { sub: 'admin', role: 'SUPER_ADMIN' } });

  beforeEach(async () => {
    routes.length = 0;
    vi.clearAllMocks();
    prisma.alarmWebhookTarget.findUnique.mockResolvedValue({ id: 't-1', name: 'QC hooter', url: 'http://h/', method: 'POST', isActive: true });
    await alarmWebhookRoutes(app);
  });

  it('runs the count, the delete and the audit row inside $transaction', async () => {
    const tx = {
      alarmWebhookDelivery: { count: vi.fn(async () => 0) },
      alarmWebhookTarget: { delete: vi.fn(async () => ({})) },
    };
    prisma.$transaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(tx));
    const res = reply();
    await route().handler(req(), res);
    expect(res.statusCode).toBe(204);
    expect(tx.alarmWebhookDelivery.count).toHaveBeenCalledTimes(1);
    expect(tx.alarmWebhookTarget.delete).toHaveBeenCalledWith({ where: { id: 't-1' } });
    // The audit row is written with the transaction client, so a failed delete
    // and its audit row roll back together.
    expect(auditLog).toHaveBeenCalledTimes(1);
    expect((auditLog as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe(tx);
  });

  it('refuses 409 from the count, deleting nothing', async () => {
    const tx = {
      alarmWebhookDelivery: { count: vi.fn(async () => 3) },
      alarmWebhookTarget: { delete: vi.fn() },
    };
    prisma.$transaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(tx));
    const res = reply();
    await route().handler(req(), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe('TARGET_HAS_DELIVERIES');
    expect(res.body.message).toContain('3 delivery record');
    expect(tx.alarmWebhookTarget.delete).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });

  // The race: the count said 0, a delivery landed, the FK refused the delete.
  it("answers the foreign key's refusal (P2003) as the same 409, not a 500", async () => {
    prisma.$transaction.mockRejectedValue(Object.assign(new Error('Foreign key constraint failed'), { code: 'P2003' }));
    prisma.alarmWebhookDelivery.count.mockResolvedValue(1);
    const res = reply();
    await route().handler(req(), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe('TARGET_HAS_DELIVERIES');
    expect(res.body.message).toContain('1 delivery record');
  });

  it('lets any other transaction failure propagate to the error handler', async () => {
    prisma.$transaction.mockRejectedValue(Object.assign(new Error('connection lost'), { code: 'P1001' }));
    await expect(route().handler(req(), reply())).rejects.toThrow('connection lost');
  });
});
