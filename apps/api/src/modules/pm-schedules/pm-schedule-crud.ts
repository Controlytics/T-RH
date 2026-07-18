/**
 * PM Schedules — top-level schedule CRUD: get-by-entity, create, update
 * (versioning), delete (with in-progress guard), and version history.
 */
import type { RequestContext } from '../../types/context.js';
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { checkPmEnabled } from './pm-shared.js';

export async function getByEntity(_ctx: RequestContext, entityId: string, year?: number) {
  await checkPmEnabled();
  const targetYear = year ?? new Date().getFullYear();

  const schedule = await prisma.pmSchedule.findFirst({
    where: { entityId, year: targetYear, status: 'ACTIVE' },
    include: {
      entries: {
        orderBy: { month: 'asc' },
        include: { executions: { orderBy: { createdAt: 'desc' }, take: 1 } },
      },
    },
    orderBy: { version: 'desc' },
  });

  if (!schedule) return null;

  return {
    ...schedule,
    entries: schedule.entries.map(e => ({
      ...e,
      execution: e.executions[0] ?? null,
    })),
  };
}

export async function create(ctx: RequestContext, data: any) {
  await checkPmEnabled();
  const { entityId, year, entries } = data;

  // Check for existing active schedule
  const existing = await prisma.pmSchedule.findFirst({
    where: { entityId, year, status: 'ACTIVE' },
  });
  if (existing) throw new AppError(409, 'CONFLICT', `Active PM schedule already exists for year ${year}`);

  const schedule = await prisma.pmSchedule.create({
    data: {
      entityId,
      year,
      status: 'ACTIVE',
      createdBy: ctx.userSub,
      entries: {
        create: entries.map((e: any) => ({
          month: e.month,
          plannedDate: new Date(e.plannedDate),
          toleranceDays: e.toleranceDays ?? 0,
          windowStart: new Date(new Date(e.plannedDate).getTime() - (e.toleranceDays ?? 0) * 86400000),
          windowEnd: new Date(new Date(e.plannedDate).getTime() + (e.toleranceDays ?? 0) * 86400000),
          notes: e.notes ?? null,
        })),
      },
    },
    include: { entries: { orderBy: { month: 'asc' } } },
  });

  await auditLog({
    userId: ctx.userId, userRole: ctx.userRole, action: 'CREATED',
    targetType: 'pm_schedule', targetId: schedule.id,
    afterValue: { entityId, year, entryCount: entries.length },
    ipAddress: ctx.ipAddress, userAgent: ctx.userAgent,
  });

  return schedule;
}

export async function update(ctx: RequestContext, id: string, data: any) {
  await checkPmEnabled();

  // Validate BEFORE any write: this is archive-then-recreate, so a late throw
  // would leave the old version ARCHIVED with no ACTIVE replacement and
  // silently stop PM task generation for the AHU/year.
  const entries = data.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Schedule must have at least one entry');
  }

  const existing = await prisma.pmSchedule.findUnique({
    where: { id },
    include: { entries: true },
  });
  if (!existing) throw new AppError(404, 'NOT_FOUND', 'PM schedule not found');

  // Archive + recreate atomically — a failure must not strand the schedule
  // with no ACTIVE version.
  const [, newSchedule] = await prisma.$transaction([
    prisma.pmSchedule.update({
      where: { id },
      data: { status: 'ARCHIVED' },
    }),
    prisma.pmSchedule.create({
      data: {
        entityId: existing.entityId,
        year: existing.year,
        version: existing.version + 1,
        status: 'ACTIVE',
        createdBy: ctx.userSub,
        entries: {
          create: entries.map((e: any) => ({
            month: e.month,
            plannedDate: new Date(e.plannedDate),
            toleranceDays: e.toleranceDays ?? 0,
            windowStart: new Date(new Date(e.plannedDate).getTime() - (e.toleranceDays ?? 0) * 86400000),
            windowEnd: new Date(new Date(e.plannedDate).getTime() + (e.toleranceDays ?? 0) * 86400000),
            notes: e.notes ?? null,
          })),
        },
      },
      include: { entries: { orderBy: { month: 'asc' } } },
    }),
  ]);

  await auditLog({
    userId: ctx.userId, userRole: ctx.userRole, action: 'UPDATED',
    targetType: 'pm_schedule', targetId: newSchedule.id,
    beforeValue: { version: existing.version },
    afterValue: { version: newSchedule.version },
    ipAddress: ctx.ipAddress, userAgent: ctx.userAgent,
  });

  return newSchedule;
}

export async function remove(ctx: RequestContext, id: string) {
  await checkPmEnabled();
  const existing = await prisma.pmSchedule.findUnique({
    where: { id },
    include: { entries: { include: { executions: true } } },
  });
  if (!existing) throw new AppError(404, 'NOT_FOUND', 'PM schedule not found');

  // Check if any executions are in progress
  const inProgress = existing.entries.some(e => e.executions.some(ex => ex.status === 'IN_PROGRESS'));
  if (inProgress) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Cannot delete: schedule has executions in progress');
  }

  // Delete executions, entries, then schedule
  await prisma.$transaction([
    prisma.pmExecution.deleteMany({ where: { scheduleEntryId: { in: existing.entries.map(e => e.id) } } }),
    prisma.pmScheduleEntry.deleteMany({ where: { scheduleId: id } }),
    prisma.pmSchedule.delete({ where: { id } }),
  ]);

  await auditLog({
    userId: ctx.userId, userRole: ctx.userRole, action: 'DELETED',
    targetType: 'pm_schedule', targetId: id,
    beforeValue: { entityId: existing.entityId, year: existing.year, version: existing.version },
    ipAddress: ctx.ipAddress, userAgent: ctx.userAgent,
  });

  return { success: true };
}

export async function getHistory(_ctx: RequestContext, entityId: string) {
  await checkPmEnabled();
  return prisma.pmSchedule.findMany({
    where: { entityId },
    orderBy: [{ year: 'desc' }, { version: 'desc' }],
    select: { id: true, year: true, version: true, status: true, createdAt: true },
  });
}
