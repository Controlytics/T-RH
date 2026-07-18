import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { buildApp, loginAs, authGet, ADMIN_PASSWORD } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { auditLog } from '../lib/audit.js';

/**
 * Read-side enrichment: replacement-schedule workflow audit rows written before
 * the 2026-07-18 descriptor fix stored only the comment/remarks in afterValue —
 * no AHU/filter name. GET /api/audit resolves the entry at read time and stamps
 * a titled `name` (+ structured fields) WITHOUT mutating the stored row, so the
 * hash chain still verifies. This proves an "old" row renders the AHU detail.
 */
describe('replacement-schedule audit read-side enrichment', () => {
  let app: FastifyInstance;
  let token: string;
  let scheduleId: string;
  let entryId: string;

  beforeAll(async () => {
    app = await buildApp();
    token = await loginAs(app, 'admin', ADMIN_PASSWORD);

    const sch = await prisma.replacementSchedule.create({
      data: { fileName: 'legacy.xlsx', status: 'ACTIVE', uploadedBy: randomUUID(), uploadedByName: 'admin' },
    });
    scheduleId = sch.id;
    const today = new Date();
    const entry = await prisma.replacementScheduleEntry.create({
      data: {
        scheduleId: sch.id, slNo: 1, ahuId: randomUUID(), ahuName: 'AHU-0A',
        filterMicron: '20', filterSize: '100x110x120', qty: 4,
        scheduleDate: today, toleranceDays: 7, windowStart: today, windowEnd: today,
        status: 'PENDING', approvalStatus: 'APPROVED',
      },
    });
    entryId = entry.id;

    // Simulate a pre-fix audit row: afterValue carries ONLY the comment, no name.
    await auditLog({
      userId: 'EMP-124', userRole: 'SUPER_ADMIN',
      action: 'REPLACEMENT_SCHEDULE_APPROVED',
      targetType: 'replacement_schedule_entry', targetId: entry.id,
      afterValue: { comment: 'legacy approval' },
    });
  });

  afterAll(async () => {
    await prisma.replacementScheduleEntry.deleteMany({ where: { scheduleId } }).catch(() => {});
    await prisma.replacementSchedule.delete({ where: { id: scheduleId } }).catch(() => {});
    await app.close();
  });

  it('stamps a titled name + structured fields onto the old row, chain still valid', async () => {
    const res = await authGet(app, `/api/audit?targetId=${entryId}&limit=50`, token);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const row = body.data.find((r: any) => r.action === 'REPLACEMENT_SCHEDULE_APPROVED' && r.targetId === entryId);
    expect(row).toBeTruthy();

    // Enriched for display — the summary's {targetName} now resolves.
    expect(row.afterValue.name).toBe('AHU: AHU-0A · Size: 100x110x120 · Micron: 20µ · Qty: 4');
    expect(row.afterValue.ahuName).toBe('AHU-0A');
    expect(row.afterValue.filterSize).toBe('100x110x120');
    expect(row.afterValue.filterMicron).toBe('20');
    expect(row.afterValue.qty).toBe(4);
    // Original comment preserved.
    expect(row.afterValue.comment).toBe('legacy approval');
    // Enrichment is non-destructive: checksum verifies against the STORED row.
    expect(row.integrityValid).toBe(true);
  });
});
