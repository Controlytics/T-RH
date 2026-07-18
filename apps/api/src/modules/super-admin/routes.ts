import { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { enforceReauth, enforceReauthAlways } from '../../lib/reauth-check.js';
import { readSuperAdminApiEnabledUncached, setSuperAdminApiEnabled } from '../../lib/super-admin-lock.js';
import { auditLog } from '../../lib/audit.js';
import { computeChecksum } from '../filter-operations/helpers.js';

/**
 * Super Admin routes â€” SUPER_ADMIN only, platform management
 * Prefix: /api/super-admin
 *
 * 2026-05-26 audit fix (PA-REAUTH-3): every mutation (PUT/POST/DELETE)
 * under this module silently edits cleaning cycles / filter events /
 * notifications / admin requests / block-change requests / PM entries
 * with NO AUDIT TRAIL (per the doc comments below). Pre-fix there was
 * also no reauth â€” a compromised SUPER_ADMIN session could erase the
 * chain-of-custody for cleaning records with a single click. The
 * `requireDataEditReauth` preHandler below now enforces a password
 * step on every mutation; pair with the existing requireRole gate.
 *
 * This is bare-minimum hardening. A proper audit-trail retrofit (so
 * even SUPER_ADMIN data edits leave a record visible to SUPER_ADMIN)
 * is tracked separately â€” adding it here would require a service-layer
 * audit-log emit on each handler.
 */
async function requireDataEditReauth(req: FastifyRequest, reply: FastifyReply) {
  const { ok } = await enforceReauth('SUPER_ADMIN_DATA_EDIT', req, reply);
  if (!ok) {
    // enforceReauth has already sent the 401 response â€” Fastify stops
    // the preHandler chain on send. Returning is sufficient.
    return;
  }
}

export default async function superAdminRoutes(app: FastifyInstance) {

  // â”€â”€â”€ PLATFORM STATS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.get('/stats', {
    preHandler: [app.requireRole('SUPER_ADMIN')],
    schema: {
      tags: ['Super Admin'],
      summary: 'Platform-wide statistics',
    },
  }, async () => {
    const [userCount, entityCount] = await Promise.all([
      prisma.user.count(),
      prisma.assetInstance.count({ where: { isActive: true } }),
    ]);
    // devices: 0 retained for response-shape backward compat (UI may still read it).
    return { users: userCount, devices: 0, entities: entityCount };
  });

  // ─── SUPER ADMIN API KILL-SWITCH ──────────────────────────────────
  // Global ON/OFF for "everything the SUPER_ADMIN can do". When OFF, the
  // auth plugin (plugins/auth.ts) freezes every SUPER_ADMIN request except a
  // tiny allowlist that INCLUDES these two endpoints — so the switch can
  // always be read and flipped back ON. Login is public and also unaffected.
  // Enforcement lives in auth.ts; these endpoints just persist/read the flag.

  app.get('/api-lock', {
    preHandler: [app.requireRole('SUPER_ADMIN')],
    schema: {
      tags: ['Super Admin'],
      summary: 'Read the Super Admin API access switch (true = APIs enabled)',
    },
  }, async () => {
    const enabled = await readSuperAdminApiEnabledUncached();
    return { enabled };
  });

  app.put('/api-lock', {
    // requireRole keeps this SUPER_ADMIN-only; enforceReauthAlways forces a
    // password step on every flip (this is a security control — see the
    // "Yes, require password" decision). Both must pass before we persist.
    preHandler: [app.requireRole('SUPER_ADMIN')],
    schema: {
      tags: ['Super Admin'],
      summary: 'Enable/disable Super Admin API access (password required)',
      body: {
        type: 'object',
        required: ['enabled'],
        properties: {
          enabled: { type: 'boolean' },
          _currentPassword: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauthAlways('TOGGLE_SUPER_ADMIN_API_ACCESS', req, reply);
    if (!ok) return; // enforceReauthAlways already sent 401

    const { enabled } = req.body as { enabled: boolean };
    const before = await readSuperAdminApiEnabledUncached();
    await setSuperAdminApiEnabled(enabled, req.user.sub);

    await auditLog({
      userId: req.user.sub,
      userName: req.user.username,
      userRole: req.user.role,
      action: 'SUPER_ADMIN_API_ACCESS_CHANGED',
      targetType: 'config',
      targetId: 'super-admin-api-access',
      beforeValue: { enabled: before },
      afterValue: { enabled },
      signatureMeaning: `Super Admin API access ${enabled ? 'ENABLED' : 'DISABLED'}`,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      sessionId: req.user.sessionId,
    });

    return { enabled };
  });

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // FILTER DATA MANAGEMENT â€” SUPER_ADMIN ONLY, NO AUDIT TRAIL
  // Allows silent editing of retirement and replacement records, and
  // restoring a retired filter. These operations leave no trace in the
  // application — but they never destroy audit_trail rows.
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  // â”€â”€â”€ Edit a retired filter's fields â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.put('/filter-data/retirements/:id', {
    preHandler: [app.requireRole('SUPER_ADMIN'), requireDataEditReauth],
    schema: {
      tags: ['Super Admin'],
      summary: 'Edit retired filter record (no audit trail)',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          attributes: { type: 'object' },
          filterSet: { type: 'string', enum: ['SET_A', 'SET_B', ''] },
          updatedAt: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as any;
    const filter = await prisma.assetInstance.findFirst({ where: { id, status: 'Retired' } });
    if (!filter) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Retired filter not found' });

    const data: any = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.attributes !== undefined) data.attributes = body.attributes;
    if (body.updatedAt !== undefined) data.updatedAt = new Date(body.updatedAt);

    // filterSet now lives on FilterDetails (Step 6) â€” route to the sidecar.
    if (body.filterSet !== undefined) {
      await prisma.filterDetails.upsert({
        where: { assetInstanceId: id },
        update: { filterSet: body.filterSet || null },
        create: { assetInstanceId: id, filterSet: body.filterSet || null },
      });
    }
    const updated = Object.keys(data).length > 0
      ? await prisma.assetInstance.update({ where: { id }, data })
      : await prisma.assetInstance.findUnique({ where: { id } });
    return updated;
  });

  // DELETE /filter-data/retirements/:id and DELETE /filter-data/replacements/:id
  // were removed 2026-07-15. Both destroyed audit_trail rows (FILTER_RETIRED /
  // FILTER_REPLACED), which the audit_trail_no_delete trigger rejects — they
  // could never succeed and only ever raised a 500. Audit rows are immutable
  // per 21 CFR Â§11.10(e); the REDACT path (audit/routes.ts) is the supported
  // way to neutralise a row while preserving the hash chain.

  // â”€â”€â”€ Unretire a filter (restore to Active) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.post('/filter-data/retirements/:id/unretire', {
    preHandler: [app.requireRole('SUPER_ADMIN'), requireDataEditReauth],
    schema: {
      tags: ['Super Admin'],
      summary: 'Unretire a filter â€” restore to Active status (no audit trail)',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        properties: {
          parentId: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as any;
    const filter = await prisma.assetInstance.findFirst({ where: { id, status: 'Retired' } });
    if (!filter) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Retired filter not found' });

    // Everything below reads/resolves BEFORE the transaction opens, so a bad
    // input can't leave half the destruction applied.
    const customAttrs = (filter.customAttributes as any) ?? {};
    let restoreParentId = body.parentId || customAttrs._preRetireParentId || null;

    // The FILTER_RETIRED / FILTER_REPLACED audit rows are left intact — they are
    // the Â§11 record of what happened, and audit_trail is delete-protected.
    const replacementAudit = await prisma.auditTrail.findFirst({
      where: { action: 'FILTER_REPLACED', targetId: id },
      select: { afterValue: true },
      orderBy: { timestamp: 'desc' },
    });
    const replacedById = ((replacementAudit?.afterValue as any) ?? {}).newFilterId ?? null;

    // Resolve the replacement filter once: it supplies the parent fallback (the
    // new filter inherited it) and tells us whether there's anything to clean up
    // â€” it may already be gone from an earlier unretire.
    let replacementFilterId: string | null = null;
    if (replacedById) {
      const newFilter = await prisma.assetInstance.findUnique({
        where: { id: replacedById },
        select: { id: true, parentId: true },
      });
      if (newFilter) {
        replacementFilterId = newFilter.id;
        if (!restoreParentId && newFilter.parentId) restoreParentId = newFilter.parentId;
      }
    }

    // Clean up the saved pre-retirement data from customAttributes
    const cleanedCustom = { ...customAttrs };
    delete cleanedCustom._preRetireParentId;

    await prisma.$transaction(async (tx) => {
      await tx.assetInstance.update({
        where: { id },
        data: {
          status: 'Active',
          isActive: true,
          parentId: restoreParentId,
          customAttributes: cleanedCustom,
        },
      });
      // currentLifecycleState moved to FilterDetails (Step 6).
      await tx.filterDetails.upsert({
        where: { assetInstanceId: id },
        update: { currentLifecycleState: null },
        create: { assetInstanceId: id, currentLifecycleState: null },
      });

      // Restore parent relationship
      if (restoreParentId) {
        await tx.assetRelationship.createMany({
          data: [
            { sourceAssetId: restoreParentId, targetAssetId: id, relationshipType: 'CONTAINS' },
            { sourceAssetId: id, targetAssetId: restoreParentId, relationshipType: 'CONTAINED_IN' },
          ],
          skipDuplicates: true,
        });
      }

      // If this filter was replaced, delete the replacement filter and all its traces
      if (replacementFilterId) {
        await tx.assetRelationship.deleteMany({
          where: { OR: [{ sourceAssetId: replacementFilterId }, { targetAssetId: replacementFilterId }] },
        });
        await tx.assetIdentifier.deleteMany({ where: { assetId: replacementFilterId } });
        await tx.filterEvent.deleteMany({ where: { filterId: replacementFilterId } });
        await tx.cleaningCycle.deleteMany({ where: { filterId: replacementFilterId } });
        // Clear currentCycleId if set (FilterDetails â€” Step 6).
        await tx.filterDetails.updateMany({ where: { assetInstanceId: replacementFilterId }, data: { currentCycleId: null } });
        await tx.assetInstance.delete({ where: { id: replacementFilterId } });
      }
    });

    return { success: true };
  });

  // â”€â”€â”€ Edit a replacement record â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.put('/filter-data/replacements/:id', {
    preHandler: [app.requireRole('SUPER_ADMIN'), requireDataEditReauth],
    schema: {
      tags: ['Super Admin'],
      summary: 'Edit replacement record (no audit trail)',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        properties: {
          remarks: { type: 'string' },
          performedBy: { type: 'string' },
          replacedAt: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as any;
    const record = await prisma.auditTrail.findFirst({ where: { id, action: 'FILTER_REPLACED' } });
    if (!record) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Replacement record not found' });

    const data: any = {};
    if (body.performedBy !== undefined) data.userName = body.performedBy;
    if (body.replacedAt !== undefined) data.timestamp = new Date(body.replacedAt);

    // Update fields stored in afterValue JSON
    const afterVal = (record.afterValue as any) ?? {};
    let afterChanged = false;
    for (const key of ['remarks', 'oldFilterId', 'oldFilterName', 'newFilterId', 'newFilterName']) {
      if (body[key] !== undefined) { afterVal[key] = body[key]; afterChanged = true; }
    }
    if (afterChanged) data.afterValue = afterVal;

    await prisma.auditTrail.update({ where: { id }, data });
    return { success: true };
  });

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // COMPREHENSIVE DATA MANAGEMENT â€” ALL OPERATIONAL DATA
  // Generic list/edit/delete for every data table, no audit trail
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  const dataPreHandler = [app.requireRole('SUPER_ADMIN')];
  // 2026-05-26 PA-REAUTH-3: separate preHandler list for mutations.
  // GETs keep the role-only gate; PUT/DELETE add the reauth step.
  const dataMutationPreHandler = [app.requireRole('SUPER_ADMIN'), requireDataEditReauth];
  const dataSchema = (summary: string) => ({
    tags: ['Super Admin - Data Management'],
    summary: `${summary} (no audit trail)`,
  });

  // Helper: paginated list for any Prisma model
  const paginatedList = async (model: any, query: any, orderBy: any = { createdAt: 'desc' }, include?: any, where?: any) => {
    const page = Number(query.page ?? 1);
    const limit = Math.min(Number(query.limit ?? 25), 100);
    const findArgs: any = { orderBy, skip: (page - 1) * limit, take: limit };
    if (include) findArgs.include = include;
    if (where) findArgs.where = where;
    const countArgs: any = where ? { where } : {};
    const [data, total] = await Promise.all([
      model.findMany(findArgs),
      model.count(countArgs),
    ]);
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  };

  // Helper: delete one row, reporting the truth. These handlers previously did
  // `.catch(() => null)` and then returned `{ success: true }` unconditionally,
  // so an FK violation, a trigger rejection or a missing row all rendered as a
  // successful deletion in the UI — the operator was told a record was gone
  // while it was still in the database. A genuinely-absent row is the one
  // tolerable case, and it is a 404 (P2025), not a success.
  const deleteRecord = async (model: any, id: string, label: string, reply: FastifyReply) => {
    try {
      await model.delete({ where: { id } });
      return { success: true };
    } catch (e: any) {
      if (e?.code === 'P2025') {
        return reply.code(404).send({ error: 'NOT_FOUND', message: `${label} not found.` });
      }
      return reply.code(400).send({ error: 'DELETE_FAILED', message: String(e?.message ?? `Could not delete ${label.toLowerCase()}.`) });
    }
  };

  // â”€â”€â”€ Cleaning Cycles â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.get('/data/cleaning-cycles', { preHandler: dataPreHandler, schema: dataSchema('List cleaning cycles') }, async (req) => {
    return paginatedList(prisma.cleaningCycle, req.query, [{ startedAt: 'desc' }]);
  });

  app.put('/data/cleaning-cycles/:id', { preHandler: dataMutationPreHandler, schema: { ...dataSchema('Edit cleaning cycle'), params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } }, body: { type: 'object', additionalProperties: true } } }, async (req, reply) => {
    const { id } = req.params as any;
    const existing = await prisma.cleaningCycle.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND' });
    const body = req.body as any;
    const data: any = {};
    const dateFields = ['startedAt', 'completedAt', 'terminatedAt', 'dryerStartedAt'];
    const stringFields = ['status', 'cycleCode', 'cleaningReasonKey', 'cleaningReasonLabel', 'cleaningJustification', 'terminationReason'];
    const numFields = ['sequenceNumber', 'profileVersion', 'dryerDurationMinutes'];
    const uuidFields = ['filterId', 'profileId', 'cleaningAreaId', 'equipmentGroupId'];
    for (const f of stringFields) { if (body[f] !== undefined) data[f] = body[f]; }
    for (const f of dateFields) { if (body[f] !== undefined) data[f] = body[f] ? new Date(body[f]) : null; }
    for (const f of numFields) { if (body[f] !== undefined) data[f] = body[f] !== null ? Number(body[f]) : null; }
    for (const f of uuidFields) { if (body[f] !== undefined) data[f] = body[f] || null; }
    return prisma.cleaningCycle.update({ where: { id }, data });
  });

  // Create a cleaning cycle (manual/back-dated record — no audit trail, mirrors
  // the silent edit above). Requires the real FKs a cycle can't exist without
  // (filter + profile) and fills the remaining NOT-NULL columns with sensible
  // derived defaults so a SUPER_ADMIN only has to supply what they care about.
  app.post('/data/cleaning-cycles', { preHandler: dataMutationPreHandler, schema: { ...dataSchema('Create cleaning cycle'), body: { type: 'object', additionalProperties: true } } }, async (req, reply) => {
    const body = req.body as any;
    const data: any = {};
    const stringFields = ['status', 'cycleCode', 'cleaningReasonKey', 'cleaningReasonLabel', 'cleaningJustification', 'terminationReason'];
    const dateFields = ['startedAt', 'completedAt', 'terminatedAt', 'dryerStartedAt'];
    const numFields = ['sequenceNumber', 'profileVersion', 'dryerDurationMinutes'];
    const uuidFields = ['filterId', 'profileId', 'cleaningAreaId', 'equipmentGroupId'];
    for (const f of stringFields) { if (body[f] !== undefined && body[f] !== '') data[f] = body[f]; }
    for (const f of dateFields) { if (body[f]) data[f] = new Date(body[f]); }
    for (const f of numFields) { if (body[f] !== undefined && body[f] !== '' && body[f] !== null) data[f] = Number(body[f]); }
    for (const f of uuidFields) { if (body[f]) data[f] = body[f]; }
    if (!data.filterId) return reply.code(400).send({ error: 'MISSING_FIELD', message: 'A filter must be selected.' });
    if (!data.profileId) return reply.code(400).send({ error: 'MISSING_FIELD', message: 'A cleaning profile must be selected.' });
    if (!data.cleaningReasonLabel) return reply.code(400).send({ error: 'MISSING_FIELD', message: 'Cleaning reason is required.' });
    if (!data.cleaningReasonKey) data.cleaningReasonKey = String(data.cleaningReasonLabel).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'manual';
    if (data.profileVersion === undefined) {
      const prof = await prisma.filterCleaningProfile.findUnique({ where: { id: data.profileId }, select: { version: true } });
      data.profileVersion = prof?.version ?? 1;
    }
    if (data.sequenceNumber === undefined) {
      data.sequenceNumber = (await prisma.cleaningCycle.count({ where: { filterId: data.filterId } })) + 1;
    }
    if (!data.cycleCode) data.cycleCode = `MANUAL-${data.sequenceNumber}-${Date.now().toString(36).toUpperCase()}`;
    if (!data.startedAt) data.startedAt = new Date();
    data.manualEntry = true;
    try {
      return await prisma.cleaningCycle.create({ data });
    } catch (e: any) {
      const msg = String(e?.message ?? '');
      if (e?.code === 'P2002' || msg.includes('unique') || msg.includes('23505') || msg.includes('one_in_progress')) {
        return reply.code(409).send({ error: 'CONFLICT', message: 'Duplicate cycle code, or this filter already has an in-progress cycle. Set status to COMPLETED/TERMINATED or change the cycle code.' });
      }
      return reply.code(400).send({ error: 'CREATE_FAILED', message: msg || 'Could not create cleaning cycle.' });
    }
  });

  app.delete('/data/cleaning-cycles/:id', { preHandler: dataMutationPreHandler, schema: { ...dataSchema('Delete cleaning cycle'), params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } } }, async (req, reply) => {
    const { id } = req.params as any;
    const existing = await prisma.cleaningCycle.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND' });
    await prisma.filterEvent.deleteMany({ where: { cycleId: id } });
    // Clear currentCycleId/currentLifecycleState on FilterDetails (Step 6).
    await prisma.filterDetails.updateMany({ where: { currentCycleId: id }, data: { currentCycleId: null, currentLifecycleState: null } });
    await prisma.cleaningCycle.delete({ where: { id } });
    return { success: true };
  });

  // â”€â”€â”€ Filter Events â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.get('/data/filter-events', { preHandler: dataPreHandler, schema: dataSchema('List filter events') }, async (req) => {
    return paginatedList(prisma.filterEvent, req.query, { performedAt: 'desc' });
  });

  app.put('/data/filter-events/:id', { preHandler: dataMutationPreHandler, schema: { ...dataSchema('Edit filter event'), params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } }, body: { type: 'object', additionalProperties: true } } }, async (req, reply) => {
    const { id } = req.params as any;
    const body = req.body as any;
    const existing = await prisma.filterEvent.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND' });
    const data: any = {};
    for (const f of ['eventType', 'fromState', 'toState', 'remarks', 'checksum']) {
      if (body[f] !== undefined) data[f] = body[f];
    }
    for (const f of ['filterId', 'cycleId', 'performedBy', 'cleaningAreaId', 'equipmentId', 'blockId']) {
      if (body[f] !== undefined) data[f] = body[f] || null;
    }
    if (body.performedAt !== undefined) data.performedAt = new Date(body.performedAt);
    if (body.attributes !== undefined) data.attributes = body.attributes;
    return prisma.filterEvent.update({ where: { id }, data });
  });

  // Create a filter event (manual record — no audit trail). performedBy, the
  // SHA-256 checksum and the caller IP are stamped server-side; a cycleId, if
  // given, must belong to the same filter (DB trg_filter_event_consistency).
  app.post('/data/filter-events', { preHandler: dataMutationPreHandler, schema: { ...dataSchema('Create filter event'), body: { type: 'object', additionalProperties: true } } }, async (req, reply) => {
    const body = req.body as any;
    const data: any = {};
    for (const f of ['eventType', 'fromState', 'toState', 'remarks']) { if (body[f] !== undefined && body[f] !== '') data[f] = body[f]; }
    for (const f of ['filterId', 'cycleId', 'cleaningAreaId', 'equipmentId', 'blockId']) { if (body[f]) data[f] = body[f]; }
    if (body.attributes !== undefined) data.attributes = body.attributes;
    if (!data.filterId) return reply.code(400).send({ error: 'MISSING_FIELD', message: 'A filter must be selected.' });
    if (!data.eventType) return reply.code(400).send({ error: 'MISSING_FIELD', message: 'Event type is required.' });
    data.performedBy = body.performedBy || (req.user as any)?.sub;
    data.performedAt = body.performedAt ? new Date(body.performedAt) : new Date();
    data.ipAddress = req.ip || '0.0.0.0';
    data.checksum = body.checksum || computeChecksum({ filterId: data.filterId, cycleId: data.cycleId ?? null, eventType: data.eventType, performedBy: data.performedBy, performedAt: data.performedAt.toISOString() });
    data.manualEntry = true;
    try {
      return await prisma.filterEvent.create({ data });
    } catch (e: any) {
      return reply.code(400).send({ error: 'CREATE_FAILED', message: String(e?.message ?? 'Could not create filter event.') });
    }
  });

  app.delete('/data/filter-events/:id', { preHandler: dataMutationPreHandler, schema: { ...dataSchema('Delete filter event'), params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } } }, async (req, reply) => {
    const { id } = req.params as any;
    return deleteRecord(prisma.filterEvent, id, 'Filter event', reply);
  });

  // â”€â”€â”€ Audit Trail â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // List is allowed (read-only). PUT + DELETE were removed 2026-05-20
  // (delta-audit Â§C2 / May 16 Â§1.3) â€” they let SUPER_ADMIN rewrite or erase
  // any audit row with no reauth and no audit-of-the-audit, making the
  // hash-chain machinery decorative. Audit records are immutable by 21 CFR
  // Â§11.10(e); the DB-level audit_trail_no_delete trigger and
  // verifyAuditChain are the source of truth, and the data-mgmt UI must not
  // expose escape hatches. If a row must be redacted, do it via the
  // dedicated REDACT path (Wave 4 Â§C1 â€” preserves chain links, NULLs
  // payload, requires reauth + meta-audit).
  app.get('/data/audit-trail', { preHandler: dataPreHandler, schema: dataSchema('List audit trail entries') }, async (req) => {
    return paginatedList(prisma.auditTrail, req.query, { timestamp: 'desc' });
  });

  // â”€â”€â”€ Notifications â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.get('/data/notifications', { preHandler: dataPreHandler, schema: dataSchema('List notifications') }, async (req) => {
    return paginatedList(prisma.notification, req.query, { createdAt: 'desc' });
  });

  app.put('/data/notifications/:id', { preHandler: dataMutationPreHandler, schema: { ...dataSchema('Edit notification'), params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } }, body: { type: 'object', additionalProperties: true } } }, async (req, reply) => {
    const { id } = req.params as any;
    const body = req.body as any;
    const data: any = {};
    for (const f of ['type', 'title', 'message', 'forUserId', 'forRole', 'targetUserId', 'createdBy']) { if (body[f] !== undefined) data[f] = body[f]; }
    if (body.isRead !== undefined) data.isRead = body.isRead === true || body.isRead === 'true';
    if (body.readAt !== undefined) data.readAt = body.readAt ? new Date(body.readAt) : null;
    return prisma.notification.update({ where: { id }, data });
  });

  // Create a notification (manual record — no audit trail).
  app.post('/data/notifications', { preHandler: dataMutationPreHandler, schema: { ...dataSchema('Create notification'), body: { type: 'object', additionalProperties: true } } }, async (req, reply) => {
    const body = req.body as any;
    const data: any = {};
    for (const f of ['type', 'title', 'message', 'forUserId', 'forRole', 'targetUserId', 'createdBy']) { if (body[f] !== undefined && body[f] !== '') data[f] = body[f]; }
    if (body.isRead !== undefined) data.isRead = body.isRead === true || body.isRead === 'true';
    if (body.readAt) data.readAt = new Date(body.readAt);
    if (body.createdAt) data.createdAt = new Date(body.createdAt);
    if (!data.type) return reply.code(400).send({ error: 'MISSING_FIELD', message: 'Type is required.' });
    if (!data.title) return reply.code(400).send({ error: 'MISSING_FIELD', message: 'Title is required.' });
    if (!data.message) return reply.code(400).send({ error: 'MISSING_FIELD', message: 'Message is required.' });
    if (!data.createdBy) data.createdBy = (req.user as any)?.sub;
    data.manualEntry = true;
    try {
      return await prisma.notification.create({ data });
    } catch (e: any) {
      return reply.code(400).send({ error: 'CREATE_FAILED', message: String(e?.message ?? 'Could not create notification.') });
    }
  });

  app.delete('/data/notifications/:id', { preHandler: dataMutationPreHandler, schema: { ...dataSchema('Delete notification'), params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } } }, async (req, reply) => {
    const { id } = req.params as any;
    return deleteRecord(prisma.notification, id, 'Notification', reply);
  });

  // â”€â”€â”€ Admin Requests â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.get('/data/admin-requests', { preHandler: dataPreHandler, schema: dataSchema('List admin requests') }, async (req) => {
    return paginatedList(prisma.adminRequest, req.query, { requestedAt: 'desc' });
  });

  app.put('/data/admin-requests/:id', { preHandler: dataMutationPreHandler, schema: { ...dataSchema('Edit admin request'), params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } }, body: { type: 'object', additionalProperties: true } } }, async (req) => {
    const { id } = req.params as any;
    const body = req.body as any;
    const data: any = {};
    for (const f of ['requestType', 'status', 'requesterName', 'requesterEmployeeId', 'requesterEmail', 'remarks', 'adminRemarks', 'processedBy']) {
      if (body[f] !== undefined) data[f] = body[f];
    }
    for (const f of ['requestedAt', 'processedAt']) {
      if (body[f] !== undefined) data[f] = body[f] ? new Date(body[f]) : null;
    }
    if (body.requestData !== undefined) data.requestData = body.requestData;
    return prisma.adminRequest.update({ where: { id }, data });
  });

  // Create an admin request (manual record — no audit trail).
  app.post('/data/admin-requests', { preHandler: dataMutationPreHandler, schema: { ...dataSchema('Create admin request'), body: { type: 'object', additionalProperties: true } } }, async (req, reply) => {
    const body = req.body as any;
    const data: any = {};
    for (const f of ['requestType', 'status', 'requesterName', 'requesterEmployeeId', 'requesterEmail', 'remarks', 'adminRemarks', 'processedBy']) { if (body[f] !== undefined && body[f] !== '') data[f] = body[f]; }
    for (const f of ['requestedAt', 'processedAt']) { if (body[f]) data[f] = new Date(body[f]); }
    if (body.requestData !== undefined) data.requestData = body.requestData;
    if (!data.requestType) return reply.code(400).send({ error: 'MISSING_FIELD', message: 'Request type is required.' });
    if (!data.requesterName) return reply.code(400).send({ error: 'MISSING_FIELD', message: 'Requester name is required.' });
    data.manualEntry = true;
    try {
      return await prisma.adminRequest.create({ data });
    } catch (e: any) {
      return reply.code(400).send({ error: 'CREATE_FAILED', message: String(e?.message ?? 'Could not create admin request.') });
    }
  });

  app.delete('/data/admin-requests/:id', { preHandler: dataMutationPreHandler, schema: { ...dataSchema('Delete admin request'), params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } } }, async (req, reply) => {
    const { id } = req.params as any;
    return deleteRecord(prisma.adminRequest, id, 'Admin request', reply);
  });

  // â”€â”€â”€ Block Change Requests â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  app.get('/data/block-change-requests', { preHandler: dataPreHandler, schema: dataSchema('List block change requests') }, async (req) => {
    return paginatedList(prisma.blockChangeRequest, req.query);
  });

  app.put('/data/block-change-requests/:id', { preHandler: dataMutationPreHandler, schema: { ...dataSchema('Edit block change request'), params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } }, body: { type: 'object', additionalProperties: true } } }, async (req) => {
    const { id } = req.params as any;
    const body = req.body as any;
    const data: any = {};
    for (const f of ['status', 'reason', 'filterName', 'fromBlockName', 'toBlockName', 'requestedByName', 'processedByName', 'processedComment']) {
      if (body[f] !== undefined) data[f] = body[f];
    }
    for (const f of ['filterId', 'fromBlockId', 'toBlockId', 'requestedBy', 'processedBy']) {
      if (body[f] !== undefined) data[f] = body[f] || null;
    }
    for (const f of ['processedAt', 'createdAt']) {
      if (body[f] !== undefined) data[f] = body[f] ? new Date(body[f]) : null;
    }
    return prisma.blockChangeRequest.update({ where: { id }, data });
  });

  // Create a block-change request (manual record — no audit trail). Needs the
  // full filter + from/to block identity a request can't exist without; the
  // requester defaults to the acting SUPER_ADMIN when not supplied.
  app.post('/data/block-change-requests', { preHandler: dataMutationPreHandler, schema: { ...dataSchema('Create block change request'), body: { type: 'object', additionalProperties: true } } }, async (req, reply) => {
    const body = req.body as any;
    const data: any = {};
    for (const f of ['status', 'reason', 'filterName', 'fromBlockName', 'toBlockName', 'requestedByName', 'processedByName', 'processedComment']) { if (body[f] !== undefined && body[f] !== '') data[f] = body[f]; }
    for (const f of ['filterId', 'fromBlockId', 'toBlockId', 'requestedBy', 'processedBy']) { if (body[f]) data[f] = body[f]; }
    for (const f of ['processedAt', 'createdAt']) { if (body[f]) data[f] = new Date(body[f]); }
    for (const f of ['filterId', 'filterName', 'fromBlockId', 'fromBlockName', 'toBlockId', 'toBlockName']) {
      if (!data[f]) return reply.code(400).send({ error: 'MISSING_FIELD', message: `${f} is required.` });
    }
    if (!data.requestedBy) data.requestedBy = (req.user as any)?.sub;
    if (!data.requestedByName) data.requestedByName = (req.user as any)?.username ?? 'Manual Entry';
    data.manualEntry = true;
    try {
      return await prisma.blockChangeRequest.create({ data });
    } catch (e: any) {
      return reply.code(400).send({ error: 'CREATE_FAILED', message: String(e?.message ?? 'Could not create block change request.') });
    }
  });

  app.delete('/data/block-change-requests/:id', { preHandler: dataMutationPreHandler, schema: { ...dataSchema('Delete block change request'), params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } } }, async (req, reply) => {
    const { id } = req.params as any;
    return deleteRecord(prisma.blockChangeRequest, id, 'Block change request', reply);
  });

  // â”€â”€â”€ PM Schedule Entries â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Flat list of PM schedules (name-resolved via the owning entity) — powers
  // the create-PM-entry schedule picker so a new entry can be attached even
  // when no entries exist yet. Read-only; SUPER_ADMIN.
  app.get('/data/pm-schedules', { preHandler: dataPreHandler, schema: dataSchema('List PM schedules') }, async () => {
    const schedules = await prisma.pmSchedule.findMany({ orderBy: [{ year: 'desc' }, { updatedAt: 'desc' }], take: 500 });
    const entityIds = [...new Set(schedules.map(s => s.entityId))];
    const entities = await prisma.assetInstance.findMany({ where: { id: { in: entityIds } }, select: { id: true, name: true } });
    const nameById = new Map(entities.map(e => [e.id, e.name]));
    return { data: schedules.map(s => ({ id: s.id, entityId: s.entityId, entityName: nameById.get(s.entityId) ?? null, year: s.year, version: s.version, status: s.status })) };
  });

  app.get('/data/pm-entries', { preHandler: dataPreHandler, schema: dataSchema('List PM schedule entries') }, async (req) => {
    return paginatedList(prisma.pmScheduleEntry, req.query, { plannedDate: 'desc' }, { schedule: true });
  });

  app.put('/data/pm-entries/:id', { preHandler: dataMutationPreHandler, schema: { ...dataSchema('Edit PM schedule entry'), params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } }, body: { type: 'object', additionalProperties: true } } }, async (req, reply) => {
    const { id } = req.params as any;
    const body = req.body as any;
    const existing = await prisma.pmScheduleEntry.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND' });
    const data: any = {};
    for (const f of ['month', 'toleranceDays']) { if (body[f] !== undefined) data[f] = Number(body[f]); }
    for (const f of ['approvalStatus', 'approvalRemarks', 'submittedByName', 'approvedByName', 'notes']) { if (body[f] !== undefined) data[f] = body[f]; }
    for (const f of ['plannedDate', 'windowStart', 'windowEnd', 'approvedAt']) { if (body[f] !== undefined) data[f] = body[f] ? new Date(body[f]) : null; }
    return prisma.pmScheduleEntry.update({ where: { id }, data });
  });

  // Create a PM schedule entry (manual record — no audit trail). Needs its
  // parent scheduleId (unlike edit); the coverage window defaults to the
  // planned date when not supplied. [scheduleId, month] is unique.
  app.post('/data/pm-entries', { preHandler: dataMutationPreHandler, schema: { ...dataSchema('Create PM schedule entry'), body: { type: 'object', additionalProperties: true } } }, async (req, reply) => {
    const body = req.body as any;
    const data: any = {};
    for (const f of ['month', 'toleranceDays']) { if (body[f] !== undefined && body[f] !== '' && body[f] !== null) data[f] = Number(body[f]); }
    for (const f of ['approvalStatus', 'approvalRemarks', 'submittedByName', 'approvedByName', 'notes']) { if (body[f] !== undefined && body[f] !== '') data[f] = body[f]; }
    for (const f of ['plannedDate', 'windowStart', 'windowEnd', 'approvedAt']) { if (body[f]) data[f] = new Date(body[f]); }
    if (body.scheduleId) data.scheduleId = body.scheduleId;
    if (!data.scheduleId) return reply.code(400).send({ error: 'MISSING_FIELD', message: 'A PM schedule must be selected.' });
    if (data.month === undefined) return reply.code(400).send({ error: 'MISSING_FIELD', message: 'Month (1–12) is required.' });
    if (!data.plannedDate) return reply.code(400).send({ error: 'MISSING_FIELD', message: 'Planned date is required.' });
    if (!data.windowStart) data.windowStart = data.plannedDate;
    if (!data.windowEnd) data.windowEnd = data.plannedDate;
    data.manualEntry = true;
    try {
      return await prisma.pmScheduleEntry.create({ data });
    } catch (e: any) {
      const msg = String(e?.message ?? '');
      if (e?.code === 'P2002' || msg.includes('unique') || msg.includes('23505')) {
        return reply.code(409).send({ error: 'CONFLICT', message: 'A PM entry for this schedule and month already exists.' });
      }
      return reply.code(400).send({ error: 'CREATE_FAILED', message: msg || 'Could not create PM entry.' });
    }
  });

  app.delete('/data/pm-entries/:id', { preHandler: dataMutationPreHandler, schema: { ...dataSchema('Delete PM schedule entry'), params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } } }, async (req, reply) => {
    const { id } = req.params as any;
    return deleteRecord(prisma.pmScheduleEntry, id, 'PM schedule entry', reply);
  });
}
