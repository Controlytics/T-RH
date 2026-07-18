import { type FastifyInstance } from 'fastify';
import { errorResponses } from '../../lib/error-schemas.js';
import { enforceReauth } from '../../lib/reauth-check.js';
import { buildContext } from '../../lib/build-context.js';
import { notificationService } from './notification.service.js';

export default async function notificationRoutes(app: FastifyInstance) {
  // GET /api/notifications — list notifications for current user
  // No permission check: notifications are inherently scoped per-user by the service.
  app.get('/', {
    schema: {
      tags: ['Notifications'],
      summary: 'List notifications',
      description: 'Retrieve paginated notifications for the current user. SUPER_ADMIN sees all, ADMIN sees non-SUPER_ADMIN notifications, others see only their own.',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1, description: 'Page number' },
          limit: { type: 'integer', minimum: 1, description: 'Records per page' },
          isRead: { type: 'string', enum: ['true', 'false'], description: 'Filter by read status' },
          startDate: { type: 'string', description: 'Start date for custom range (ISO 8601)' },
          endDate: { type: 'string', description: 'End date for custom range (ISO 8601)' },
          period: { type: 'string', enum: ['today', 'week', 'month', 'quarter', 'year', 'all'], description: 'Predefined date period filter' },
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
                  id: { type: 'string' },
                  type: { type: 'string' },
                  title: { type: 'string' },
                  message: { type: 'string' },
                  isRead: { type: 'boolean' },
                  readAt: { type: 'string', format: 'date-time' },
                  createdAt: { type: 'string', format: 'date-time' },
                },
              },
            },
            total: { type: 'integer' },
            unreadCount: { type: 'integer' },
            page: { type: 'integer' },
            limit: { type: 'integer' },
            totalPages: { type: 'integer' },
          },
        },
      },
    },
  }, async (req) => {
    return notificationService.list(req.query, req.user.role, req.user.username);
  });

  // GET /api/notifications/unread-count — quick count for badge
  app.get('/unread-count', {
    schema: {
      tags: ['Notifications'],
      summary: 'Get unread notification count',
      description: 'Return the count of unread notifications for the current user. Used for notification badge display.',
      response: {
        200: {
          type: 'object',
          properties: {
            count: { type: 'integer' },
          },
        },
      },
    },
  }, async (req) => {
    return notificationService.getUnreadCount(req.user.role, req.user.username);
  });

  // PUT /api/notifications/mark-all-read — mark all as read
  app.put('/mark-all-read', {
    schema: {
      tags: ['Notifications'],
      summary: 'Mark all notifications as read',
      description: 'Mark all visible notifications as read for the current user based on their role.',
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
          },
        },
      },
    },
  }, async (req) => {
    return notificationService.markAllRead(req.user.role, req.user.username);
  });

  // PUT /api/notifications/bulk-read — mark multiple as read
  app.put('/bulk-read', {
    schema: {
      tags: ['Notifications'],
      summary: 'Mark selected notifications as read',
      description: 'Mark multiple notifications as read by their IDs.',
      body: {
        type: 'object',
        required: ['ids'],
        properties: {
          ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            count: { type: 'integer' },
          },
        },
      },
    },
  }, async (req) => {
    const { ids } = req.body as { ids: string[] };
    return notificationService.bulkRead(ids, req.user.role, req.user.username);
  });

  // PUT /api/notifications/bulk-unread — mark multiple as unread
  app.put('/bulk-unread', {
    schema: {
      tags: ['Notifications'],
      summary: 'Mark selected notifications as unread',
      description: 'Mark multiple notifications as unread by their IDs.',
      body: {
        type: 'object',
        required: ['ids'],
        properties: {
          ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            count: { type: 'integer' },
          },
        },
      },
    },
  }, async (req) => {
    const { ids } = req.body as { ids: string[] };
    return notificationService.bulkUnread(ids, req.user.role, req.user.username);
  });

  // POST /api/notifications/bulk-delete — delete multiple (requires NOTIFICATION_DELETE)
  app.post('/bulk-delete', {
    preHandler: [app.requirePermission('NOTIFICATION_DELETE')], // 2026-07-01: delete is a grantable perm again (SUPER_ADMIN still bypasses)
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    schema: {
      tags: ['Notifications'],
      summary: 'Delete selected notifications',
      description: 'Permanently delete multiple notifications by their IDs. Requires SUPER_ADMIN.',
      body: {
        type: 'object',
        required: ['ids'],
        properties: {
          ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            count: { type: 'integer' },
          },
        },
      },
    },
  }, async (req, reply) => {
    // 2026-05-26 audit fix (PA-REAUTH-4): bulk delete is destructive +
    // irreversible. Reauth roles are configurable via the action-reauth
    // admin UI; default is SUPER_ADMIN only per BULK_DELETE_NOTIFICATIONS.
    const { ok } = await enforceReauth('BULK_DELETE_NOTIFICATIONS', req, reply);
    if (!ok) return;
    const { ids } = req.body as { ids: string[] };
    return notificationService.bulkDelete(ids, buildContext(req));
  });

  // PUT /api/notifications/:id/read — mark as read
  app.put('/:id/read', {
    schema: {
      tags: ['Notifications'],
      summary: 'Mark notification as read',
      description: 'Mark a single notification as read by its ID.',
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'Notification ID' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req) => {
    const { id } = req.params as { id: string };
    return notificationService.markRead(id, req.user.role, req.user.username);
  });

  // PUT /api/notifications/:id/unread — mark as unread
  app.put('/:id/unread', {
    schema: {
      tags: ['Notifications'],
      summary: 'Mark notification as unread',
      description: 'Mark a single notification as unread by its ID.',
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'Notification ID' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req) => {
    const { id } = req.params as { id: string };
    return notificationService.markUnread(id, req.user.role, req.user.username);
  });

  // DELETE /api/notifications/:id — delete notification
  app.delete('/:id', {
    // 2026-07-01: single + bulk delete require NOTIFICATION_DELETE (grantable via the
    // "Delete Notifications" toggle; SUPER_ADMIN bypasses). Reauth (DELETE_NOTIFICATION)
    // still applies. Read/mark-read stay ungated (per-user scoped).
    preHandler: [app.requirePermission('NOTIFICATION_DELETE')],
    schema: {
      tags: ['Notifications'],
      summary: 'Delete a notification',
      description: 'Permanently delete a notification by its ID.',
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'Notification ID' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    // 2026-05-26 audit fix (PA-REAUTH-4): single delete uses the same
    // DELETE_NOTIFICATION reauth key — same per-row blast radius as bulk.
    const { ok } = await enforceReauth('DELETE_NOTIFICATION', req, reply);
    if (!ok) return;
    const { id } = req.params as { id: string };
    return notificationService.delete(id, buildContext(req));
  });
}
