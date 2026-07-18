/**
 * Equipment Groups Service — CRUD for equipment groups with 3 instruments per group.
 * Each group belongs to a Block and contains:
 *   1. Compressed Air Pressure (WASH_IN)
 *   2. RO Water Pressure (WASH_IN)
 *   3. Dryer Temperature (DRY_IN)
 *
 * Phase A.4 versioning (2026-05-02): every mutation is a snapshot-then-bump.
 * Before applying any change we write the OUTGOING composite (group + all 3
 * instruments, ordered by sortOrder) into `EquipmentGroupVersion.snapshot`,
 * then bump `EquipmentGroup.version`. Cycles do NOT pin a group version —
 * operational drift is already covered by `FilterEvent.attributes
 * .instrumentReadings`, which immutably records description / instrumentCode
 * / uom / leastCount / value at submit time. Versions exist purely for
 * admin-edit history and audit replay.
 */
import type { RequestContext } from '../../types/context.js';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { sanitizeStrings } from '../../lib/sanitize.js';
import { fetchReadingObject, type ReadingObjectResult } from './instrument-fetch.js';

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * Snapshot the current group + instruments composite into the versions table,
 * then bump the live version pointer. Caller is expected to be inside a
 * transaction and is responsible for the actual mutation that follows.
 * Mirrors the A.1 ChecklistProfile / A.3 FilterProfile pattern.
 */
async function snapshotAndBump(
  tx: Tx,
  groupId: string,
  changeNotes: string | null,
  ctx: RequestContext,
): Promise<void> {
  const group = await tx.equipmentGroup.findUnique({
    where: { id: groupId },
    include: { instruments: { orderBy: { sortOrder: 'asc' } } },
  });
  if (!group) throw new AppError(404, 'NOT_FOUND', 'Equipment group not found');
  await tx.equipmentGroupVersion.create({
    data: {
      groupId,
      versionNumber: group.version,
      snapshot: {
        name: group.name,
        blockId: group.blockId,
        isActive: group.isActive,
        readingUrl: group.readingUrl ?? null,
        instruments: group.instruments.map((i: any) => ({
          id: i.id,
          description: i.description,
          stageKey: i.stageKey,
          serialNumber: i.serialNumber,
          instrumentId: i.instrumentId,
          uom: i.uom,
          instrumentMin: i.instrumentMin,
          instrumentMax: i.instrumentMax,
          operatingMin: i.operatingMin,
          operatingMax: i.operatingMax,
          leastCount: i.leastCount,
          responseKey: i.responseKey ?? null,
          autoFetchEnabled: i.autoFetchEnabled ?? false,
          sortOrder: i.sortOrder,
        })),
      } as Prisma.InputJsonValue,
      changeNotes,
      createdBy: ctx.userSub,
    },
  });
  await tx.equipmentGroup.update({
    where: { id: groupId },
    data: { version: { increment: 1 } },
  });
}

const INSTRUMENT_DESCRIPTIONS = [
  { description: 'Compressed Air Pressure', stageKey: 'WASH_IN', sortOrder: 1 },
  { description: 'RO Water Pressure', stageKey: 'WASH_IN', sortOrder: 2 },
  { description: 'Dryer Temperature', stageKey: 'DRY_IN', sortOrder: 3 },
] as const;

function validateInstrument(inst: any, idx: number) {
  const prefix = `Instrument ${idx + 1} (${INSTRUMENT_DESCRIPTIONS[idx].description})`;
  if (!inst.instrumentId || !inst.instrumentId.trim()) {
    throw new AppError(400, 'VALIDATION', `${prefix}: Instrument ID is required`);
  }
  if (!inst.uom || !inst.uom.trim()) {
    throw new AppError(400, 'VALIDATION', `${prefix}: UOM is required`);
  }
  if (inst.leastCount <= 0) {
    throw new AppError(400, 'VALIDATION', `${prefix}: Least Count must be greater than 0`);
  }
  if (inst.instrumentMin >= inst.instrumentMax) {
    throw new AppError(400, 'VALIDATION', `${prefix}: Instrument Min must be less than Max`);
  }
  if (inst.operatingMin < inst.instrumentMin || inst.operatingMin > inst.instrumentMax) {
    throw new AppError(400, 'VALIDATION', `${prefix}: Operating Min must be within Instrument range (${inst.instrumentMin}–${inst.instrumentMax})`);
  }
  if (inst.operatingMax < inst.instrumentMin || inst.operatingMax > inst.instrumentMax) {
    throw new AppError(400, 'VALIDATION', `${prefix}: Operating Max must be within Instrument range (${inst.instrumentMin}–${inst.instrumentMax})`);
  }
  if (inst.operatingMin >= inst.operatingMax) {
    throw new AppError(400, 'VALIDATION', `${prefix}: Operating Min must be less than Operating Max`);
  }
}

