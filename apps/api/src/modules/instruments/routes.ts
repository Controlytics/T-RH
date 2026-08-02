/**
 * Instruments — sensors, PLCs, meters and other addressable devices.
 *
 * An instrument either hangs off a gateway (inheriting its profile) or
 * communicates independently (and must carry its own profile). That is
 * enforced both here and by the instruments_reachable_chk CHECK constraint.
 * Topics are derived (not stored) by the pure topic-resolver (Task 6);
 * only explicit per-category overrides are persisted, in instrument_topics.
 */
import { type FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { buildContext } from '../../lib/build-context.js';
import { auditLog } from '../../lib/audit.js';
import { enforceReauth } from '../../lib/reauth-check.js';
import { stripHtml } from '../../lib/sanitize.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { getAncestryPath, sanitizeSlug } from '../hierarchy/hierarchy.repository.js';
import { resolveTopics, TOPIC_CATEGORIES, type TopicCategory, type UnsSettings } from './topic-resolver.js';
import { configRepository } from '../config/config.repository.js';

/** True for a Prisma foreign-key-violation error (P2003) — no global mapping exists for it. */
function isFkViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003';
}

// Must match uns-settings.def.ts's declared `default`s exactly (apps/api/src/modules/config/defs/uns-settings.def.ts)
// so topics derive identically whether or not an admin has ever opened the config page.
// `prefix` defaults to '' — the company already comes from the hierarchy's COMPANY-level
// root node, so a non-empty default here would duplicate it in every derived topic.
const DEFAULT_UNS: UnsSettings = { prefix: '', separator: '/', includeGateway: true };

async function unsSettings(): Promise<UnsSettings> {
  const stored = await configRepository.getSystemConfig('uns-settings');
  const value = (stored?.configValue as Partial<UnsSettings> | null) ?? {};
  const merged = { ...DEFAULT_UNS };
  // Only overlay keys whose stored type matches the default's — an explicit
  // `null`/wrong-type value in configValue must not silently blank out a
  // default (resolveTopics throws on a non-string prefix or empty
  // separator; better a stale-but-valid default than a 500 on every
  // GET /:id/topics).
  for (const key of Object.keys(DEFAULT_UNS) as (keyof UnsSettings)[]) {
    if (typeof value[key] === typeof DEFAULT_UNS[key]) {
      (merged as any)[key] = value[key];
    }
  }
  return merged;
}

