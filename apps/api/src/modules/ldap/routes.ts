import { type FastifyInstance } from 'fastify';
import { ldapService } from './ldap.service.js';
import { auditLog } from '../../lib/audit.js';
import { maskSecrets } from '../../lib/mask-secrets.js';
import { enforceReauth } from '../../lib/reauth-check.js';

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
    await ldapService.saveConfig(body, req.user.username);

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
  }, async (req) => {
    const body = req.body as Record<string, any>;
    const hasConfig = body && Object.keys(body).length > 0;
    return ldapService.testConnection(hasConfig ? body : undefined);
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
