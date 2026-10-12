import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { buildApp, loginAs, authGet, authPost, authPut, authDelete, ADMIN_PASSWORD } from './test-helper.js';
import { prisma } from '../lib/prisma.js';

describe('Audit Trail endpoints', () => {
  let app: FastifyInstance;
  let adminToken: string;

  /** Fetch the current audit list and return the parsed body. */
  async function fetchAuditRecords(limit = 20) {
    const res = await authGet(app, `/api/audit?limit=${limit}`, adminToken);
    return JSON.parse(res.body) as {
      data: Array<{ id: number }>;
      total: number;
      page: number;
    };
  }

  beforeAll(async () => {
    app = await buildApp();
    adminToken = await loginAs(app);
  });

  afterAll(async () => {
    await app.close();
  });

  // ── Existing tests ────────────────────────────────────────────────────

  describe('GET /api/audit', () => {
    it('returns paginated audit entries', async () => {
      const res = await authGet(app, '/api/audit', adminToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data).toBeDefined();
      expect(body.total).toBeDefined();
      expect(body.page).toBeDefined();
    });

    it('supports search filter', async () => {
      const res = await authGet(app, '/api/audit?search=LOGIN', adminToken);
      expect(res.statusCode).toBe(200);
    });

    it('supports period filter', async () => {
      const res = await authGet(app, '/api/audit?period=today', adminToken);
      expect(res.statusCode).toBe(200);
    });

    /**
     * Audit 2026-10-03, API-12. `new Date('yesterday')` used to reach Prisma
     * as Invalid Date: a 500 plus a SYSTEM_ERROR notification to every admin,
     * for a typo. Now a field-keyed 400, as the alarms list already answered.
     */
    it('answers 400 by field for an unparseable startDate / endDate, never 500', async () => {
      const res = await authGet(app, '/api/audit?startDate=yesterday&endDate=nope', adminToken);
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('VALIDATION_ERROR');
      expect(Object.keys(body.details.fieldErrors).sort()).toEqual(['endDate', 'startDate']);
    });

    it('answers 400 for a reversed range', async () => {
      const res = await authGet(app, '/api/audit?startDate=2026-10-06&endDate=2026-10-05', adminToken);
      expect(res.statusCode).toBe(400);
    });

    it('answers 400, not 500, for a bad enum in the query (safeParse, not parse)', async () => {
      const res = await authGet(app, '/api/audit?period=fortnight', adminToken);
      expect(res.statusCode).toBe(400);
    });

    // A date-only endDate means the END of that day: the login that opened
    // this suite wrote a row today, and `startDate=today&endDate=today` must
    // find it — `lte: midnight` used to exclude the whole day asked for.
    it('a date-only endDate covers the whole of that day', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const res = await authGet(app, `/api/audit?startDate=${today}&endDate=${today}&limit=1`, adminToken);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).total).toBeGreaterThan(0);
    });

    // M72 (2026-07-15): 3 rows in the live trail were redacted, but the UI showed
    // them as ordinary records. The handler spread the fields off the row all
    // along — Fastify stripped them, because a field absent from the response
    // schema never reaches the client. So this asserts the KEY is present, which
    // is exactly what the schema controls; a redacted row's values were verified
    // against the live trail. Read-only by design: a real redaction is
    // irreversible, so the guard must not need to create one.
    it('serializes the redaction fields rather than stripping them', async () => {
      const res = await authGet(app, '/api/audit?limit=1', adminToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const row = body.data[0];
      expect(row).toBeDefined();

      // toHaveProperty, not truthiness: an un-redacted row's value IS null. The
      // bug was the key going missing entirely.
      expect(row).toHaveProperty('redactedAt');
      expect(row).toHaveProperty('redactedBy');
      expect(row).toHaveProperty('redactedByName');
      expect(row).toHaveProperty('redactionReason');
    });
  });

  describe('GET /api/audit/:id', () => {
    // Same schema-strip guard as the list route — the detail modal is the other
    // surface an inspector reads a redaction from.
    it('serializes the redaction fields rather than stripping them', async () => {
      const listRes = await authGet(app, '/api/audit?limit=1', adminToken);
      const list = JSON.parse(listRes.body);
      if (!list.data?.length) return;

      const res = await authGet(app, `/api/audit/${list.data[0].id}`, adminToken);
      expect(res.statusCode).toBe(200);
      const record = JSON.parse(res.body);

      expect(record).toHaveProperty('redactedAt');
      expect(record).toHaveProperty('redactedBy');
      expect(record).toHaveProperty('redactedByName');
      expect(record).toHaveProperty('redactionReason');
    });

    it('returns a specific audit entry with integrity check', async () => {
      // First get the list
      const listRes = await authGet(app, '/api/audit?limit=1', adminToken);
      const list = JSON.parse(listRes.body);

      if (list.data && list.data.length > 0) {
        const entryId = list.data[0].id;
        const res = await authGet(app, `/api/audit/${entryId}`, adminToken);
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.id).toBe(entryId);
        expect(body.integrityValid).toBeDefined();
      }
    });

    it('returns 404 for non-existent entry', async () => {
      // AuditTrail.id is a UUID. Using a syntactically valid UUID that
      // won't collide with a real row exercises the 404 path; numeric
      // strings make Prisma throw a UUID parse error → 500.
      const res = await authGet(app, '/api/audit/00000000-0000-0000-0000-000000000000', adminToken);
      expect(res.statusCode).toBe(404);
    });

    // Audit 2026-10-03, API-14: a SYSTEM row (no actor) stores NULL in
    // user_id / user_role. The list declared them nullable; the detail did
    // not, so the same row read `null` in the table and `""` in the inspector.
    it('serialises a SYSTEM row\'s null userId / userRole as null, not ""', async () => {
      // The public admin-request form writes a SYSTEM row (API-6).
      const sub = await app.inject({
        method: 'POST', url: '/api/admin-requests',
        payload: { requestType: 'UNLOCK', requesterName: 'Nullable Probe', requesterEmployeeId: `np-${Date.now()}`, requestData: {} },
      });
      expect(sub.statusCode).toBe(201);
      const requestId = JSON.parse(sub.body).requestId as string;
      try {
        const row = await prisma.auditTrail.findFirst({ where: { action: 'ADMIN_REQUEST_SUBMITTED', targetId: requestId } });
        expect(row).not.toBeNull();
        const res = await authGet(app, `/api/audit/${row!.id}`, adminToken);
        expect(res.statusCode).toBe(200);
        const detail = JSON.parse(res.body);
        expect(detail).toHaveProperty('userId');
        expect(detail.userId).toBeNull();
        expect(detail.userRole).toBeNull();
      } finally {
        await prisma.adminRequest.deleteMany({ where: { id: requestId } });
      }
    });
  });

  // ── Redaction (API-13 / DATA-13) ─────────────────────────────────────
  // Redaction is irreversible, so these use the OLDEST rows of the test
  // trail, as the hard-delete tests below do.

  describe('POST /api/audit/:id/redact', () => {
    it('redacts once; a second redaction is 409 and the FIRST redactor\'s reason survives', async () => {
      const list = await fetchAuditRecords(20);
      // An un-redacted row, oldest first.
      const rows = (list.data as any[]).filter((r) => !r.redactedAt).reverse();
      if (rows.length === 0) return;
      const targetId = rows[0].id as string;

      const first = await authPost(app, `/api/audit/${targetId}/redact`, adminToken, { reason: 'e2e first redaction' }, ADMIN_PASSWORD);
      expect(first.statusCode).toBe(200);

      // Audit 2026-10-03, API-13: the decision is the UPDATE's own predicate
      // (`AND redacted_at IS NULL`). Mutation check: drop the predicate and
      // the second call overwrites the reason below and answers 200.
      const second = await authPost(app, `/api/audit/${targetId}/redact`, adminToken, { reason: 'e2e SECOND redaction' }, ADMIN_PASSWORD);
      expect(second.statusCode).toBe(409);
      expect(JSON.parse(second.body).error).toBe('ALREADY_REDACTED');

      const detail = JSON.parse((await authGet(app, `/api/audit/${targetId}`, adminToken)).body);
      expect(detail.redactionReason).toBe('e2e first redaction');
      // DATA-13: `redacted_by` is the USERNAME, the identity every other
      // audit column carries — not the UUID.
      expect(detail.redactedBy).toBe('admin');
      expect(detail.redactedByName).toBe('admin');
      // Exactly one meta row for one redaction.
      expect(await prisma.auditTrail.count({ where: { action: 'AUDIT_RECORD_REDACTED', targetId } })).toBe(1);
    });
  });

  describe('POST /api/audit/bulk-redact', () => {
    it('redacts the selected rows; a repeat is 409 and writes no second meta row', async () => {
      const list = await fetchAuditRecords(30);
      const rows = (list.data as any[]).filter((r) => !r.redactedAt).reverse();
      if (rows.length < 2) return;
      const ids = rows.slice(0, 2).map((r) => r.id as string);

      const metaBefore = await prisma.auditTrail.count({ where: { action: 'AUDIT_RECORDS_BULK_REDACTED' } });
      const first = await authPost(app, '/api/audit/bulk-redact', adminToken, { ids, reason: 'e2e bulk redaction' }, ADMIN_PASSWORD);
      expect(first.statusCode).toBe(200);
      expect(JSON.parse(first.body).count).toBe(2);

      const second = await authPost(app, '/api/audit/bulk-redact', adminToken, { ids, reason: 'e2e bulk AGAIN' }, ADMIN_PASSWORD);
      expect(second.statusCode).toBe(409);

      for (const id of ids) {
        const detail = JSON.parse((await authGet(app, `/api/audit/${id}`, adminToken)).body);
        expect(detail.redactionReason).toBe('e2e bulk redaction');
        expect(detail.redactedBy).toBe('admin');
      }
      expect(await prisma.auditTrail.count({ where: { action: 'AUDIT_RECORDS_BULK_REDACTED' } })).toBe(metaBefore + 1);
    });
  });

  // ── Hard delete (AUDIT_DELETE) ──────────────────────────────────────
  // Physical hard-delete, re-added 2026-07-01. Since 2026-10-12 it is the
  // Configuration toggle "Audit Hard Delete" (`audit-hard-delete.enabled`),
  // DEFAULT OFF — the AUDIT_HARD_DELETE_ENABLED env var is no longer read. The
  // toggle is switched on for the delete tests and the original row is put
  // back FIRST in afterAll. Each test deletes rows it CREATED: picking "the
  // oldest of the newest ten" could pick a deletion's own meta row, which is
  // never deletable (audit 2026-10-12 #6). NOTE: these tests physically delete
  // rows, breaking the hash chain in the test DB by design.

  describe('hard delete', () => {
    const KEY = 'audit-hard-delete';
    let original: { configValue: unknown; configType: string; requiresReauth: boolean } | null = null;
    const setToggle = (enabled: unknown) => prisma.systemConfig.upsert({
      where: { configKey: KEY },
      update: { configValue: { enabled } as never },
      create: { configKey: KEY, configValue: { enabled } as never, configType: 'security', requiresReauth: false },
    });
    /** A throwaway audit row to delete, returned by id. */
    async function scratchRow(tag: string): Promise<string> {
      const { auditLog } = await import('../lib/audit.js');
      const targetId = `hard-delete-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await auditLog({ userId: 'admin', userRole: 'SUPER_ADMIN', action: 'CONFIG_CHANGED', targetType: 'e2e-hard-delete', targetId });
      return (await prisma.auditTrail.findFirstOrThrow({ where: { targetId }, select: { id: true } })).id;
    }

    beforeAll(async () => {
      const row = await prisma.systemConfig.findUnique({ where: { configKey: KEY } });
      original = row ? { configValue: row.configValue, configType: row.configType, requiresReauth: row.requiresReauth } : null;
    });
    afterAll(async () => {
      try {
        if (original) await prisma.systemConfig.update({ where: { configKey: KEY }, data: original as never });
        else await prisma.systemConfig.deleteMany({ where: { configKey: KEY } });
      } catch (e) { console.error('audit-hard-delete restore failed', e); }
    });

    describe('the toggle', () => {
      it('ships OFF: a fresh install seeds { enabled: false } and both routes answer 403, naming the toggle', async () => {
        const { auditHardDeleteDef } = await import('../modules/config/defs/audit-hard-delete.def.js');
        expect(auditHardDeleteDef.settings.find((s) => s.key === 'enabled')?.default).toBe(false);
        await setToggle(false);
        const id = await scratchRow('off');
        const one = await authDelete(app, `/api/audit/${id}`, adminToken, ADMIN_PASSWORD, { reason: 'e2e toggle off probe' });
        expect(one.statusCode).toBe(403);
        expect(one.json().error).toBe('AUDIT_HARD_DELETE_DISABLED');
        expect(one.json().message).toMatch(/Configuration → Audit Hard Delete/);
        const bulk = await authPost(app, '/api/audit/bulk-delete', adminToken, { ids: [id], reason: 'e2e toggle off probe' }, ADMIN_PASSWORD);
        expect(bulk.statusCode).toBe(403);
        expect(await prisma.auditTrail.count({ where: { id } })).toBe(1);
      });

      it('an absent row is OFF too', async () => {
        await prisma.systemConfig.deleteMany({ where: { configKey: KEY } });
        const id = await scratchRow('absent');
        const res = await authDelete(app, `/api/audit/${id}`, adminToken, ADMIN_PASSWORD, { reason: 'e2e toggle absent probe' });
        expect(res.statusCode).toBe(403);
      });

      it('is switched through the generic dynamic PUT, SUPER_ADMIN-only, writing CONFIG_CHANGED', async () => {
        const res = await authPut(app, `/api/config/dynamic/${KEY}`, adminToken, { enabled: true }, ADMIN_PASSWORD);
        expect(res.statusCode).toBe(200);
        const row = await prisma.systemConfig.findUnique({ where: { configKey: KEY } });
        expect(row?.configValue).toEqual({ enabled: true });
        const audit = await prisma.auditTrail.findFirst({ where: { action: 'CONFIG_CHANGED', targetId: KEY }, orderBy: { chainPosition: 'desc' } });
        expect(audit?.afterValue).toEqual({ enabled: true });
        // A non-boolean is refused, not stored.
        const bad = await authPut(app, `/api/config/dynamic/${KEY}`, adminToken, { enabled: 'yes' }, ADMIN_PASSWORD);
        expect(bad.statusCode).toBe(400);
      });
    });

    describe('DELETE /api/audit/:id', () => {
      beforeAll(async () => { await setToggle(true); });

      it('deletes a single audit record', async () => {
        const targetId = await scratchRow('single');
        const res = await authDelete(app, `/api/audit/${targetId}`, adminToken, ADMIN_PASSWORD, { reason: 'e2e hard-delete test' });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.success).toBe(true);

        const verifyRes = await authGet(app, `/api/audit/${targetId}`, adminToken);
        expect(verifyRes.statusCode).toBe(404);
      });

      it('returns 404 for a non-existent audit record', async () => {
        const res = await authDelete(app, '/api/audit/00000000-0000-0000-0000-000000000000', adminToken, ADMIN_PASSWORD, { reason: 'e2e non-existent probe' });
        expect(res.statusCode).toBe(404);
      });

      it('rejects a missing reason (schema requires reason)', async () => {
        const targetId = await scratchRow('noreason');
        const res = await authDelete(app, `/api/audit/${targetId}`, adminToken, ADMIN_PASSWORD);
        expect(res.statusCode).toBe(400);
      });

      // Audit 2026-10-12 #6: delete a row, then try to delete the
      // AUDIT_RECORD_DELETED row that records it — the evidence must survive.
      it('refuses to delete the record of a deletion, and of a redaction (409), even for SUPER_ADMIN', async () => {
        const victim = await scratchRow('victim');
        expect((await authDelete(app, `/api/audit/${victim}`, adminToken, ADMIN_PASSWORD, { reason: 'e2e first deletion' })).statusCode).toBe(200);
        const meta = await prisma.auditTrail.findFirstOrThrow({ where: { action: 'AUDIT_RECORD_DELETED', targetId: victim } });
        const res = await authDelete(app, `/api/audit/${meta.id}`, adminToken, ADMIN_PASSWORD, { reason: 'e2e erase the evidence' });
        expect(res.statusCode).toBe(409);
        expect(res.json().error).toBe('PROTECTED_AUDIT_RECORD');
        expect(await prisma.auditTrail.count({ where: { id: meta.id } })).toBe(1);

        const redactMe = await scratchRow('redact');
        expect((await authPost(app, `/api/audit/${redactMe}/redact`, adminToken, { reason: 'e2e redaction' }, ADMIN_PASSWORD)).statusCode).toBe(200);
        const redactMeta = await prisma.auditTrail.findFirstOrThrow({ where: { action: 'AUDIT_RECORD_REDACTED', targetId: redactMe } });
        const r2 = await authDelete(app, `/api/audit/${redactMeta.id}`, adminToken, ADMIN_PASSWORD, { reason: 'e2e erase the redaction record' });
        expect(r2.statusCode).toBe(409);
        expect(await prisma.auditTrail.count({ where: { id: redactMeta.id } })).toBe(1);
      });
    });

    // ── Bulk delete audit records ──────────────────────────────────────

    describe('POST /api/audit/bulk-delete', () => {
      beforeAll(async () => { await setToggle(true); });

      it('deletes multiple audit records', async () => {
        const ids = [await scratchRow('bulk-a'), await scratchRow('bulk-b')];
        const res = await authPost(app, '/api/audit/bulk-delete', adminToken, { ids, reason: 'e2e bulk hard-delete' }, ADMIN_PASSWORD);

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.success).toBe(true);
        expect(body.count).toBe(2);

        for (const id of ids) {
          const verifyRes = await authGet(app, `/api/audit/${id}`, adminToken);
          expect(verifyRes.statusCode).toBe(404);
        }
      });

      it('refuses the WHOLE request (409, nothing deleted) when it names the record of a deletion', async () => {
        const plain = await scratchRow('bulk-plain');
        const victim = await scratchRow('bulk-victim');
        expect((await authPost(app, '/api/audit/bulk-delete', adminToken, { ids: [victim], reason: 'e2e first bulk deletion' }, ADMIN_PASSWORD)).statusCode).toBe(200);
        const meta = await prisma.auditTrail.findFirstOrThrow({
          where: { action: 'AUDIT_RECORDS_BULK_DELETED', beforeValue: { path: ['records', '0', 'id'], equals: victim } },
        });
        const res = await authPost(app, '/api/audit/bulk-delete', adminToken, { ids: [plain, meta.id], reason: 'e2e erase the bulk evidence' }, ADMIN_PASSWORD);
        expect(res.statusCode).toBe(409);
        expect(res.json().error).toBe('PROTECTED_AUDIT_RECORD');
        expect(res.json().message).toContain(meta.id);
        expect(await prisma.auditTrail.count({ where: { id: { in: [plain, meta.id] } } })).toBe(2);
      });

      it('returns 404 when none of the IDs exist', async () => {
        // ids must be UUID strings (auditTrail.id is uuid). Numeric ids
        // cause the Fastify schema validator to 400 before the route runs.
        const res = await authPost(
          app,
          '/api/audit/bulk-delete',
          adminToken,
          { ids: ['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002'], reason: 'e2e no-match probe' },
          ADMIN_PASSWORD,
        );

        // No matching rows → NO_MATCHING_RECORDS
        expect(res.statusCode).toBe(404);
      });

      it('rejects an empty ids array', async () => {
        const res = await authPost(
          app,
          '/api/audit/bulk-delete',
          adminToken,
          { ids: [], reason: 'e2e empty probe' },
          ADMIN_PASSWORD,
        );
        // Schema requires minItems: 1 — Fastify should return 400
        expect(res.statusCode).toBe(400);
      });
    });
  });
});
