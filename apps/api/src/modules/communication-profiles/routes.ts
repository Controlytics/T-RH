/**
 * Communication Profiles — reusable per-protocol connection settings.
 *
 * config holds broker credentials, API keys, and certificates, so every read
 * path masks it through an explicit allowlist (maskSecrets fails CLOSED — an
 * unrecognised key is redacted until a human declares it safe); the masked
 * form is also what lands in audit diffs. Writing a raw secret into an audit
 * row would make it permanently unredactable-in-practice, since audit rows
 * are immutable and hash-chained (21 CFR §11.10(e)).
 */
import { type FastifyInstance } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { buildContext } from '../../lib/build-context.js';
import { auditLog } from '../../lib/audit.js';
import { enforceReauth } from '../../lib/reauth-check.js';
import { maskSecrets } from '../../lib/mask-secrets.js';
import { stripHtml } from '../../lib/sanitize.js';
import { NotFoundError, ValidationError, ConflictError } from '../../lib/errors.js';

// Allowlist of config keys that are safe to return unmasked / write into audit
// diffs. Covers connection-shape fields shared across the protocol registry
// (mqtt, http, modbus, opcua, kafka, ...). Deliberately excludes credentials —
// password, token, apiKey, secret, certificate/key material, etc. — which fall
// through to REDACTED by default per the allowlist-not-denylist rule.
const COMM_PROFILE_SAFE_KEYS = [
  'brokerUrl', 'host', 'port', 'url', 'endpoint', 'path',
  'qos', 'topic', 'topicPrefix', 'clientId', 'username',
  'useTls', 'tls', 'protocolVersion', 'keepAlive', 'retain', 'clean',
  'pollIntervalMs', 'timeout', 'connectTimeout', 'reconnectPeriod',
  'unitId', 'baudRate', 'dataBits', 'stopBits', 'parity',
  'region', 'deviceId', 'apiVersion',
];

function maskConfig(config: unknown): unknown {
  return maskSecrets(config, COMM_PROFILE_SAFE_KEYS);
}

export default async function communicationProfileRoutes(app: FastifyInstance) {

  app.get('/protocols', {
    preHandler: [app.requirePermission('COMM_PROFILE_VIEW')],
    schema: { tags: ['Data Injection'], summary: 'List the protocol registry' },
  }, async () => prisma.protocol.findMany({ orderBy: { name: 'asc' } }));

  app.get('/', {
    preHandler: [app.requirePermission('COMM_PROFILE_VIEW')],
    schema: { tags: ['Data Injection'], summary: 'List communication profiles' },
  }, async () => {
    const rows = await prisma.communicationProfile.findMany({ orderBy: { name: 'asc' } });
    return rows.map(r => ({ ...r, config: maskConfig(r.config) }));
  });

  app.post('/', {
    preHandler: [app.requirePermission('COMM_PROFILE_CREATE')],
    schema: {
      tags: ['Data Injection'], summary: 'Create communication profile',
      body: {
        type: 'object', required: ['name', 'protocolKey', 'config'], additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          protocolKey: { type: 'string', minLength: 1, maxLength: 40 },
          config: { type: 'object' },
        },
      },
    },
  }, async (req, reply) => {
    if (!(await enforceReauth('CREATE_COMM_PROFILE', req, reply)).ok) return reply;
    const body = req.body as { name: string; protocolKey: string; config: Record<string, unknown> };
    const ctx = buildContext(req);

    const protocol = await prisma.protocol.findUnique({ where: { key: body.protocolKey } });
    if (!protocol) throw new ValidationError(`Unknown protocol '${body.protocolKey}'.`);

    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.communicationProfile.create({
        data: {
          name: stripHtml(body.name),
          protocolKey: body.protocolKey,
          config: body.config,
          createdBy: ctx.userId,
        },
      });
      await auditLog({
        action: 'COMMUNICATION_PROFILE_CREATED', targetType: 'CommunicationProfile', targetId: row.id,
        afterValue: { name: row.name, protocolKey: row.protocolKey, config: maskConfig(body.config) },
        userId: ctx.userId, userRole: ctx.userRole, ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
      return row;
    });
    return { ...created, config: maskConfig(created.config) };
  });

  app.put('/:id', {
    preHandler: [app.requirePermission('COMM_PROFILE_UPDATE')],
    schema: {
      tags: ['Data Injection'], summary: 'Update communication profile',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        type: 'object', additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          config: { type: 'object' },
          isActive: { type: 'boolean' },
        },
      },
    },
  }, async (req, reply) => {
    if (!(await enforceReauth('UPDATE_COMM_PROFILE', req, reply)).ok) return reply;
    const { id } = req.params as { id: string };
    const body = req.body as { name?: string; config?: Record<string, unknown>; isActive?: boolean };
    const ctx = buildContext(req);

    const before = await prisma.communicationProfile.findUnique({ where: { id } });
    if (!before) throw new NotFoundError('Communication profile not found.');

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.communicationProfile.update({
        where: { id },
        data: {
          ...(body.name !== undefined && { name: stripHtml(body.name) }),
          ...(body.config !== undefined && { config: body.config }),
          ...(body.isActive !== undefined && { isActive: body.isActive }),
        },
      });
      await auditLog({
        action: 'COMMUNICATION_PROFILE_UPDATED', targetType: 'CommunicationProfile', targetId: id,
        beforeValue: { name: before.name, config: maskConfig(before.config), isActive: before.isActive },
        afterValue: { name: row.name, config: maskConfig(row.config), isActive: row.isActive },
        userId: ctx.userId, userRole: ctx.userRole, ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
      return row;
    });
    return { ...updated, config: maskConfig(updated.config) };
  });

  app.delete('/:id', {
    preHandler: [app.requirePermission('COMM_PROFILE_DELETE')],
    schema: {
      tags: ['Data Injection'], summary: 'Delete communication profile',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  }, async (req, reply) => {
    if (!(await enforceReauth('DELETE_COMM_PROFILE', req, reply)).ok) return reply;
    const { id } = req.params as { id: string };
    const ctx = buildContext(req);

    const before = await prisma.communicationProfile.findUnique({ where: { id } });
    if (!before) throw new NotFoundError('Communication profile not found.');

    // Gateway/Instrument FKs to communication_profiles are onDelete: Restrict.
    // Prisma would raise P2003 on the delete below, and the global error
    // handler has no mapping for that code (falls through to a bare 500) —
    // so check up front and return a clean, actionable 409 instead.
    const [gatewayCount, instrumentCount] = await Promise.all([
      prisma.gateway.count({ where: { communicationProfileId: id } }),
      prisma.instrument.count({ where: { communicationProfileId: id } }),
    ]);
    if (gatewayCount > 0 || instrumentCount > 0) {
      throw new ConflictError(
        `Cannot delete communication profile '${before.name}': in use by ${gatewayCount} gateway(s) and ${instrumentCount} instrument(s).`,
        'PROFILE_IN_USE',
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.communicationProfile.delete({ where: { id } });
      await auditLog({
        action: 'COMMUNICATION_PROFILE_DELETED', targetType: 'CommunicationProfile', targetId: id,
        beforeValue: { name: before.name, protocolKey: before.protocolKey },
        userId: ctx.userId, userRole: ctx.userRole, ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
    });
    return { success: true };
  });
}
