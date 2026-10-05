import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { buildApp, loginAs, authGet, authPost, authDelete, ADMIN_PASSWORD } from './test-helper.js';
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

  // ── Delete single audit record ───────────────────────────────────────
  // Physical hard-delete (AUDIT_DELETE), re-added 2026-07-01. The endpoint
  // itself disables the audit_trail_no_delete immutability trigger for the
  // scope of its transaction (query pg_trigger → DISABLE → delete → ENABLE),
  // so a DB with the trigger present (baseline/test) still deletes cleanly.
  // A `reason` (>= 5 chars) is REQUIRED by the body schema. NOTE: these tests
  // physically delete rows, breaking the hash chain in the test DB by design.

  describe('DELETE /api/audit/:id', () => {
    it('deletes a single audit record', async () => {
      const list = await fetchAuditRecords(10);
      if (list.data.length === 0) return;

      const targetId = list.data[list.data.length - 1].id;
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
      const list = await fetchAuditRecords(10);
      if (list.data.length === 0) return;
      const targetId = list.data[list.data.length - 1].id;
      const res = await authDelete(app, `/api/audit/${targetId}`, adminToken, ADMIN_PASSWORD);
      expect(res.statusCode).toBe(400);
    });
  });

  // ── Bulk delete audit records ──────────────────────────────────────

  describe('POST /api/audit/bulk-delete', () => {
    it('deletes multiple audit records', async () => {
      const list = await fetchAuditRecords(10);
      if (list.data.length < 2) return;

      const ids = list.data.slice(-2).map((r) => r.id);
      const res = await authPost(app, '/api/audit/bulk-delete', adminToken, { ids, reason: 'e2e bulk hard-delete' }, ADMIN_PASSWORD);

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(typeof body.count).toBe('number');
      expect(body.count).toBeGreaterThanOrEqual(1);

      for (const id of ids) {
        const verifyRes = await authGet(app, `/api/audit/${id}`, adminToken);
        expect(verifyRes.statusCode).toBe(404);
      }
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
