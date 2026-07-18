import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../../../lib/prisma.js';
import { blockedFilterIdsForCleaning, isFilterBlockedForCleaning } from '../service.js';
import { randomUUID } from 'node:crypto';

const S = Date.now().toString(36).slice(-5);

// UTC date-only string offset from today by `days`.
function dayISO(days: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

describe('blockedFilterIdsForCleaning / isFilterBlockedForCleaning', () => {
  let ahuId = '';
  let filterTemplateId = '';
  const filterIds: string[] = [];
  let overdueEntryId = '';
  let dueEntryId = '';
  let ahuId2 = '';
  let newFilterId = '';

  beforeAll(async () => {
    // assetTemplate.templateKind FKs the TemplateKind lookup — ensure FILTER exists.
    await prisma.templateKind.upsert({ where: { code: 'FILTER' }, update: {}, create: { code: 'FILTER', label: 'Filter', isSystem: true } });
    filterTemplateId = (await prisma.assetTemplate.create({
      data: { name: `BF Tpl ${S}`, templateKind: 'FILTER' },
    })).id;
    // AHU must be a REAL AssetInstance: assetInstance.parentId is a self-FK with
    // onDelete:Restrict, so filters can only point at an existing instance. The
    // AHU rows have parentId=null, so activeFilterIdsByAhu (which selects
    // parentId IN ahuIds) never counts them — reusing the FILTER template for
    // them is harmless and avoids needing an 'AHU' TemplateKind.
    ahuId = (await prisma.assetInstance.create({ data: { name: `BF-AHU-${S}`, templateId: filterTemplateId } })).id;
    ahuId2 = (await prisma.assetInstance.create({ data: { name: `BF-AHU2-${S}`, templateId: filterTemplateId } })).id;
    // Two active filters under the overdue AHU.
    for (let i = 0; i < 2; i++) {
      const f = await prisma.assetInstance.create({
        data: { name: `BF-F${i}-${S}`, templateId: filterTemplateId, parentId: ahuId, isActive: true, status: 'Active' },
      });
      filterIds.push(f.id);
    }
    // A "new" replacement filter under the same AHU (already replaced → unblocked).
    newFilterId = (await prisma.assetInstance.create({
      data: { name: `BF-NEW-${S}`, templateId: filterTemplateId, parentId: ahuId, isActive: true, status: 'Active' },
    })).id;
    // One active filter under a DIFFERENT AHU whose entry is only DUE (not overdue).
    const f2 = await prisma.assetInstance.create({
      data: { name: `BF-DUE-${S}`, templateId: filterTemplateId, parentId: ahuId2, isActive: true, status: 'Active' },
    });
    filterIds.push(f2.id);

    const sch = await prisma.replacementSchedule.create({
      data: { fileName: `bf-${S}.xlsx`, status: 'ACTIVE', uploadedBy: randomUUID(), uploadedByName: 'bf-test' },
    });
    // Overdue: windowEnd in the past, qty not fully met.
    const overdue = await prisma.replacementScheduleEntry.create({
      data: {
        scheduleId: sch.id, ahuId, ahuName: `AHU-${S}`, qty: 2,
        scheduleDate: dayISO(-10), toleranceDays: 0, windowStart: dayISO(-10), windowEnd: dayISO(-5),
        approvalStatus: 'APPROVED',
      },
    });
    overdueEntryId = overdue.id;
    // Mark newFilterId as replaced under the overdue entry.
    await prisma.replacementExecution.create({
      data: { entryId: overdueEntryId, newFilterId, oldFilterId: filterIds[0], performedBy: randomUUID() },
    });
    // A DUE entry (window spans today) for the other AHU — must NOT block.
    const due = await prisma.replacementScheduleEntry.create({
      data: {
        scheduleId: sch.id, ahuId: ahuId2, ahuName: `AHU2-${S}`, qty: 1,
        scheduleDate: dayISO(0), toleranceDays: 2, windowStart: dayISO(-2), windowEnd: dayISO(2),
        approvalStatus: 'APPROVED',
      },
    });
    dueEntryId = due.id;
  }, 60_000);

  afterAll(async () => {
    await prisma.replacementExecution.deleteMany({ where: { entryId: { in: [overdueEntryId, dueEntryId] } } }).catch(() => {});
    await prisma.replacementScheduleEntry.deleteMany({ where: { id: { in: [overdueEntryId, dueEntryId] } } }).catch(() => {});
    await prisma.replacementSchedule.deleteMany({ where: { fileName: `bf-${S}.xlsx` } }).catch(() => {});
    // Children (filters) before parents (AHUs) — parentId FK is onDelete:Restrict.
    for (const id of [...filterIds, newFilterId]) await prisma.assetInstance.delete({ where: { id } }).catch(() => {});
    for (const id of [ahuId, ahuId2]) await prisma.assetInstance.delete({ where: { id } }).catch(() => {});
    await prisma.assetTemplate.delete({ where: { id: filterTemplateId } }).catch(() => {});
  }, 30_000);

  it('blocks the un-replaced filters under the overdue AHU', async () => {
    const blocked = await blockedFilterIdsForCleaning();
    expect(blocked.has(filterIds[0])).toBe(true);
    expect(blocked.has(filterIds[1])).toBe(true);
  });

  it('does NOT block the already-replaced (new) filter', async () => {
    const blocked = await blockedFilterIdsForCleaning();
    expect(blocked.has(newFilterId)).toBe(false);
  });

  it('does NOT block a filter whose entry is only DUE (within window)', async () => {
    const blocked = await blockedFilterIdsForCleaning();
    expect(blocked.has(filterIds[2])).toBe(false);
  });

  it('isFilterBlockedForCleaning agrees for a blocked and an unblocked filter', async () => {
    expect(await isFilterBlockedForCleaning(filterIds[0])).toBe(true);
    expect(await isFilterBlockedForCleaning(newFilterId)).toBe(false);
    expect(await isFilterBlockedForCleaning(filterIds[2])).toBe(false);
  });
});
