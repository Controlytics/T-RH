import { type FastifyInstance } from 'fastify';
import { createUserSchema, updateUserSchema, resetPasswordSchema, userQuerySchema, bulkDeleteUsersSchema } from '@digilog/shared';
import { enforceReauth } from '../../lib/reauth-check.js';
import { buildContext } from '../../lib/build-context.js';
import { errorResponses } from '../../lib/error-schemas.js';
import { userService } from './user.service.js';
import { sweepPasswordExpiryNotifications } from '../auth/password-expiry-sweep.js';

export default async function userRoutes(app: FastifyInstance) {
  // POST /api/users — Create user
  app.post('/', {
    preHandler: [app.requirePermission('USER_CREATE')],
    schema: {
      tags: ['Users'],
      summary: 'Create user',
      description: 'Create a new user. Requires SUPER_ADMIN or ADMIN role.',
      body: {
        type: 'object',
        required: ['username', 'fullName', 'role', 'password', 'confirmPassword'],
        properties: {
          username: { type: 'string', description: 'Must match User ID config' },
          fullName: { type: 'string' },
          // Email is optional; createUserSchema (Zod) enforces the format when a
          // non-empty value is supplied. No `format: 'email'` here so '' passes
          // the Fastify layer.
          email: { type: 'string' },
          department: { type: 'string' },
          role: { type: 'string', description: 'Role name (dynamic, from roles management)' },
          password: { type: 'string', minLength: 8 },
          confirmPassword: { type: 'string' },
          status: { type: 'string', enum: ['ENABLED', 'DISABLED'] },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            id: { type: 'string' }, username: { type: 'string' }, fullName: { type: 'string' },
            email: { type: 'string' }, department: { type: 'string', nullable: true },
            role: { type: 'string' }, status: { type: 'string' }, createdAt: { type: 'string', format: 'date-time' },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('CREATE_USER', req, reply);
    if (!ok) return;

    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
    }

    const result = await userService.create(parsed.data, buildContext(req));
    return reply.code(201).send(result);
  });

  // GET /api/users/stats — User count stats by status
  app.get('/stats', {
    preHandler: [app.requirePermission('USER_READ')],
    schema: {
      tags: ['Users'],
      summary: 'Get user statistics',
      description: 'Returns user counts grouped by status. SUPER_ADMIN sees all users, ADMIN sees all except SUPER_ADMIN.',
      response: {
        200: {
          type: 'object',
          properties: {
            total: { type: 'integer' }, enabled: { type: 'integer' },
            disabled: { type: 'integer' }, locked: { type: 'integer' }, expired: { type: 'integer' },
          },
        },
      },
    },
  }, async (req) => {
    return userService.getStats(req.user.role);
  });

  // POST /api/users/bulk-delete — Requires SUPER_ADMIN
  app.post('/bulk-delete', {
    preHandler: [app.requireSuperAdmin()], // M3 (2026-06-30): delete is SUPER_ADMIN-only (matches UI); was USER_DELETE
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    schema: {
      tags: ['Users'],
      summary: 'Bulk delete users',
      description: 'Permanently delete multiple users and all related data. Requires SUPER_ADMIN.',
      body: {
        type: 'object',
        required: ['userIds'],
        properties: {
          userIds: { type: 'array', items: { type: 'string', format: 'uuid' }, minItems: 1, maxItems: 50 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' }, deletedCount: { type: 'integer' },
            deletedUsers: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, username: { type: 'string' } } } },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('BULK_DELETE_USERS', req, reply);
    if (!ok) return;

    const parsed = bulkDeleteUsersSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
    }

    const result = await userService.bulkDelete(parsed.data.userIds, req.user.sub, buildContext(req));
    return { success: true, ...result };
  });

  // GET /api/users/reset-requests — List password reset requests
  app.get('/reset-requests', {
    preHandler: [app.requirePermission('USER_RESET_PASSWORD')],
    schema: {
      tags: ['Users'], summary: 'List password reset requests', description: 'Get all password reset requests (pending and processed)',
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' }, userId: { type: 'string' },
                  status: { type: 'string', enum: ['PENDING', 'APPROVED', 'REJECTED'] },
                  processedBy: { type: 'string', nullable: true }, notes: { type: 'string', nullable: true },
                  requestedAt: { type: 'string', format: 'date-time' }, processedAt: { type: 'string', format: 'date-time', nullable: true },
                  userFullName: { type: 'string' }, userEmail: { type: 'string' }, userDepartment: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  }, async () => {
    return userService.listResetRequests();
  });

  // GET /api/users/reset-requests/pending — Get count of pending reset requests
  app.get('/reset-requests/pending', {
    preHandler: [app.requirePermission('USER_RESET_PASSWORD')],
    schema: {
      tags: ['Users'], summary: 'Pending reset request count', description: 'Get count of pending password reset requests',
      response: { 200: { type: 'object', properties: { count: { type: 'integer' } } } },
    },
  }, async () => {
    return userService.getPendingResetRequestCount();
  });

  // POST /api/users/reset-requests/:id/process — Process a password reset request
  app.post('/reset-requests/:id/process', {
    preHandler: [app.requirePermission('USER_RESET_PASSWORD')],
    schema: {
      tags: ['Users'], summary: 'Process reset request', description: 'Approve or reject a password reset request',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object', required: ['action'],
        properties: {
          action: { type: 'string', enum: ['approve', 'reject'] },
          newPassword: { type: 'string', description: 'Required when approving' },
          notes: { type: 'string' },
        },
      },
      response: { 200: { type: 'object', properties: { success: { type: 'boolean' }, message: { type: 'string' } } }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('PROCESS_RESET_REQUEST', req, reply);
    if (!ok) return;

    const { id } = req.params as { id: string };
    const body = req.body as { action: 'approve' | 'reject'; newPassword?: string; notes?: string };

    if (!body.action || !['approve', 'reject'].includes(body.action)) {
      return reply.code(400).send({ error: 'VALIDATION', message: 'Invalid action. Must be "approve" or "reject".' });
    }

    const result = await userService.processResetRequest(id, body.action, body.newPassword, body.notes, buildContext(req));
    return { success: true, ...result };
  });

  // GET /api/users — List users
  app.get('/', {
    preHandler: [app.requirePermission('USER_READ')],
    schema: {
      tags: ['Users'],
      summary: 'List users',
      description: 'Paginated user list with search and filters. Requires SUPER_ADMIN or ADMIN role.',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', default: 1 }, limit: { type: 'integer' },
          role: { type: 'string' },
          status: { type: 'string', enum: ['ENABLED', 'DISABLED', 'LOCKED', 'EXPIRED'] },
          search: { type: 'string', description: 'Search by username, name, or email' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' }, username: { type: 'string' }, fullName: { type: 'string' },
                  email: { type: 'string' }, department: { type: 'string', nullable: true },
                  role: { type: 'string' }, status: { type: 'string' },
                  lastLogin: { type: 'string', format: 'date-time', nullable: true },
                  createdAt: { type: 'string', format: 'date-time' }, createdBy: { type: 'string', nullable: true },
                },
              },
            },
            total: { type: 'integer' }, page: { type: 'integer' }, limit: { type: 'integer' }, totalPages: { type: 'integer' },
          },
        },
      },
    },
  }, async (req) => {
    const query = userQuerySchema.parse(req.query);
    return userService.list({ ...query, callerRole: req.user.role });
  });

  // GET /api/users/:id — Get user detail
  app.get('/:id', {
    preHandler: [app.requirePermission('USER_READ')],
    schema: {
      tags: ['Users'],
      summary: 'Get user by ID',
      description: 'Get full user details',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      response: {
        200: {
          type: 'object',
          properties: {
            id: { type: 'string' }, username: { type: 'string' }, fullName: { type: 'string' },
            email: { type: 'string' }, department: { type: 'string', nullable: true },
            role: { type: 'string' }, status: { type: 'string' },
            failedLoginAttempts: { type: 'integer' }, forcePasswordChange: { type: 'boolean' },
            isTemporaryPassword: { type: 'boolean' },
            lastLogin: { type: 'string', format: 'date-time', nullable: true },
            passwordChangedAt: { type: 'string', format: 'date-time', nullable: true },
            createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' },
            createdBy: { type: 'string', nullable: true }, updatedBy: { type: 'string', nullable: true },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req) => {
    const { id } = req.params as { id: string };
    return userService.getById(id);
  });

  // PUT /api/users/:id — Update user
  app.put('/:id', {
    preHandler: [app.requirePermission('USER_UPDATE')],
    schema: {
      tags: ['Users'],
      summary: 'Update user',
      description: 'Update user properties and role',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        properties: {
          // Email is optional — no `format: 'email'` (so '' passes the Fastify
          // layer) and nullable (an emailless user's edit form submits ''/null).
          // Format is enforced by updateUserSchema (Zod) only when non-empty.
          fullName: { type: 'string' }, email: { type: ['string', 'null'] },
          department: { type: 'string' }, role: { type: 'string' },
          status: { type: 'string', enum: ['ENABLED', 'DISABLED'] },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            id: { type: 'string' }, username: { type: 'string' }, fullName: { type: 'string' },
            email: { type: 'string' }, role: { type: 'string' }, status: { type: 'string' },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_USER', req, reply);
    if (!ok) return;

    const { id } = req.params as { id: string };
    const parsed = updateUserSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
    }

    return userService.update(id, parsed.data, buildContext(req));
  });

  // DELETE /api/users/:id — Requires SUPER_ADMIN
  app.delete('/:id', {
    preHandler: [app.requireSuperAdmin()], // M3 (2026-06-30): delete is SUPER_ADMIN-only (matches UI); was USER_DELETE
    schema: {
      tags: ['Users'],
      summary: 'Delete user',
      description: 'Permanently delete a user and all related data. Requires SUPER_ADMIN.',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      response: { 200: { type: 'object', properties: { success: { type: 'boolean' } } }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('DELETE_USER', req, reply);
    if (!ok) return;

    const { id } = req.params as { id: string };
    await userService.delete(id, req.user.sub, buildContext(req));
    return { success: true };
  });

  // POST /api/users/:id/enable
  app.post('/:id/enable', {
    preHandler: [app.requirePermission('USER_ENABLE_DISABLE')],
    schema: {
      tags: ['Users'], summary: 'Enable user', description: 'Re-enable a disabled user account',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      response: { 200: { type: 'object', properties: { success: { type: 'boolean' } } }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('ENABLE_USER', req, reply);
    if (!ok) return;
    const { id } = req.params as { id: string };
    await userService.enable(id, buildContext(req));
    return { success: true };
  });

  // POST /api/users/:id/disable
  app.post('/:id/disable', {
    preHandler: [app.requirePermission('USER_ENABLE_DISABLE')],
    schema: {
      tags: ['Users'], summary: 'Disable user', description: 'Disable a user account and terminate all active sessions',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      response: { 200: { type: 'object', properties: { success: { type: 'boolean' } } }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('DISABLE_USER', req, reply);
    if (!ok) return;
    const { id } = req.params as { id: string };
    await userService.disable(id, buildContext(req));
    return { success: true };
  });

  // POST /api/users/:id/unlock
  app.post('/:id/unlock', {
    preHandler: [app.requirePermission('USER_UNLOCK')],
    schema: {
      tags: ['Users'], summary: 'Unlock user',
      description: 'Unlock a locked user account with a temporary password. User must change password on next login.',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      body: { type: 'object', required: ['newPassword'], properties: { newPassword: { type: 'string', minLength: 8 } } },
      response: { 200: { type: 'object', properties: { success: { type: 'boolean' }, message: { type: 'string' } } }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UNLOCK_USER', req, reply);
    if (!ok) return;
    const { id } = req.params as { id: string };
    const { newPassword } = req.body as { newPassword: string };
    await userService.unlock(id, newPassword, buildContext(req));
    return { success: true, message: 'Account unlocked with temporary password. User must change password on next login.' };
  });

  // POST /api/users/:id/reset-password
  app.post('/:id/reset-password', {
    preHandler: [app.requirePermission('USER_RESET_PASSWORD')],
    schema: {
      tags: ['Users'], summary: 'Reset password', description: 'Admin-initiated password reset. Sets temporary password.',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      body: { type: 'object', required: ['newPassword'], properties: { newPassword: { type: 'string', minLength: 8 } } },
      response: { 200: { type: 'object', properties: { success: { type: 'boolean' }, message: { type: 'string' } } }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('RESET_PASSWORD', req, reply);
    if (!ok) return;
    const { id } = req.params as { id: string };
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
    }
    await userService.resetPassword(id, parsed.data.newPassword, buildContext(req));
    return { success: true, message: 'Password reset successfully. User must change on next login.' };
  });

  // POST /api/users/password-expiry-sweep — run the password-expiry notification
  // sweep now (on-demand; the daily 00:00 cron already runs with the API).
  // Gated by CONFIG_UPDATE — the same permission that governs the password policy.
  app.post('/password-expiry-sweep', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: {
      tags: ['Users'],
      summary: 'Run the password-expiry notification sweep now',
      description: 'Warns users whose passwords are nearing expiry and sends a one-time expiry notice. Idempotent.',
      response: {
        200: { type: 'object', properties: { warned: { type: 'integer' }, expired: { type: 'integer' } }, additionalProperties: false },
        ...errorResponses,
      },
    },
  }, async () => {
    return sweepPasswordExpiryNotifications();
  });
}
