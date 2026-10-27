import { type FastifyInstance, type FastifyRequest } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
import { buildContext } from '../../lib/build-context.js';
import { enforceReauthAlways } from '../../lib/reauth-check.js';
import { errorResponses } from '../../lib/error-schemas.js';
import { resolveVisibility, withVisibility } from './visibility.js';
import { invalidateIngestAuthCache } from './ingest-auth.js';
import { invalidateChildMapCache } from './gateway-children.js';
import { kickMqttClient } from './broker-kick.js';
import { codeLabel } from './code-label.js';
import {
  DeviceCaNotConfiguredError,
  buildCertificateBundle,
  deviceCaAvailable,
  issueDeviceCertificate,
  serverCaPem,
} from './device-ca.js';

/**
 * DEVICE CERTIFICATES (2026-10-27) — issue, re-issue and revoke the ONE client
 * certificate an instrument's device may present when its profile requires
 * one (spec docs/superpowers/specs/2026-10-27-device-certificates-design.md).
 *
 * Gated exactly like `POST /:id/regenerate-token`, for the same reasons: it
 * hands out a live credential (the private key, once) and it cuts the field
 * device off until it is reconfigured — INSTRUMENT_UPDATE plus an ALWAYS-ON
 * password re-auth (`enforceReauthAlways`, not a per-role toggle), scoped to
 * the caller's instrument view (out of view = 404), one audit row per act.
 *
 * After every change: the ingest-auth cache is dropped so the new issue id is
 * judged on the very next reading (re-issue must kill the old certificate at
 * once, not after the 10 s TTL), the gateway child map too when the
 * instrument is a child, and the MQTT session is kicked so the device
 * reconnects and is judged again at CONNECT — the kick is a no-op where the
 * EMQX API key is not provisioned (then the next reconnect applies it).
 */

const issuedProps = {
  type: 'object', nullable: true,
  properties: {
    issueId: { type: 'string' },
    fingerprint: { type: 'string' },
    issuedAt: { type: 'string', format: 'date-time' },
    issuedBy: { type: 'string', nullable: true },
    notAfter: { type: 'string', format: 'date-time' },
  },
} as const;

const idParams = { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } } as const;

async function visibleWhere(req: FastifyRequest, id: string): Promise<{ id: string }> {
  const { where: visibility } = await resolveVisibility(buildContext(req));
  return withVisibility({ id }, visibility) as { id: string };
}

/** A safe file name for the download — instrument codes carry `/` here. */
function bundleFileName(code: string): string {
  return `${code.replace(/[^A-Za-z0-9._-]+/g, '_')}-device-certificate.zip`;
}

function issuedView(row: {
  deviceCertIssueId: string | null; deviceCertFingerprint: string | null;
  deviceCertIssuedAt: Date | null; deviceCertIssuedBy: string | null; deviceCertNotAfter: Date | null;
}) {
  if (!row.deviceCertIssueId) return null;
  return {
    issueId: row.deviceCertIssueId,
    fingerprint: row.deviceCertFingerprint ?? '',
    issuedAt: row.deviceCertIssuedAt?.toISOString() ?? '',
    issuedBy: row.deviceCertIssuedBy,
    notAfter: row.deviceCertNotAfter?.toISOString() ?? '',
  };
}

async function afterCertificateChange(inst: { id: string; code: string; gatewayId: string | null }, why: string): Promise<void> {
  invalidateIngestAuthCache(inst.id);
  if (inst.gatewayId) invalidateChildMapCache(inst.gatewayId);
  await kickMqttClient(inst.code, why);
}

