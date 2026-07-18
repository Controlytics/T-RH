import { type FastifyInstance } from 'fastify';
import { passwordPolicySchema, loginSecuritySchema, sessionConfigSchema, datetimeConfigSchema, paginationConfigSchema, exportLimitConfigSchema } from '@digilog/shared';
import { verifyPassword } from '../../lib/password.js';
import { enforceReauth } from '../../lib/reauth-check.js';
import { errorResponses } from '../../lib/error-schemas.js';
import { buildContext } from '../../lib/build-context.js';
import { configService } from './config.service.js';
import { configRepository } from './config.repository.js';
import { prisma } from '../../lib/prisma.js';

// Extracted route groups — one file per config surface under static-routes/.
// See each file for the specific endpoints. Adding a new config tab should follow
// the same pattern: create static-routes/<surface>.routes.ts, then register below.
import { actionReauthRoutes } from './static-routes/action-reauth.routes.js';
import { brandingRoutes } from './static-routes/branding.routes.js';
import { userIdRoutes } from './static-routes/user-id.routes.js';
import { fieldIdsRoutes } from './static-routes/field-ids.routes.js';
import { auditTemplatesRoutes } from './static-routes/audit-templates.routes.js';
import { dashboardCardsRoutes } from './static-routes/dashboard-cards.routes.js';
import { tabletAccessRoutes } from './static-routes/tablet-access.routes.js';
import { accessMatrixRoutes } from './static-routes/access-matrix.routes.js';
import { rolesConfigRoutes } from './static-routes/roles.routes.js';
import { cleaningProfileAssignmentRoutes } from './static-routes/cleaning-profile-assignment.routes.js';
import { reportPageTitlesRoutes } from './static-routes/report-page-titles.routes.js';
import { reportLabelsRoutes } from './static-routes/report-labels.routes.js';
import { offlineCacheRoutes } from './static-routes/offline-cache.routes.js';
import { exportOptionsRoutes } from './static-routes/export-options.routes.js';
import { replacementScheduleFiltersRoutes } from './static-routes/replacement-schedule-filters.routes.js';
import { pmScheduleFiltersRoutes } from './static-routes/pm-schedule-filters.routes.js';
import { reportSignatoriesRoutes } from './static-routes/report-signatories.routes.js';
import { ahuCompletionProcessRoutes } from './static-routes/ahu-completion-process.routes.js';
import { blockChangeApprovalRoutes } from './static-routes/block-change-approval.routes.js';

// Map config keys to reauth action names (consumed by the generic configEndpoint factory).
const CONFIG_KEY_TO_ACTION: Record<string, string> = {
  'password-policy': 'UPDATE_PASSWORD_POLICY',
  'login-security': 'UPDATE_LOGIN_SECURITY',
  'session': 'UPDATE_SESSION_CONFIG',
  'datetime': 'UPDATE_DATETIME_CONFIG',
};

