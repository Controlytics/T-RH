import { type FastifyInstance } from 'fastify';
import { userIdConfigSchema } from '@digilog/shared';
import { enforceReauth } from '../../../lib/reauth-check.js';
import { buildContext } from '../../../lib/build-context.js';
import { configService } from '../config.service.js';

export async function userIdRoutes(app: FastifyInstance) {
  app.get('/user-id', {
    preHandler: [app.requirePermission('CONFIG_READ')],
    schema: {
      tags: ['Config'],
      summary: 'Get User ID configuration',
      description: 'Retrieve the current User ID format and auto-generation settings.',
      response: {
        200: { type: 'object', additionalProperties: true, description: 'User ID configuration object' },
      },
    },
  }, async () => {
    return configService.getConfig('user-id', userIdConfigSchema);
  });

  app.put('/user-id', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: {
      tags: ['Config'],
      summary: 'Update User ID configuration',
      description: 'Update User ID format, prefix, auto-generation, and validation settings. Requires CONFIG_UPDATE permission.',
      body: { type: 'object', description: 'User ID configuration values' },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'object', additionalProperties: true },
          },
        },
        400: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            details: { type: 'object' },
          },
        },
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_USERID_CONFIG', req, reply);
    if (!ok) return;

    const ctx = buildContext(req);
    const data = await configService.updateConfig('user-id', req.body, userIdConfigSchema, 'user', false, ctx);
    return { success: true, data };
  });

  app.get('/user-id/next', {
    preHandler: [app.requirePermission('USER_CREATE')],
    schema: {
      tags: ['Config'],
      summary: 'Get next available User ID',
      description: 'Compute and return the next auto-generated User ID based on current configuration and existing users.',
      response: {
        200: {
          type: 'object',
          properties: {
            autoGenerate: { type: 'boolean' },
            nextId: { type: ['string', 'null'] },
          },
        },
      },
    },
  }, async () => {
    return configService.getNextUserId(userIdConfigSchema);
  });

  app.post('/user-id/validate', {
    preHandler: [app.requirePermission('USER_CREATE')],
    schema: {
      tags: ['Config'],
      summary: 'Validate a User ID',
      description: 'Validate a proposed User ID against the current User ID configuration rules (length, prefix, format, case).',
      body: {
        type: 'object',
        required: ['userId'],
        properties: {
          userId: { type: 'string', description: 'The User ID to validate' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            valid: { type: 'boolean' },
            errors: { type: 'array', items: { type: 'string' } },
          },
        },
        400: {
          type: 'object',
          properties: {
            valid: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
      },
    },
  }, async (req, reply) => {
    const { userId } = req.body as { userId: string };
    if (!userId) {
      return reply.code(400).send({ valid: false, error: 'User ID is required' });
    }
    return configService.validateUserId(userId);
  });
}
