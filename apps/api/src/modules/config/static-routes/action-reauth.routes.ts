import { type FastifyInstance } from 'fastify';
import { actionReauthConfigSchema } from '@digilog/shared';
import { errorResponses } from '../../../lib/error-schemas.js';
import { buildContext } from '../../../lib/build-context.js';
import { configService } from '../config.service.js';
import { enforceReauth } from '../../../lib/reauth-check.js';

// Action Re-authentication Configuration routes.
// Extracted from the main config/routes.ts monolith — see TODO in that file
// for the full extraction plan.
export async function actionReauthRoutes(app: FastifyInstance) {
  // GET full config (SUPER_ADMIN via CONFIG_READ)
  app.get('/action-reauth', {
    preHandler: [app.requirePermission('CONFIG_READ')],
    schema: {
      tags: ['Config'],
      summary: 'Get action re-authentication configuration',
      description: 'Retrieve the full action re-authentication matrix. Each key is an action name, each value is an array of role names that require re-auth for that action.',
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async () => {
    return configService.getActionReauth();
  });

  // PUT update config
  app.put('/action-reauth', {
    // M6 (2026-06-30): the reauth policy is security-meta administration → ROLE_MANAGE,
    // not generic CONFIG_UPDATE. Standalone /config/action-reauth page is SUPER_ADMIN-only
    // (bypasses), Re-auth tab lives in the ROLE_MANAGE-gated Roles & Access page.
    preHandler: [app.requirePermission('ROLE_MANAGE')],
    schema: {
      tags: ['Config'],
      summary: 'Update action re-authentication configuration',
      description: 'Set which actions require password re-authentication for each role. Pass an object mapping action names to arrays of role names.',
      body: { type: 'object', additionalProperties: true },
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
    // Audit 2026-05-04 fix (web-routes review C6): the action-reauth save
    // itself bypassed reauth — trivial privilege escalation (admin disables
    // reauth on DELETE_USER, then deletes users without challenge). Gate
    // this endpoint behind UPDATE_REAUTH_CONFIG so the meta-policy edit is
    // itself password-challenged.
    const { ok } = await enforceReauth('UPDATE_REAUTH_CONFIG', req, reply);
    if (!ok) return;
    const ctx = buildContext(req);
    const data = await configService.updateActionReauth(req.body, actionReauthConfigSchema, ctx);
    return { success: true, data };
  });

  // GET check single action
  app.get('/action-reauth/check', {
    schema: {
      tags: ['Config'],
      summary: 'Check if action requires re-authentication',
      description: 'Check if a specific action requires password re-authentication for the current user\'s role.',
      querystring: {
        type: 'object',
        required: ['action'],
        properties: { action: { type: 'string', description: 'Action key (e.g. DELETE_USER)' } },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            action: { type: 'string' },
            required: { type: 'boolean' },
          },
        },
      },
    },
  }, async (req) => {
    const { action } = req.query as { action: string };
    return configService.checkReauth(action, req.user.role);
  });

  // GET all re-auth actions for current user's role
  app.get('/action-reauth/my-actions', {
    schema: {
      tags: ['Config'],
      summary: 'Get re-auth actions for current user',
      description: 'Returns all action keys that require password re-authentication for the current user\'s role. Used by frontend to show/hide re-auth dialogs.',
      response: {
        200: {
          type: 'object',
          properties: { actions: { type: 'array', items: { type: 'string' } } },
        },
      },
    },
  }, async (req) => {
    return configService.getMyActions(req.user.role);
  });
}