export default async function configRoutes(app: FastifyInstance) {
  // Register extracted route groups
  await actionReauthRoutes(app);
  await brandingRoutes(app);
  await userIdRoutes(app);
  await fieldIdsRoutes(app);
  await auditTemplatesRoutes(app);
  await dashboardCardsRoutes(app);
  await tabletAccessRoutes(app);
  await accessMatrixRoutes(app);
  await exportOptionsRoutes(app);
  await replacementScheduleFiltersRoutes(app);
  await pmScheduleFiltersRoutes(app);
  await reportSignatoriesRoutes(app);
  await rolesConfigRoutes(app);
  await cleaningProfileAssignmentRoutes(app);
  await reportPageTitlesRoutes(app);
  await reportLabelsRoutes(app);
  await offlineCacheRoutes(app);
  await ahuCompletionProcessRoutes(app);
  await blockChangeApprovalRoutes(app);

  // Generic CRUD factory for configs whose only work is get/update a typed blob.
  // Used for: password-policy, login-security, session, datetime, pagination.
  const configEndpoint = (key: string, schema: any, requiresReauth: boolean) => {
    const titleKey = key.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

    app.get(`/${key}`, {
      preHandler: [app.requirePermission('CONFIG_READ')],
      schema: {
        tags: ['Config'],
        summary: `Get ${titleKey} configuration`,
        description: `Retrieve the current ${titleKey} configuration. Returns defaults if not yet configured.`,
        response: {
          200: { type: 'object', additionalProperties: true, description: `${titleKey} configuration object` },
        },
      },
    }, async () => {
      return configService.getConfig(key, schema);
    });

    app.put(`/${key}`, {
      preHandler: [app.requirePermission('CONFIG_UPDATE')],
      schema: {
        tags: ['Config'],
        summary: `Update ${titleKey} configuration`,
        description: `Update the ${titleKey} configuration. ${requiresReauth ? 'Changes require user re-authentication.' : ''}`,
        body: { type: 'object', description: `${titleKey} configuration values` },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: { type: 'object', additionalProperties: true },
            },
          },
          ...errorResponses,
        },
      },
    }, async (req, reply) => {
      const body = req.body as Record<string, unknown>;

      // Dynamic re-auth from action-reauth config
      const actionKey = CONFIG_KEY_TO_ACTION[key];
      if (actionKey) {
        const { ok } = await enforceReauth(actionKey, req, reply);
        if (!ok) return;
      }

      // Hardcoded re-auth: always required for sensitive config changes.
      // Skip if dynamic enforceReauth already verified the password.
      if (requiresReauth && !(req as any)._reauthVerified) {
        // Accept the password from either the body (UI submits via
        // _currentPassword) or the x-reauth-password header (matches
        // enforceReauth and the e2e test helpers). Without this fallback,
        // configs that aren't in the dynamic action-reauth registry (eg
        // datetime) would always 401 even when the caller did supply the
        // header.
        const currentPassword =
          (body._currentPassword as string | undefined)
          ?? (req.headers['x-reauth-password'] as string | undefined);
        if (!currentPassword) {
          return reply.code(401).send({ error: 'REAUTH_REQUIRED', message: 'Current password is required to modify this configuration.' });
        }
        const user = await configRepository.findUserById(req.user.sub);
        if (!user) {
          return reply.code(401).send({ error: 'REAUTH_FAILED', message: 'User not found.' });
        }
        const passwordValid = await verifyPassword(currentPassword, (user as any).passwordHash);
        if (!passwordValid) {
          return reply.code(401).send({ error: 'REAUTH_FAILED', message: 'Incorrect password. Please try again.' });
        }
        delete body._currentPassword;
      }

      const ctx = buildContext(req);
      const data = await configService.updateConfig(key, body, schema, 'security', requiresReauth, ctx);
      return { success: true, data };
    });
  };

  configEndpoint('password-policy', passwordPolicySchema, true);
  configEndpoint('login-security', loginSecuritySchema, true);
  configEndpoint('session', sessionConfigSchema, true);
  configEndpoint('datetime', datetimeConfigSchema, true);
  configEndpoint('pagination', paginationConfigSchema, false);
  configEndpoint('export-limit', exportLimitConfigSchema, false);

  // Public reads — all authenticated users (no admin permission required).
  app.get('/password-policy/current', {
    schema: {
      tags: ['Config'],
      summary: 'Get current password policy settings',
      description: 'Retrieve the current password policy (session timeout, expiry). Available to all authenticated users.',
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async () => {
    return configService.getConfig('password-policy', passwordPolicySchema);
  });

  app.get('/pagination/current', {
    schema: {
      tags: ['Config'],
      summary: 'Get current pagination settings',
      description: 'Retrieve the current pagination options (records per page). Available to all authenticated users.',
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async () => {
    return configService.getConfig('pagination', paginationConfigSchema);
  });

  app.get('/datetime/current', {
    schema: {
      tags: ['Config'],
      summary: 'Get current datetime format settings',
      description: 'Retrieve the current date/time format configuration. Available to all authenticated users.',
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async () => {
    return configService.getConfig('datetime', datetimeConfigSchema);
  });

  // Public read — all authenticated users. Every export page (operators
  // included) reads the configured limit here so a raised limit reaches every
  // role, not just admins who can hit the CONFIG_READ-gated endpoint above.
  app.get('/export-limit/current', {
    schema: {
      tags: ['Config'],
      summary: 'Get current export-limit settings',
      description: 'Retrieve the current export record limit and message. Available to all authenticated users.',
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async () => {
    return configService.getConfig('export-limit', exportLimitConfigSchema);
  });
}
