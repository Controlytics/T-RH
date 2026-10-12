import { type FastifyInstance } from 'fastify';
import { ldapService } from './ldap.service.js';
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
import { maskSecrets } from '../../lib/mask-secrets.js';
import { stripPrivateFields, enforceReauth } from '../../lib/reauth-check.js';

// Audit allowlist — see lib/mask-secrets.ts. This was `{ ...body,
// bindPassword: '********' }`: a denylist that happens to be complete only
// because bindPassword is currently the shape's single secret. The PUT body is
// `additionalProperties: true`, so it would leak any secret field added later.
// `roleMappings` is safe and worth keeping legible — it is the privilege-
// granting part of this config, so an inspector needs to see what changed.
const LDAP_AUDIT_SAFE_KEYS = [
  'enabled', 'serverUrl', 'bindDN', 'searchBase', 'searchFilter',
  'usernameAttribute', 'emailAttribute', 'fullNameAttribute',
  'departmentAttribute', 'groupAttribute', 'tlsRejectUnauthorized',
  'connectionTimeout', 'roleMappings', 'ldapGroup', 'role',
  'defaultRole', 'defaultOrganizationId', 'syncAttributes',
  // Access-granting configuration — an inspector must be able to see who was
  // allowed in and under which role, so these belong in the audit payload
  // alongside roleMappings. Neither is a secret.
  'requiredGroups', 'strictRoleMapping',
];

export default async function ldapRoutes(app: FastifyInstance) {
  // GET /api/ldap/config
  app.get('/config', {
    preHandler: [app.requirePermission('CONFIG_READ')],
    schema: { tags: ['LDAP'], summary: 'Get LDAP configuration' },
  }, async () => {
    const config = await ldapService.getConfig();
    return { ...config, bindPassword: config.bindPassword ? '********' : '' };
  });

  // PUT /api/ldap/config
  app.put('/config', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: {
      tags: ['LDAP'],
      summary: 'Update LDAP configuration',
      body: { type: 'object', additionalProperties: true },
    },
  }, async (req, reply) => {
    // Audit 2026-05-04 fix #5 (web-routes review H2): LDAP bind credentials
    // and base-DN are the source-of-trust for every login flow. Tampering
    // with them can redirect every login to an attacker-controlled
    // directory.
    const { ok } = await enforceReauth('UPDATE_LDAP_CONFIG', req, reply);
    if (!ok) return;
    const body = req.body as Record<string, any>;
    stripPrivateFields(body as Record<string, unknown>);
    // Role mappings grant roles: a non-SUPER_ADMIN may only name roles below
    // its own (application review 2026-10-12, finding 7).
    await ldapService.assertRoleTargetsWithinCaller(req.user.role, body);

    // The config row and its audit row commit together (§11).
    await prisma.$transaction(async (tx) => {
      await ldapService.saveConfig(body, req.user.username, tx);
      await auditLog({
        userId: req.user.username,
        userRole: req.user.role,
        action: 'LDAP_CONFIG_UPDATED',
        targetType: 'system_config',
        targetId: 'ldap',
        afterValue: maskSecrets(body, LDAP_AUDIT_SAFE_KEYS),
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        sessionId: req.user.sessionId,
      }, tx);
    });

    return { success: true, message: 'LDAP configuration updated' };
  });

  // POST /api/ldap/test-connection
  app.post('/test-connection', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: {
      tags: ['LDAP'],
      summary: 'Test LDAP connection',
      body: { type: 'object', additionalProperties: true },
    },
  }, async (req, reply) => {
    // A test binds with the service-account credential, the stored one when
    // the target is unchanged — the same e-signature as saving it
    // (application review 2026-10-12, finding 2).
    const { ok } = await enforceReauth('UPDATE_LDAP_CONFIG', req, reply);
    if (!ok) return;
    const body = req.body as Record<string, any>;
    stripPrivateFields(body as Record<string, unknown>);
    const hasConfig = body && Object.keys(body).length > 0;
    // Refuses (400) a new server/bind DN that brings no password of its own.
    const cfg = await ldapService.resolveTestConfig(hasConfig ? body : undefined);
    const result = await ldapService.testConnection(cfg);
    // Every test is recorded: who bound to which directory, and the outcome.
    // Allowlisted fields only — never the password.
    await auditLog({
      userId: req.user.username,
      userRole: req.user.role,
      action: 'LDAP_CONNECTION_TESTED',
      targetType: 'system_config',
      targetId: 'ldap',
      afterValue: {
        serverUrl: cfg.serverUrl, bindDN: cfg.bindDN,
        passwordSource: hasConfig && body.bindPassword && body.bindPassword !== '********' ? 'typed' : 'stored',
        success: result.success, message: result.message.slice(0, 300),
      },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      sessionId: req.user.sessionId,
    });
    return result;
  });

  // GET /api/ldap/status
  app.get('/status', {
    preHandler: [app.requirePermission('CONFIG_READ')],
    schema: { tags: ['LDAP'], summary: 'Get LDAP status' },
  }, async () => {
    const config = await ldapService.getConfig();
    return { enabled: config.enabled, serverUrl: config.serverUrl || null };
  });
}