/**
 * Auto-fetch (2026-06-13): the group has ONE reading endpoint. Validate its URL
 * shape here; host-level SSRF checks happen in the proxy at fetch time. Returns
 * the trimmed URL (or null when blank = auto-fetch off).
 */
function normalizeReadingUrl(raw: unknown): string | null {
  const url = typeof raw === 'string' ? raw.trim() : '';
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AppError(400, 'VALIDATION', 'Reading URL is not a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError(400, 'VALIDATION', 'Reading URL must use http or https');
  }
  return url;
}

export class EquipmentGroupsService {
  async list(_ctx: RequestContext, blockId?: string, includeInactive = false) {
    // Config UI passes includeInactive=true so admins can see + re-enable
    // disabled groups; the cleaning runtime keeps the default (active only).
    const where: any = includeInactive ? {} : { isActive: true };
    if (blockId) where.blockId = blockId;

    return prisma.equipmentGroup.findMany({
      where,
      include: { instruments: { orderBy: { sortOrder: 'asc' } }, block: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getById(_ctx: RequestContext, id: string) {
    const group = await prisma.equipmentGroup.findFirst({
      where: { id },
      include: { instruments: { orderBy: { sortOrder: 'asc' } }, block: { select: { id: true, name: true } } },
    });
    if (!group) throw new AppError(404, 'NOT_FOUND', 'Equipment group not found');
    return group;
  }

  async getByBlock(_ctx: RequestContext, blockId: string) {
    return prisma.equipmentGroup.findMany({
      where: { blockId, isActive: true },
      include: { instruments: { orderBy: { sortOrder: 'asc' } } },
      orderBy: { name: 'asc' },
    });
  }

  async create(ctx: RequestContext, data: any) {
    const sanitized = sanitizeStrings(data);
    const { name, blockId, instruments } = sanitized;
    const readingUrl = normalizeReadingUrl(sanitized.readingUrl);

    if (!name?.trim()) throw new AppError(400, 'VALIDATION', 'Group name is required');
    if (!blockId) throw new AppError(400, 'VALIDATION', 'Block ID is required');

    // Verify block exists
    const block = await prisma.assetInstance.findFirst({ where: { id: blockId } });
    if (!block) throw new AppError(404, 'NOT_FOUND', 'Block not found');

    if (!instruments || !Array.isArray(instruments) || instruments.length !== 3) {
      throw new AppError(400, 'VALIDATION', 'Exactly 3 instruments are required');
    }

    // Validate each instrument
    instruments.forEach((inst: any, idx: number) => validateInstrument(inst, idx));

    // 2026-07-16: a block may now have MULTIPLE active equipment groups. The old
    // single-active-group invariant (create INACTIVE when the block already had
    // an active group, then flip via setActive) is gone along with the
    // Enable/Disable toggle. Every group is created active and stays available;
    // the operator picks which group to record against per cleaning (the
    // equipment dialog's group picker), and the cleaning runtime's
    // assertSingleEquipmentGroupPerBlock remains only as a "select one" safety
    // net for an unbound cycle that submits readings without choosing.
    const group = await prisma.$transaction(async (tx) => {
      const created = await tx.equipmentGroup.create({
        data: {
          name: name.trim(),
          blockId,
          isActive: true,
          readingUrl,
          createdBy: ctx.userSub,
        },
      });

      for (let i = 0; i < 3; i++) {
        const inst = instruments[i];
        const def = INSTRUMENT_DESCRIPTIONS[i];
        const responseKey = typeof inst.responseKey === 'string' ? inst.responseKey.trim() : '';
        await tx.equipmentGroupInstrument.create({
          data: {
            groupId: created.id,
            description: def.description,
            stageKey: def.stageKey,
            serialNumber: inst.serialNumber?.trim() ?? '',
            instrumentId: inst.instrumentId.trim(),
            uom: inst.uom.trim(),
            instrumentMin: inst.instrumentMin,
            instrumentMax: inst.instrumentMax,
            operatingMin: inst.operatingMin,
            operatingMax: inst.operatingMax,
            leastCount: inst.leastCount,
            responseKey: responseKey || null,
            // Auto-fetch iff the group has a reading URL AND this instrument has a key.
            autoFetchEnabled: !!(readingUrl && responseKey),
            sortOrder: def.sortOrder,
          },
        });
      }

      return tx.equipmentGroup.findUnique({
        where: { id: created.id },
        include: { instruments: { orderBy: { sortOrder: 'asc' } } },
      });
    });

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole, action: 'EQUIPMENT_GROUP_CREATED',
      targetType: 'equipment_group', targetId: group!.id,
      afterValue: { name, blockId },
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent,
    });

    return group;
  }

  async update(ctx: RequestContext, id: string, data: any) {
    const sanitized = sanitizeStrings(data);
    const { name, instruments } = sanitized;
    const readingUrl = normalizeReadingUrl(sanitized.readingUrl);

    const existing = await prisma.equipmentGroup.findFirst({
      where: { id },
      include: { instruments: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!existing) throw new AppError(404, 'NOT_FOUND', 'Equipment group not found');

    if (!instruments || !Array.isArray(instruments) || instruments.length !== 3) {
      throw new AppError(400, 'VALIDATION', 'Exactly 3 instruments are required');
    }

    instruments.forEach((inst: any, idx: number) => validateInstrument(inst, idx));

    const group = await prisma.$transaction(async (tx) => {
      // Phase A.4: snapshot-then-bump. Freeze the OUTGOING composite (group +
      // 3 instruments, ordered by sortOrder) into the versions table BEFORE
      // mutating anything live, then bump version on the live group row.
      await snapshotAndBump(tx, id, data.changeNotes ?? null, ctx);

      // Update the group's name + reading URL (one endpoint for all instruments).
      await tx.equipmentGroup.update({
        where: { id },
        data: { ...(name && name.trim() !== existing.name ? { name: name.trim() } : {}), readingUrl },
      });

      // Update each instrument
      for (let i = 0; i < 3; i++) {
        const inst = instruments[i];
        const existingInst = existing.instruments[i];
        if (existingInst) {
          const responseKey = typeof inst.responseKey === 'string' ? inst.responseKey.trim() : '';
          await tx.equipmentGroupInstrument.update({
            where: { id: existingInst.id },
            data: {
              serialNumber: inst.serialNumber?.trim() ?? '',
              instrumentId: inst.instrumentId.trim(),
              uom: inst.uom.trim(),
              instrumentMin: inst.instrumentMin,
              instrumentMax: inst.instrumentMax,
              operatingMin: inst.operatingMin,
              operatingMax: inst.operatingMax,
              leastCount: inst.leastCount,
              responseKey: responseKey || null,
              autoFetchEnabled: !!(readingUrl && responseKey),
            },
          });
        }
      }

      return tx.equipmentGroup.findUnique({
        where: { id },
        include: { instruments: { orderBy: { sortOrder: 'asc' } } },
      });
    });

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole, action: 'EQUIPMENT_GROUP_UPDATED',
      targetType: 'equipment_group', targetId: id,
      beforeValue: { name: existing.name, version: existing.version },
      afterValue: { name: name?.trim() ?? existing.name, version: (group?.version ?? existing.version + 1) },
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent,
    });

    return group;
  }

  /**
   * Lock every group in a block for the rest of the transaction. The
   * "block keeps at least one active group" invariant spans rows, so it cannot
   * be expressed in a single-row WHERE. Under READ COMMITTED two concurrent
   * deactivations of different groups in one block would each see the other
   * still active and both proceed, landing the block on zero. Locking the whole
   * block serializes them.
   */
  private async lockBlockGroups(tx: any, blockId: string) {
    await tx.$queryRaw`SELECT id FROM equipment_groups WHERE block_id = ${blockId}::uuid FOR UPDATE`;
  }

  /**
   * Guards the isActive=false mutation that BOTH `delete()` (a soft delete) and
   * `setActive(ctx, id, false)` perform. Must run inside `tx`, after
   * lockBlockGroups().
   */
  private async assertSafeToDeactivate(tx: any, group: { id: string; blockId: string; isActive: boolean }, verb: string) {
    const activeCycles = await tx.cleaningCycle.count({
      where: { equipmentGroupId: group.id, status: 'IN_PROGRESS' },
    });
    if (activeCycles > 0) {
      throw new AppError(409, 'IN_USE', `Cannot ${verb}: equipment group is used by active cleaning cycles`);
    }

    // Already inactive — deactivating again changes nothing to protect.
    if (!group.isActive) return;

    // Cycles that never bound a group resolve one from the block's ACTIVE groups
    // at advance() time. ZERO active is the only breaking count: advance's
    // assertSingleEquipmentGroupPerBlock rejects only >1, and a lone remaining
    // group simply binds — so dropping a block from 2 groups to 1 is safe (it is
    // how an operator legitimately switches groups). Dropping it to zero strands
    // those cycles on NO_EQUIPMENT_GROUP, an error that surfaces far from here.
    const remainingActive = await tx.equipmentGroup.count({
      where: { blockId: group.blockId, isActive: true, id: { not: group.id } },
    });
    if (remainingActive > 0) return;

    const unboundCycles = await tx.cleaningCycle.count({
      where: { cleaningAreaId: group.blockId, equipmentGroupId: null, status: 'IN_PROGRESS' },
    });
    if (unboundCycles > 0) {
      throw new AppError(
        409,
        'IN_USE',
        `Cannot ${verb}: this is the last active equipment group for this block and ${unboundCycles} in-progress cycle(s) have not yet bound a group — they would be unable to advance.`,
      );
    }
  }

  // 2026-07-16: `setActive()` (the Enable/Disable toggle) removed. A block may
  // now have multiple active equipment groups; there is no enable/disable — the
  // only removal path is `delete()` (soft-delete, which keeps the shared
  // `assertSafeToDeactivate` last-active-group guard below). Config resolution
  // per cleaning is the operator's dialog choice, not an active-group flip.

  /**
   * List archived versions of an equipment group, newest first. The current
   * live composite is NOT in the versions table (versions only contains
   * pre-mutation snapshots), so the response is the history strictly BEFORE
   * the current version pointer.
   */
  async getVersions(_ctx: RequestContext, groupId: string) {
    const group = await prisma.equipmentGroup.findUnique({
      where: { id: groupId },
      select: { id: true, version: true },
    });
    if (!group) throw new AppError(404, 'NOT_FOUND', 'Equipment group not found');
    const versions = await prisma.equipmentGroupVersion.findMany({
      where: { groupId },
      orderBy: { versionNumber: 'desc' },
      select: { id: true, versionNumber: true, changeNotes: true, createdAt: true, createdBy: true },
    });
    return { groupId, currentVersion: group.version, versions };
  }

  /**
   * Read a frozen historical version. Returns the snapshot exactly as it was
   * when that version was archived (group + 3 instruments composite).
   */
  async getVersion(_ctx: RequestContext, groupId: string, versionNumber: number) {
    const v = await prisma.equipmentGroupVersion.findUnique({
      where: { groupId_versionNumber: { groupId, versionNumber } },
    });
    if (!v) throw new AppError(404, 'NOT_FOUND', `Version ${versionNumber} of equipment group ${groupId} not found`);
    return {
      groupId: v.groupId,
      versionNumber: v.versionNumber,
      ...(v.snapshot as any),
      createdAt: v.createdAt,
      createdBy: v.createdBy,
      changeNotes: v.changeNotes,
    };
  }

  /**
   * Resolve the stage's instruments for a cycle, READ-ONLY, mirroring the
   * precedence in advance.ts (cycle pin → block's single active group → live),
   * but WITHOUT persisting a lazy-bind pin — this is a preview, not a write.
   * Returns the instruments (from the frozen snapshot when pinned, else live)
   * for `stageKey`, ordered by sortOrder. Old snapshots lack url/autoFetchEnabled
   * → those come back undefined and are treated as auto-fetch OFF downstream.
   */
  private async resolveStageContext(
    cycle: { equipmentGroupId: string | null; equipmentGroupVersionPin: number | null; cleaningAreaId: string | null },
    stageKey: string,
  ): Promise<{ readingUrl: string | null; instruments: any[] }> {
    let groupId = cycle.equipmentGroupId;
    let pin = cycle.equipmentGroupVersionPin;
    if (!groupId && cycle.cleaningAreaId) {
      const blockGroups = await prisma.equipmentGroup.findMany({
        where: { blockId: cycle.cleaningAreaId, isActive: true },
        select: { id: true, version: true },
      });
      if (blockGroups.length === 1) {
        groupId = blockGroups[0].id;
        pin = blockGroups[0].version;
      }
    }
    if (!groupId) return { readingUrl: null, instruments: [] };

    const fromLive = async () => {
      const g = await prisma.equipmentGroup.findUnique({
        where: { id: groupId! },
        include: { instruments: { orderBy: { sortOrder: 'asc' } } },
      });
      return { readingUrl: g?.readingUrl ?? null, instruments: g?.instruments ?? [] };
    };

    let readingUrl: string | null;
    let instruments: any[];
    if (pin !== null) {
      const versionRow = await prisma.equipmentGroupVersion.findUnique({
        where: { groupId_versionNumber: { groupId, versionNumber: pin } },
      });
      if (versionRow) {
        const snap = versionRow.snapshot as any;
        readingUrl = snap?.readingUrl ?? null;
        instruments = (snap?.instruments ?? []) as any[];
      } else {
        ({ readingUrl, instruments } = await fromLive());
      }
    } else {
      ({ readingUrl, instruments } = await fromLive());
    }
    return {
      readingUrl,
      instruments: instruments
        .filter((i) => i.stageKey === stageKey)
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)),
    };
  }

