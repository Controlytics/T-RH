// Standalone Filter create — A-01 Tier 2. Writes the typed `filters` table
// directly (source of truth). NO validateParent, NO asset_relationships, NO
// asset-template attributeSchema. The reverse-mirror trigger keeps a legacy
// asset_instances row in sync for un-migrated readers.
import { randomUUID } from 'node:crypto';
import type { RequestContext } from '../../../types/context.js';
import { prisma } from '../../../lib/prisma.js';
import { auditLog } from '../../../lib/audit.js';
import { sanitizeAuditValue } from '../../../lib/audit-diff.js';
import { ConflictError, ValidationError } from '../../../lib/errors.js';
import { validateAndBuildFilterAttributes, FILTER_ATTRIBUTE_FIELDS, type FilterFieldInput } from './filter-fields.service.js';
import { identifierService } from './identifier.service.js';

export interface CreateFilterTypedInput extends FilterFieldInput {
  name: string;
  ahuId: string;
  filterSet?: 'A' | 'B';
  filterProfileId?: string;
  rfidTag?: string;
}

export const filterService = {
  async create(input: CreateFilterTypedInput, ctx: RequestContext) {
    const name = input.name?.trim();
    if (!name) throw new ValidationError('Filter Name is required');

    const ahu = await prisma.ahu.findUnique({ where: { id: input.ahuId }, select: { id: true } });
    if (!ahu) throw new ValidationError('AHU not found');

    const existing = await prisma.filter.findFirst({ where: { name: { equals: name, mode: 'insensitive' }, isActive: true }, select: { id: true } });
    if (existing) throw new ValidationError(`A filter with the name "${name}" already exists`);

    const { attributes, errors } = await validateAndBuildFilterAttributes(input);
    if (errors.length > 0) throw new ValidationError('One or more filter fields are invalid', errors as any);

    const filterSetEnum: 'SET_A' | 'SET_B' | undefined =
      input.filterSet === 'A' ? 'SET_A' : input.filterSet === 'B' ? 'SET_B' : undefined;

    const filter = await prisma.$transaction(async (tx) => {
      const f = await tx.filter.create({
        data: {
          // The typed `filters.id` column has no DB default (it was built for
          // the dual-write that always supplies the id). Generate it here so the
          // filter, its asset_instances mirror, FilterDetails, and RFID all share it.
          id: randomUUID(),
          ahuId: input.ahuId,
          name,
          status: 'Active',
          attributes: attributes as any,
          createdBy: ctx.userId,
        } as any,
      });
      // The reverse-mirror trigger has now created the asset_instances row
      // (same id) within this txn, so the FilterDetails FK resolves.
      await tx.filterDetails.create({
        data: {
          assetInstanceId: f.id,
          ...(filterSetEnum ? { filterSet: filterSetEnum } : {}),
          ...(input.filterProfileId ? { filterProfileId: input.filterProfileId } : {}),
        },
      });
      return f;
    });

    if (input.rfidTag) {
      await identifierService.create({ assetId: filter.id, identifierType: 'RFID', identifierValue: input.rfidTag, isPrimary: true }, ctx);
    }

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'ASSET_CREATED', targetType: 'asset_instance', targetId: filter.id,
      afterValue: { name, ahuId: input.ahuId, filterSet: filterSetEnum, kind: 'FILTER' },
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });

    return filter;
  },

  // Typed-direct update (A-01 T2.3). Writes the typed `filters` table + the
  // FilterDetails sidecar; the reverse-mirror trigger keeps asset_instances in
  // sync. No asset-template / attributeSchema. Field-option values are
  // re-validated against the live config and replace the attributes JSON.
  async update(id: string, input: FilterFieldInput & { name?: string; filterSet?: 'A' | 'B' }, ctx: RequestContext) {
    const existing = await prisma.filter.findUnique({ where: { id }, select: { name: true, attributes: true } });
    if (!existing) throw new ValidationError('Filter not found');
    const existingDetails = await prisma.filterDetails.findUnique({ where: { assetInstanceId: id }, select: { filterSet: true } });

    const data: Record<string, unknown> = { updatedBy: ctx.userId };
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw new ValidationError('Filter Name is required');
      const dupe = await prisma.filter.findFirst({ where: { name: { equals: name, mode: 'insensitive' }, isActive: true, id: { not: id } }, select: { id: true } });
      if (dupe) throw new ValidationError(`A filter with the name "${name}" already exists`);
      data.name = name;
    }

    const { attributes, errors } = await validateAndBuildFilterAttributes(input);
    if (errors.length > 0) throw new ValidationError('One or more filter fields are invalid', errors as any);

    // PARTIAL-UPDATE CONTRACT: an ABSENT field means "don't touch"; a field sent
    // EMPTY ('' / null) means "clear it". validateAndBuildFilterAttributes only
    // emits present, non-empty keys, so assigning its output straight onto
    // `data.attributes` wiped every field the caller didn't resend. The edit
    // dialog happens to resend the full set, but any other caller (script,
    // replay, a future partial-update client) silently destroyed regulated data
    // — ahuType / filterType / micronSize / filterSize / lastCleaningDate — and
    // the audit row recorded the wipe as an intentional change. Overlay onto the
    // stored attributes and drop ONLY the fields explicitly sent empty.
    const merged: Record<string, unknown> = { ...((existing.attributes as Record<string, unknown> | null) ?? {}), ...attributes };
    for (const field of FILTER_ATTRIBUTE_FIELDS) {
      if (!(field in input)) continue;
      const raw = (input as Record<string, unknown>)[field];
      // Blank-is-clear mirrors the builder, which treats a blank field as absent.
      if (raw === null || raw === undefined || raw.toString().trim() === '') delete merged[field];
    }
    data.attributes = merged;

    const filterSetEnum: 'SET_A' | 'SET_B' | undefined =
      input.filterSet === 'A' ? 'SET_A' : input.filterSet === 'B' ? 'SET_B' : undefined;

    const updated = await prisma.$transaction(async (tx) => {
      const f = await tx.filter.update({ where: { id }, data: data as any });
      if (filterSetEnum) {
        await tx.filterDetails.upsert({
          where: { assetInstanceId: id },
          create: { assetInstanceId: id, filterSet: filterSetEnum },
          update: { filterSet: filterSetEnum },
        });
      }
      return f;
    });

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'ASSET_UPDATED', targetType: 'asset_instance', targetId: id,
      beforeValue: sanitizeAuditValue({ name: existing.name, filterSet: existingDetails?.filterSet, attributes: existing.attributes, templateKind: 'FILTER' }),
      // `merged`, not `attributes` — the latter holds only the keys this call
      // supplied, so it would under-report the record's post-update state.
      afterValue: sanitizeAuditValue({ name: data.name ?? existing.name, filterSet: filterSetEnum ?? existingDetails?.filterSet, attributes: merged, templateKind: 'FILTER' }),
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });
    return updated;
  },

  // Typed-direct soft delete (A-01 T2.3). Sets filters.isActive=false; the
  // reverse-mirror trigger flips asset_instances.isActive=false too. Cascades
  // the RFID identifiers like the legacy instance.service.softDelete does.
  async softDelete(id: string, ctx: RequestContext) {
    const existing = await prisma.filter.findUnique({ where: { id }, select: { id: true, name: true } });
    if (!existing) throw new ValidationError('Filter not found');

    // A soft-deleted filter is hidden from every operating surface, so nothing
    // can advance or terminate its cycle — deleting mid-cycle stranded the
    // CleaningCycle IN_PROGRESS forever. Refuse instead of auto-terminating:
    // delete carries no remarks, and retire() is the audited, remarked
    // end-of-life path that terminates the cycle with a stamped reason. An
    // unremarked cycle termination is not a §11 record we should manufacture.
    // Gate on the cycle's STATUS, not merely a non-null pointer — a stale
    // pointer at a finished cycle must not block the delete.
    const details = await prisma.filterDetails.findUnique({ where: { assetInstanceId: id }, select: { currentCycleId: true } });
    if (details?.currentCycleId) {
      const activeCycle = await prisma.cleaningCycle.findFirst({
        where: { id: details.currentCycleId, status: 'IN_PROGRESS' },
        select: { cycleCode: true },
      });
      if (activeCycle) {
        throw new ConflictError(
          `Cannot delete "${existing.name}": cleaning cycle ${activeCycle.cycleCode} is still in progress. Complete or terminate the cycle first, or retire the filter instead.`,
          'FILTER_CYCLE_IN_PROGRESS',
        );
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      const f = await tx.filter.update({ where: { id }, data: { isActive: false, updatedBy: ctx.userId } as any });

      // The identifier cascade is a physical delete, and the RFID Track Record
      // report (identifier.service.getRfidTrackRecord) is built EXCLUSIVELY from
      // ASSET_IDENTIFIER_CREATED / _DELETED audit rows. Without a _DELETED row per
      // identifier the report shows a dangling ASSIGN, and re-assigning the freed
      // tag yields two consecutive ASSIGNs with no REMOVE between them. Leaving the
      // rows behind also kept the tag bound to a hidden filter, so it could never be
      // re-used on the replacement filter. beforeValue shape MUST match
      // identifier.service.delete()'s — the report reads identifierType +
      // identifierValue + assetId off it.
      const cascadedIdentifiers = await tx.assetIdentifier.findMany({ where: { assetId: id } });
      await tx.assetIdentifier.deleteMany({ where: { assetId: id } });
      // In-tx: the identifier rows are destroyed here, so the audit must commit
      // or roll back with the delete that destroys them.
      for (const ident of cascadedIdentifiers) {
        await auditLog({
          userId: ctx.userId, userRole: ctx.userRole,
          action: 'ASSET_IDENTIFIER_DELETED',
          targetType: 'asset_identifier', targetId: ident.id,
          beforeValue: {
            assetId: ident.assetId,
            identifierType: ident.identifierType,
            identifierValue: ident.identifierValue,
            filterName: existing.name,
          },
          afterValue: { deleted: true },
          reason: `Cascade: Filter "${existing.name}" deleted`,
          signatureMeaning: `Identifier "${ident.identifierValue}" removed from "${existing.name}" by cascade delete`,
          ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
        }, tx);
      }
      return f;
    });

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'ASSET_DELETED', targetType: 'asset_instance', targetId: id,
      beforeValue: { name: existing.name }, afterValue: { isActive: false, templateKind: 'FILTER' },
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });
    return updated;
  },
};
