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
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { buildContext } from '../../lib/build-context.js';
import { auditLog } from '../../lib/audit.js';
import { enforceReauth } from '../../lib/reauth-check.js';
import { maskSecrets } from '../../lib/mask-secrets.js';
import { stripHtml } from '../../lib/sanitize.js';
import { NotFoundError, ValidationError, ConflictError } from '../../lib/errors.js';

// Two allowlists for two different audiences (fix round 1, finding #1) —
// DELIBERATELY MAINTAINED SEPARATELY, not derived from one another (fix round
// 2: an earlier version derived AUDIT_SAFE_KEYS by filtering RESPONSE_SAFE_KEYS,
// which meant a future key added only to RESPONSE_SAFE_KEYS — e.g. a protocol
// adds `callbackUrl`/`proxyUrl` — would silently inherit into the audit list
// too, with nobody touching or even aware of the exclusion. That inverts
// mask-secrets.ts's own fail-closed guarantee: "an unrecognised key is
// redacted until a human deliberately declares it safe." A new config key
// must be added to EACH list independently — do not re-derive one from the
// other, however tempting the near-duplication looks.
//
// - RESPONSE_SAFE_KEYS gates the GET/POST/PUT response body. That path is
//   already behind COMM_PROFILE_VIEW, and an admin editing a profile needs
//   to see the broker URL / endpoint or the edit form is unusable.
// - AUDIT_SAFE_KEYS gates beforeValue/afterValue written into audit_trail.
//   STRICT — url/endpoint/brokerUrl are deliberately absent here. Broker URLs
//   commonly carry userinfo (mqtts://user:pass@host:8883) and this registry
//   also seeds `rest` + `webhook`, whose URLs commonly carry API keys as query
//   params. AUDIT_READ is held by far more roles than CONFIG_UPDATE, and the
//   write is permanent + hash-chained (21 CFR §11.10(e)) — unlike the SMTP/SMS
//   audit allowlists this borrows the pattern from (see
//   notification-delivery/routes.ts's EMAIL_AUDIT_SAFE_KEYS /
//   SMS_AUDIT_SAFE_KEYS), there is no per-field rehydration step here to make
//   omitting a URL merely inconvenient — so it stays out of the strict list
//   entirely. Redacting something harmless is the cheap error; leaking a
//   credential into an unscrubbable chain forever is the expensive one.
//
// Both fall through to maskSecrets' REDACTED default for anything not
// listed — password, token, apiKey, secret, certificate/key material, etc.
const COMM_PROFILE_RESPONSE_SAFE_KEYS = [
  'brokerUrl', 'host', 'port', 'url', 'endpoint', 'path',
  'qos', 'topic', 'topicPrefix', 'clientId', 'username',
  'useTls', 'tls', 'protocolVersion', 'keepAlive', 'retain', 'clean',
  'pollIntervalMs', 'timeout', 'connectTimeout', 'reconnectPeriod',
  'unitId', 'baudRate', 'dataBits', 'stopBits', 'parity',
  'region', 'deviceId', 'apiVersion',
];
const COMM_PROFILE_AUDIT_SAFE_KEYS = [
  'host', 'port', 'path',
  'qos', 'topic', 'topicPrefix', 'clientId', 'username',
  'useTls', 'tls', 'protocolVersion', 'keepAlive', 'retain', 'clean',
  'pollIntervalMs', 'timeout', 'connectTimeout', 'reconnectPeriod',
  'unitId', 'baudRate', 'dataBits', 'stopBits', 'parity',
  'region', 'deviceId', 'apiVersion',
];

function maskForResponse(config: unknown): unknown {
  return maskSecrets(config, COMM_PROFILE_RESPONSE_SAFE_KEYS);
}
function maskForAudit(config: unknown): unknown {
  return maskSecrets(config, COMM_PROFILE_AUDIT_SAFE_KEYS);
}

/** True for a Prisma foreign-key-violation error (P2003). */
function isFkViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003';
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
    return rows.map(r => ({ ...r, config: maskForResponse(r.config) }));
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
        afterValue: { name: row.name, protocolKey: row.protocolKey, config: maskForAudit(body.config) },
        userId: ctx.userId, userRole: ctx.userRole, ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
      return row;
    });
    return { ...created, config: maskForResponse(created.config) };
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
        beforeValue: { name: before.name, config: maskForAudit(before.config), isActive: before.isActive },
        afterValue: { name: row.name, config: maskForAudit(row.config), isActive: row.isActive },
        userId: ctx.userId, userRole: ctx.userRole, ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
      return row;
    });
    return { ...updated, config: maskForResponse(updated.config) };
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
    // Fix round 1, finding #2: counting outside the transaction that deletes
    // is a TOCTOU gap — a gateway/instrument can attach to this profile in the
    // window between the count and the delete, and the delete would then hit
    // the Restrict FK and raise P2003, which the global error handler has no
    // mapping for (falls through to a bare 500). So the count is re-checked
    // INSIDE the same transaction as the delete (closing the window as far as
    // Postgres's transaction isolation allows), AND a P2003 catch backstops
    // whatever race the re-check still can't close, mapping it to the same
    // clean 409 instead of ever letting it reach the generic error path.
    try {
      await prisma.$transaction(async (tx) => {
        const [gatewayCount, instrumentCount] = await Promise.all([
          tx.gateway.count({ where: { communicationProfileId: id } }),
          tx.instrument.count({ where: { communicationProfileId: id } }),
        ]);
        if (gatewayCount > 0 || instrumentCount > 0) {
          throw new ConflictError(
            `Cannot delete communication profile '${before.name}': in use by ${gatewayCount} gateway(s) and ${instrumentCount} instrument(s).`,
            'PROFILE_IN_USE',
          );
        }

        await tx.communicationProfile.delete({ where: { id } });
        await auditLog({
          action: 'COMMUNICATION_PROFILE_DELETED', targetType: 'CommunicationProfile', targetId: id,
          beforeValue: { name: before.name, protocolKey: before.protocolKey },
          userId: ctx.userId, userRole: ctx.userRole, ipAddress: ctx.ipAddress,
          userAgent: ctx.userAgent, sessionId: ctx.sessionId,
        }, tx);
      });
    } catch (err) {
      if (err instanceof ConflictError) throw err;
      if (isFkViolation(err)) {
        throw new ConflictError(
          `Cannot delete communication profile '${before.name}': in use by a gateway or instrument.`,
          'PROFILE_IN_USE',
        );
      }
      throw err;
    }
    return { success: true };
  });
}
