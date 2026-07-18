import type { RequestContext } from '../../../types/context.js';
import { auditLog } from '../../../lib/audit.js';
import { NotFoundError, ValidationError, ConflictError } from '../../../lib/errors.js';
import { identifierRepository } from '../repositories/identifier.repository.js';
import { instanceRepository } from '../repositories/instance.repository.js';
import { prisma } from '../../../lib/prisma.js';

export const identifierService = {
  async list(query: { assetId?: string; type?: string }) {
    const where: Record<string, unknown> = {};
    if (query.assetId) where.assetId = query.assetId;
    if (query.type) where.identifierType = query.type;
    return identifierRepository.findMany(where);
  },

  async lookupByValue(value: string) {
    const identifier = await identifierRepository.findByValue(value);
    if (!identifier) throw new NotFoundError('Identifier not found');
    return identifier;
  },

  async create(data: { assetId: string; identifierType: string; identifierValue: string; label?: string; isPrimary?: boolean }, ctx: RequestContext) {
    const asset = await instanceRepository.findByIdSimple(data.assetId);
    if (!asset) throw new ValidationError('Entity instance not found');

    // Only one identifier per entity
    const existingForAsset = await identifierRepository.findMany({ assetId: data.assetId });
    if (existingForAsset.length > 0) throw new ConflictError('This entity already has an identifier. Remove the existing one first.', 'ENTITY_HAS_IDENTIFIER');

    const existingIdent = await identifierRepository.findByIdentifierValue(data.identifierValue);
    if (existingIdent) throw new ConflictError('Identifier value already exists on another entity', 'DUPLICATE_IDENTIFIER_VALUE');

    const identifier = await identifierRepository.create({
      assetId: data.assetId,
      identifierType: data.identifierType,
      identifierValue: data.identifierValue,
      label: data.label,
      isPrimary: data.isPrimary,
      createdBy: ctx.userId,
    });

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'ASSET_IDENTIFIER_CREATED',
      targetType: 'asset_identifier',
      targetId: identifier.id,
      // Store the filter name alongside the identifier so the audit row is
      // self-describing (targetId is the identifier UUID, not the filter, so the
      // audit UI cannot resolve the filter name at render time). identifierValue
      // is already on `identifier` — the template renders it as the RFID tag.
      afterValue: { ...identifier, filterName: asset.name },
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });

    return identifier;
  },

  async delete(id: string, ctx: RequestContext, reason?: string | null) {
    const existing = await identifierRepository.findById(id);
    if (!existing) throw new NotFoundError('Identifier not found');

    // Resolve the filter name for a self-describing audit row (targetId is the
    // identifier UUID, so the audit UI can't look up the filter at render time).
    const asset = await instanceRepository.findByIdSimple(existing.assetId);

    await identifierRepository.delete(id);

    // P4 (2026-06-03): capture an optional removal reason so the RFID Track
    // Record report can show WHY a tag was removed (audit_trail.reason).
    const trimmedReason = typeof reason === 'string' ? reason.trim() : '';

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'ASSET_IDENTIFIER_DELETED',
      targetType: 'asset_identifier',
      targetId: id,
      beforeValue: {
        assetId: existing.assetId,
        identifierType: existing.identifierType,
        identifierValue: existing.identifierValue,
        filterName: asset?.name ?? null,
      },
      afterValue: { deleted: true },
      reason: trimmedReason || undefined,
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });
  },

  /**
   * P4 (2026-06-03): RFID Track Record — full lifecycle history of RFID tags,
   * reconstructed from audit_trail (ASSET_IDENTIFIER_CREATED = assign,
   * ASSET_IDENTIFIER_DELETED = remove). Each row is one assign/remove event with
   * RFID number, filter + AHU, the acting user, timestamp, and (for removals) a
   * reason. The flat time-ordered list IS the assignment / removal / reassignment
   * timeline. Filters: date range, RFID, filter name, AHU, user. RFID-type only.
   */
  async getRfidTrackRecord(query: {
    from?: string; to?: string; rfid?: string; filterName?: string; ahu?: string; user?: string;
    page?: number; limit?: number;
  }) {
    const where: any = { action: { in: ['ASSET_IDENTIFIER_CREATED', 'ASSET_IDENTIFIER_DELETED'] } };
    if (query.from || query.to) {
      where.timestamp = {};
      if (query.from) where.timestamp.gte = new Date(query.from);
      if (query.to) where.timestamp.lte = new Date(query.to);
    }
    const rows = await prisma.auditTrail.findMany({ where, orderBy: { timestamp: 'desc' } });

    const events = rows.map((r) => {
      const isAssign = r.action === 'ASSET_IDENTIFIER_CREATED';
      const v = ((isAssign ? r.afterValue : r.beforeValue) as any) ?? {};
      return {
        timestamp: r.timestamp,
        event: isAssign ? 'ASSIGN' : 'REMOVE',
        rfidNumber: v.identifierValue ?? null,
        identifierType: v.identifierType ?? null,
        assetId: v.assetId ?? null,
        reason: r.reason ?? null,
        userId: r.userId ?? null,
        userName: r.userName ?? null,
      };
    }).filter((e) => e.identifierType === 'RFID' && e.rfidNumber);

    // Resolve filter + AHU (parent) names and acting-user display names.
    const assetIds = [...new Set(events.map((e) => e.assetId).filter(Boolean))] as string[];
    const filters = assetIds.length
      ? await prisma.assetInstance.findMany({ where: { id: { in: assetIds } }, select: { id: true, name: true, parentId: true } })
      : [];
    const fmap = new Map(filters.map((f) => [f.id, f]));
    const parentIds = [...new Set(filters.map((f) => f.parentId).filter(Boolean))] as string[];
    const parents = parentIds.length
      ? await prisma.assetInstance.findMany({ where: { id: { in: parentIds } }, select: { id: true, name: true } })
      : [];
    const pmap = new Map(parents.map((p) => [p.id, p.name]));
    // audit_trail.userId is varchar(100) — historically it can hold a UUID OR a
    // bare username/'SYSTEM'. Only query User by the UUID-shaped ones (User.id is
    // a uuid column; passing a non-UUID throws); non-UUID ids fall back to the
    // raw value (already a display name) below.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const userIds = [...new Set(events.map((e) => e.userId).filter(Boolean))] as string[];
    const uuidUserIds = userIds.filter((u) => UUID_RE.test(u));
    const users = uuidUserIds.length
      ? await prisma.user.findMany({ where: { id: { in: uuidUserIds } }, select: { id: true, username: true, fullName: true } })
      : [];
    // Show the user ID (username), not the full name, as the performer.
    const umap = new Map(users.map((u) => [u.id, u.username]));

    let enriched = events.map((e) => {
      const f = e.assetId ? fmap.get(e.assetId) : null;
      return {
        timestamp: e.timestamp,
        event: e.event,
        rfidNumber: e.rfidNumber as string,
        filterName: f?.name ?? null,
        ahuName: f?.parentId ? (pmap.get(f.parentId) ?? null) : null,
        user: e.userName || (e.userId ? (umap.get(e.userId) ?? e.userId) : null),
        reason: e.reason,
      };
    });

    const lc = (s?: string | null) => (s ?? '').toLowerCase();
    if (query.rfid) enriched = enriched.filter((e) => lc(e.rfidNumber).includes(query.rfid!.toLowerCase()));
    if (query.filterName) enriched = enriched.filter((e) => lc(e.filterName).includes(query.filterName!.toLowerCase()));
    if (query.ahu) enriched = enriched.filter((e) => lc(e.ahuName).includes(query.ahu!.toLowerCase()));
    if (query.user) enriched = enriched.filter((e) => lc(e.user).includes(query.user!.toLowerCase()));

    const total = enriched.length;
    const page = query.page ?? 1;
    // 2026-07-03: RFID identifier list uncapped per user request. An omitted
    // limit returns ALL rows; a provided value still paginates the in-memory set.
    const limit = query.limit;
    const data = limit ? enriched.slice((page - 1) * limit, (page - 1) * limit + limit) : enriched;
    return { data, total, page, limit: limit ?? total, totalPages: limit ? Math.ceil(total / limit) : 1 };
  },
};