export default async function deviceCertificateRoutes(app: FastifyInstance) {
  app.get('/:id/device-certificate', {
    preHandler: [app.requirePermission('INSTRUMENT_READ')],
    schema: {
      tags: ['Instruments'],
      summary: 'Device certificate status',
      description: 'Whether device certificates are set up on this server (`available`), whether the instrument\'s profile requires one (`required`), and the current certificate\'s metadata. Never returns key material.',
      params: idParams,
      response: {
        200: {
          type: 'object',
          properties: {
            available: { type: 'boolean' },
            required: { type: 'boolean' },
            profileName: { type: 'string' },
            issued: issuedProps,
            // The EFFECTIVE requirement (final review, 2026-10-27). For a
            // gateway: the ACTIVE children whose profile requires a
            // certificate — the gateway must then present its OWN to report
            // for them, and is refused on MQTT without it. For a child: its
            // gateway, and whether that gateway holds a certificate — readings
            // it sends through the gateway ride on the gateway's.
            requiredForChildrenCount: { type: 'integer' },
            requiredForChildren: { type: 'array', items: { type: 'string' } },
            gateway: {
              type: 'object', nullable: true,
              properties: { code: { type: 'string' }, certificateIssued: { type: 'boolean' } },
            },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const inst = await prisma.instrument.findFirst({
      where: await visibleWhere(req, id),
      include: {
        profile: { select: { name: true, requireDeviceCertificate: true } },
        gateway: { select: { code: true, deviceCertIssueId: true } },
      },
    });
    if (!inst) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Instrument not found.' });
    // A gateway's requirement follows from ALL of its children, so the COUNT is
    // unscoped; the CODES named are only those this caller may see (an
    // out-of-view instrument is never named — the visibility rule).
    const requiringWhere = { gatewayId: inst.id, isActive: true, profile: { requireDeviceCertificate: true } };
    const [requiringCount, requiringVisible] = inst.isGateway
      ? await Promise.all([
          prisma.instrument.count({ where: requiringWhere }),
          prisma.instrument.findMany({
            where: withVisibility(requiringWhere, (await resolveVisibility(buildContext(req))).where) as never,
            select: { code: true }, orderBy: { code: 'asc' },
          }),
        ])
      : [0, []];
    return {
      available: deviceCaAvailable(),
      required: inst.profile.requireDeviceCertificate,
      profileName: inst.profile.name,
      issued: issuedView(inst),
      requiredForChildrenCount: requiringCount,
      requiredForChildren: requiringVisible.map((c) => c.code),
      gateway: inst.gateway ? { code: inst.gateway.code, certificateIssued: inst.gateway.deviceCertIssueId !== null } : null,
    };
  });

  app.post('/:id/device-certificate', {
    preHandler: [app.requirePermission('INSTRUMENT_UPDATE')],
    schema: {
      tags: ['Instruments'],
      summary: 'Issue or re-issue the device certificate',
      description: 'Issues a new client certificate for this instrument and returns it ONCE as a base64 zip (`client.crt`, `client.key`, and the server `ca.crt` when known). Any previous certificate stops working immediately. The private key is not kept. Requires INSTRUMENT_UPDATE and an ALWAYS-ON password re-auth (`x-reauth-password`). 409 `DEVICE_CA_NOT_CONFIGURED` when the server has no device CA.',
      params: idParams,
      response: {
        200: {
          type: 'object',
          properties: {
            issued: issuedProps,
            fileName: { type: 'string' },
            bundle: { type: 'string', description: 'base64 zip' },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauthAlways('ISSUE_DEVICE_CERTIFICATE', req, reply);
    if (!ok) return;

    const { id } = req.params as { id: string };
    const existing = await prisma.instrument.findFirst({ where: await visibleWhere(req, id) });
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Instrument not found.' });
    if (!deviceCaAvailable()) {
      return reply.code(409).send({ error: 'DEVICE_CA_NOT_CONFIGURED', message: new DeviceCaNotConfiguredError().message });
    }

    let issued;
    try {
      issued = await issueDeviceCertificate(existing.code);
    } catch (e) {
      // Only the "not configured" race (files removed between the check and
      // the read) is a 409; anything else is a real fault and propagates.
      if (e instanceof DeviceCaNotConfiguredError) {
        return reply.code(409).send({ error: e.code, message: e.message });
      }
      throw e;
    }

    const ctx = buildContext(req);
    const issuedAt = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.instrument.update({
        where: { id },
        data: {
          deviceCertIssueId: issued.issueId,
          deviceCertFingerprint: issued.fingerprint,
          deviceCertNotAfter: issued.notAfter,
          deviceCertIssuedAt: issuedAt,
          deviceCertIssuedBy: ctx.userId,
        },
      });
      await auditLog({
        action: 'DEVICE_CERTIFICATE_ISSUED', targetType: 'Instrument', targetId: id,
        afterValue: {
          code: existing.code, issueId: issued.issueId, fingerprint: issued.fingerprint,
          notAfter: issued.notAfter.toISOString(), replacedIssueId: existing.deviceCertIssueId,
        },
        signatureMeaning: existing.deviceCertIssueId
          ? `Device certificate for instrument "${codeLabel(existing.code)}" re-issued; previous certificate revoked`
          : `Device certificate for instrument "${codeLabel(existing.code)}" issued`,
        userId: ctx.userId, userRole: ctx.userRole,
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
      return row;
    });

    await afterCertificateChange(existing, 'device certificate issued');
    return {
      issued: issuedView(updated),
      fileName: bundleFileName(existing.code),
      bundle: buildCertificateBundle(issued, serverCaPem()).toString('base64'),
    };
  });

  app.delete('/:id/device-certificate', {
    preHandler: [app.requirePermission('INSTRUMENT_UPDATE')],
    schema: {
      tags: ['Instruments'],
      summary: 'Revoke the device certificate',
      description: 'Clears the instrument\'s certificate: if its profile requires one, its data is refused until a new one is issued. Requires INSTRUMENT_UPDATE and an ALWAYS-ON password re-auth. 409 `NOT_ISSUED` when there is none.',
      params: idParams,
      response: {
        200: { type: 'object', properties: { success: { type: 'boolean' } } },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauthAlways('REVOKE_DEVICE_CERTIFICATE', req, reply);
    if (!ok) return;

    const { id } = req.params as { id: string };
    const existing = await prisma.instrument.findFirst({ where: await visibleWhere(req, id) });
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Instrument not found.' });
    if (!existing.deviceCertIssueId) {
      return reply.code(409).send({ error: 'NOT_ISSUED', message: 'This instrument has no device certificate.' });
    }

    const ctx = buildContext(req);
    await prisma.$transaction(async (tx) => {
      await tx.instrument.update({
        where: { id },
        data: {
          deviceCertIssueId: null, deviceCertFingerprint: null, deviceCertNotAfter: null,
          deviceCertIssuedAt: null, deviceCertIssuedBy: null,
        },
      });
      await auditLog({
        action: 'DEVICE_CERTIFICATE_REVOKED', targetType: 'Instrument', targetId: id,
        beforeValue: {
          code: existing.code, issueId: existing.deviceCertIssueId, fingerprint: existing.deviceCertFingerprint,
        },
        signatureMeaning: `Device certificate for instrument "${codeLabel(existing.code)}" revoked`,
        userId: ctx.userId, userRole: ctx.userRole,
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
    });

    await afterCertificateChange(existing, 'device certificate revoked');
    return { success: true };
  });
}