  /**
   * Server-proxied "Get Values": for a filter's in-progress cycle and a given
   * stage (WASH_IN / DRY_IN), fetch the group's ONE reading endpoint and extract
   * each auto-fetch instrument's value by its responseKey. Read-only. Returns one
   * result per auto instrument; the client owns the retry loop. Manual
   * instruments (no key) are omitted.
   */
  async fetchStageReadings(_ctx: RequestContext, filterId: string | undefined, stageKey: string, groupId?: string) {
    if (stageKey !== 'WASH_IN' && stageKey !== 'DRY_IN') {
      throw new AppError(400, 'VALIDATION', 'stageKey must be WASH_IN or DRY_IN');
    }

    // Primary: resolve via the filter's in-progress cycle (pinned snapshot).
    let ctx: { readingUrl: string | null; instruments: any[] } = { readingUrl: null, instruments: [] };
    if (filterId) {
      const fd = await prisma.filterDetails.findUnique({
        where: { assetInstanceId: filterId },
        select: { currentCycleId: true },
      });
      if (fd?.currentCycleId) {
        const cycle = await prisma.cleaningCycle.findUnique({
          where: { id: fd.currentCycleId },
          select: { id: true, equipmentGroupId: true, equipmentGroupVersionPin: true, cleaningAreaId: true, status: true },
        });
        if (cycle && cycle.status === 'IN_PROGRESS') {
          ctx = await this.resolveStageContext(cycle, stageKey);
        }
      }
    }

    // Fallback (cycle-start: no cycle yet) — use the dialog's explicit group's
    // LIVE config. The client only ever sends ids; the URL is resolved here.
    if (ctx.instruments.length === 0 && groupId) {
      const g = await prisma.equipmentGroup.findUnique({
        where: { id: groupId },
        include: { instruments: { orderBy: { sortOrder: 'asc' } } },
      });
      ctx = { readingUrl: g?.readingUrl ?? null, instruments: (g?.instruments ?? []).filter((i) => i.stageKey === stageKey) };
    }

    const auto = ctx.instruments.filter((i) => i.autoFetchEnabled === true && i.responseKey);
    if (auto.length === 0) return { stageKey, results: [] };

    // ONE fetch for the whole group; distribute values by responseKey.
    const fetched: ReadingObjectResult = ctx.readingUrl
      ? await fetchReadingObject(ctx.readingUrl)
      : { ok: false, error: 'No reading URL configured' };

    const results = auto.map((inst) => {
      const base = { instrumentId: inst.id, instrumentCode: inst.instrumentId, description: inst.description, uom: inst.uom };
      if (!fetched.ok) return { ...base, ok: false, error: fetched.error };
      const value = fetched.reading[inst.responseKey];
      if (typeof value !== 'number') return { ...base, ok: false, error: `Key "${inst.responseKey}" not found in response` };
      return { ...base, ok: true, value, fetchedAt: fetched.fetchedAt };
    });
    return { stageKey, results };
  }

  /**
   * Admin "Get Latest Values" on the config editor — fetch a typed (possibly
   * unsaved) reading URL through the same SSRF-hardened path and return the whole
   * reading object so the page can map each instrument's key. EG_EDIT gated.
   */
  async testUrl(_ctx: RequestContext, url: string) {
    return fetchReadingObject(url);
  }

  async delete(ctx: RequestContext, id: string) {
    const existing = await prisma.equipmentGroup.findFirst({
      where: { id },
    });
    if (!existing) throw new AppError(404, 'NOT_FOUND', 'Equipment group not found');

    // Soft delete == deactivate, so it takes the identical guard as
    // setActive(false) — including the block-fallback check, which delete() also
    // lacked (its cycle check only ever saw PINNED cycles, which are immune).
    await prisma.$transaction(async (tx) => {
      await this.lockBlockGroups(tx, existing.blockId);
      await this.assertSafeToDeactivate(tx, existing, 'delete');
      await tx.equipmentGroup.update({
        where: { id },
        data: { isActive: false },
      });
    });

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole, action: 'EQUIPMENT_GROUP_DELETED',
      targetType: 'equipment_group', targetId: id,
      afterValue: { name: existing.name },
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent,
    });

    return { success: true };
  }
}