export default async function instrumentRoutes(app: FastifyInstance) {

  app.get('/', {
    preHandler: [app.requirePermission('INSTRUMENT_VIEW')],
    schema: { tags: ['Data Injection'], summary: 'List instruments' },
  }, async () => prisma.instrument.findMany({
    include: {
      hierarchyNode: { select: { name: true } },
      gateway: { select: { name: true, slug: true } },
    },
    orderBy: { name: 'asc' },
  }));

  // Single instrument. Added 2026-08-02 for the P2 detail page — the module had
  // list, topics, create, update and delete but no way to read ONE instrument,
  // so the detail page 404'd on its primary fetch.
  app.get('/:id', {
    preHandler: [app.requirePermission('INSTRUMENT_VIEW')],
    schema: {
      tags: ['Data Injection'], summary: 'Get one instrument',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const row = await prisma.instrument.findUnique({
      where: { id },
      include: {
        hierarchyNode: { select: { name: true } },
        gateway: { select: { name: true, slug: true } },
      },
    });
    if (!row) throw new NotFoundError('Instrument not found.');
    return row;
  });

  app.get('/:id/topics', {
    preHandler: [app.requirePermission('INSTRUMENT_VIEW')],
    schema: {
      tags: ['Data Injection'], summary: 'Resolved UNS topics for an instrument',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const inst = await prisma.instrument.findUnique({
      where: { id }, include: { gateway: true, topics: true },
    });
    if (!inst) throw new NotFoundError('Instrument not found.');

    const overrides: Partial<Record<TopicCategory, string>> = {};
    for (const t of inst.topics) {
      if (t.customTopic) overrides[t.category as TopicCategory] = t.customTopic;
    }
    return resolveTopics({
      settings: await unsSettings(),
      ancestry: await getAncestryPath(inst.hierarchyNodeId),
      gatewaySlug: inst.gateway?.slug ?? null,
      instrumentSlug: inst.slug,
      overrides,
    });
  });

  app.post('/', {
    preHandler: [app.requirePermission('INSTRUMENT_CREATE')],
    schema: {
      tags: ['Data Injection'], summary: 'Create instrument',
      body: {
        type: 'object', additionalProperties: false,
        required: ['name', 'code', 'instrumentType', 'hierarchyNodeId'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          code: { type: 'string', minLength: 1, maxLength: 50 },
          instrumentType: { type: 'string', minLength: 1, maxLength: 50 },
          manufacturer: { type: 'string', maxLength: 100 },
          model: { type: 'string', maxLength: 100 },
          serialNumber: { type: 'string', maxLength: 100 },
          description: { type: 'string', maxLength: 500 },
          hierarchyNodeId: { type: 'string' },
          gatewayId: { type: ['string', 'null'] },
          deviceKey: { type: ['string', 'null'], maxLength: 100 },
          communicationProfileId: { type: ['string', 'null'] },
        },
      },
    },
  }, async (req, reply) => {
    if (!(await enforceReauth('CREATE_INSTRUMENT', req, reply)).ok) return reply;
    const b = req.body as Record<string, string | null>;
    const ctx = buildContext(req);

    // Mirror of the instruments_reachable_chk CHECK constraint, surfaced as a
    // readable 400 rather than a raw Postgres violation.
    if (!b.gatewayId && !b.communicationProfileId) {
      throw new ValidationError(
        'An instrument with no gateway must have its own communication profile.',
      );
    }
    if (b.gatewayId && !b.deviceKey) {
      throw new ValidationError(
        'A gateway-attached instrument needs a deviceKey so inbound payloads can be routed to it.',
      );
    }

    const [node, gateway, profile] = await Promise.all([
      prisma.hierarchyNode.findUnique({ where: { id: b.hierarchyNodeId! } }),
      b.gatewayId ? prisma.gateway.findUnique({ where: { id: b.gatewayId } }) : Promise.resolve(undefined),
      b.communicationProfileId
        ? prisma.communicationProfile.findUnique({ where: { id: b.communicationProfileId } })
        : Promise.resolve(undefined),
    ]);
    if (!node) throw new ValidationError('hierarchyNodeId does not reference an existing hierarchy node.');
    if (b.gatewayId && !gateway) throw new ValidationError('gatewayId does not reference an existing gateway.');
    if (b.communicationProfileId && !profile) {
      throw new ValidationError('communicationProfileId does not reference an existing communication profile.');
    }

    let created;
    try {
      created = await prisma.$transaction(async (tx) => {
        const row = await tx.instrument.create({
          data: {
            name: stripHtml(b.name!), code: stripHtml(b.code!), slug: sanitizeSlug(b.name!),
            instrumentType: stripHtml(b.instrumentType!),
            manufacturer: b.manufacturer ? stripHtml(b.manufacturer) : null,
            model: b.model ? stripHtml(b.model) : null,
            serialNumber: b.serialNumber ? stripHtml(b.serialNumber) : null,
            description: b.description ? stripHtml(b.description) : null,
            hierarchyNodeId: b.hierarchyNodeId!,
            gatewayId: b.gatewayId ?? null,
            deviceKey: b.deviceKey ? stripHtml(b.deviceKey) : null,
            communicationProfileId: b.communicationProfileId ?? null,
            createdBy: ctx.userId,
          },
        });
        await auditLog({
          action: 'INSTRUMENT_CREATED', targetType: 'Instrument', targetId: row.id,
          afterValue: { name: row.name, code: row.code, gatewayId: row.gatewayId, deviceKey: row.deviceKey },
          userId: ctx.userId, userRole: ctx.userRole, ipAddress: ctx.ipAddress,
          userAgent: ctx.userAgent, sessionId: ctx.sessionId,
        }, tx);
        return row;
      });
    } catch (err) {
      // Belt-and-braces — the pre-checks above close the common races, but a
      // concurrent delete of the node/gateway/profile between check and
      // insert can still raise P2003, which has no global mapping (unlike
      // P2002, mapped to 409 in app.ts's error handler) and would otherwise 500.
      if (isFkViolation(err)) {
        throw new ValidationError('One or more referenced records no longer exist.');
      }
      throw err;
    }
    return created;
  });

  app.put('/:id', {
    preHandler: [app.requirePermission('INSTRUMENT_UPDATE')],
    schema: {
      tags: ['Data Injection'], summary: 'Update instrument',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        type: 'object', additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          instrumentType: { type: 'string', maxLength: 50 },
          manufacturer: { type: 'string', maxLength: 100 },
          model: { type: 'string', maxLength: 100 },
          serialNumber: { type: 'string', maxLength: 100 },
          description: { type: 'string', maxLength: 500 },
          deviceKey: { type: ['string', 'null'], maxLength: 100 },
          communicationProfileId: { type: ['string', 'null'] },
          isActive: { type: 'boolean' },
        },
      },
    },
  }, async (req, reply) => {
    if (!(await enforceReauth('UPDATE_INSTRUMENT', req, reply)).ok) return reply;
    const { id } = req.params as { id: string };
    const b = req.body as Record<string, unknown>;
    const ctx = buildContext(req);

    const before = await prisma.instrument.findUnique({ where: { id } });
    if (!before) throw new NotFoundError('Instrument not found.');

    if (b.communicationProfileId !== undefined && b.communicationProfileId !== null) {
      const profile = await prisma.communicationProfile.findUnique({
        where: { id: b.communicationProfileId as string },
      });
      if (!profile) throw new ValidationError('communicationProfileId does not reference an existing communication profile.');
    }

    // Re-derive the reachability invariant against the state the row would end
    // up in — same rule as create, mirrored for updates that clear gateway
    // linkage's profile requirement (an instrument's gatewayId is immutable
    // post-create here, so only the "clear own profile while independent"
    // edge case is reachable; guard it anyway).
    const willBeGatewayless = before.gatewayId === null;
    const willHaveProfile = b.communicationProfileId !== undefined
      ? b.communicationProfileId !== null
      : before.communicationProfileId !== null;
    if (willBeGatewayless && !willHaveProfile) {
      throw new ValidationError(
        'An instrument with no gateway must have its own communication profile.',
      );
    }
    // Mirror of hazard E's create-time guard: a gateway-attached instrument
    // must always keep a deviceKey, or a gateway payload can no longer be
    // routed to it (the DB's @@unique([gatewayId, deviceKey]) tolerates a
    // null deviceKey, so this isn't caught by any constraint).
    const willHaveDeviceKey = b.deviceKey !== undefined
      ? b.deviceKey !== null && String(b.deviceKey).trim().length > 0
      : before.deviceKey !== null;
    if (before.gatewayId !== null && !willHaveDeviceKey) {
      throw new ValidationError(
        'A gateway-attached instrument needs a deviceKey so inbound payloads can be routed to it.',
      );
    }

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.instrument.update({
        where: { id },
        data: {
          ...(b.name !== undefined && { name: stripHtml(b.name as string), slug: sanitizeSlug(b.name as string) }),
          ...(b.instrumentType !== undefined && { instrumentType: stripHtml(b.instrumentType as string) }),
          ...(b.manufacturer !== undefined && { manufacturer: stripHtml(b.manufacturer as string) }),
          ...(b.model !== undefined && { model: stripHtml(b.model as string) }),
          ...(b.serialNumber !== undefined && { serialNumber: stripHtml(b.serialNumber as string) }),
          ...(b.description !== undefined && { description: stripHtml(b.description as string) }),
          ...(b.deviceKey !== undefined && { deviceKey: b.deviceKey as string | null }),
          ...(b.communicationProfileId !== undefined && { communicationProfileId: b.communicationProfileId as string | null }),
          ...(b.isActive !== undefined && { isActive: b.isActive as boolean }),
        },
      });
      await auditLog({
        action: 'INSTRUMENT_UPDATED', targetType: 'Instrument', targetId: id,
        beforeValue: { name: before.name, deviceKey: before.deviceKey, isActive: before.isActive },
        afterValue: { name: row.name, deviceKey: row.deviceKey, isActive: row.isActive },
        userId: ctx.userId, userRole: ctx.userRole, ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
      return row;
    });
    return updated;
  });

  app.put('/:id/topics/:category', {
    preHandler: [app.requirePermission('INSTRUMENT_UPDATE')],
    schema: {
      tags: ['Data Injection'], summary: 'Set (or clear) a per-instrument topic override',
      params: {
        type: 'object', required: ['id', 'category'],
        properties: { id: { type: 'string' }, category: { type: 'string', enum: [...TOPIC_CATEGORIES] } },
      },
      body: {
        type: 'object', additionalProperties: false,
        properties: {
          customTopic: { type: ['string', 'null'], maxLength: 500 },
          qos: { type: 'integer', minimum: 0, maximum: 2 },
          retain: { type: 'boolean' },
          enabled: { type: 'boolean' },
        },
      },
    },
  }, async (req, reply) => {
    if (!(await enforceReauth('UPDATE_INSTRUMENT', req, reply)).ok) return reply;
    const { id, category } = req.params as { id: string; category: TopicCategory };
    const b = req.body as { customTopic?: string | null; qos?: number; retain?: boolean; enabled?: boolean };
    const ctx = buildContext(req);

    const inst = await prisma.instrument.findUnique({ where: { id } });
    if (!inst) throw new NotFoundError('Instrument not found.');

    // Blank/whitespace-only means "stop customising" — same rule resolveTopics
    // applies when reading overrides (Task 6): store it as null and emit the
    // CLEARED action rather than SET.
    const normalizedTopic = b.customTopic != null && b.customTopic.trim().length > 0
      ? stripHtml(b.customTopic)
      : null;

    const row = await prisma.$transaction(async (tx) => {
      const saved = await tx.instrumentTopic.upsert({
        where: { instrumentId_category: { instrumentId: id, category } },
        create: {
          instrumentId: id, category,
          customTopic: normalizedTopic,
          qos: b.qos ?? 1, retain: b.retain ?? false, enabled: b.enabled ?? true,
        },
        update: {
          customTopic: normalizedTopic,
          ...(b.qos !== undefined && { qos: b.qos }),
          ...(b.retain !== undefined && { retain: b.retain }),
          ...(b.enabled !== undefined && { enabled: b.enabled }),
        },
      });
      await auditLog({
        action: normalizedTopic ? 'INSTRUMENT_TOPIC_OVERRIDE_SET' : 'INSTRUMENT_TOPIC_OVERRIDE_CLEARED',
        targetType: 'InstrumentTopic', targetId: saved.id,
        afterValue: { instrumentId: id, category, customTopic: saved.customTopic, qos: saved.qos, retain: saved.retain },
        userId: ctx.userId, userRole: ctx.userRole, ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
      return saved;
    });
    return row;
  });

  app.delete('/:id', {
    preHandler: [app.requirePermission('INSTRUMENT_DELETE')],
    schema: {
      tags: ['Data Injection'], summary: 'Delete instrument',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  }, async (req, reply) => {
    if (!(await enforceReauth('DELETE_INSTRUMENT', req, reply)).ok) return reply;
    const { id } = req.params as { id: string };
    const ctx = buildContext(req);

    const before = await prisma.instrument.findUnique({ where: { id } });
    if (!before) throw new NotFoundError('Instrument not found.');

    await prisma.$transaction(async (tx) => {
      await tx.instrument.delete({ where: { id } });   // topics + settings cascade
      await auditLog({
        action: 'INSTRUMENT_DELETED', targetType: 'Instrument', targetId: id,
        beforeValue: { name: before.name, code: before.code },
        userId: ctx.userId, userRole: ctx.userRole, ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
    });
    return { success: true };
  });
}
