import { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
// getTsdbPool removed with data-ingestion removal.

/**
 * Dashboard routes — widget-based dashboards with assignment
 * Prefix: /api/dashboards
 *
 * STATUS: Future-development scope (parked 2026-04-30).
 * Backend is feature-complete (CRUD, widgets, layout, role/user/org assignment,
 * widget data fetcher) and tied to the Dashboard / DashboardWidget /
 * DashboardAssignment Prisma models. No frontend page consumes it today —
 * the live "Dashboard" route at `/` uses standalone endpoints
 * (/api/users/stats, /api/audit?limit=1, /api/filters/dashboard-stats, etc).
 *
 * To activate: build the `/dashboards` page (drag-drop widget canvas + the
 * widget-types catalog) and replace the hardcoded landing page. Tracked in
 * future/feature-dashboards.md.
 */
export default async function dashboardRoutes(app: FastifyInstance) {


  // Helper: check if user can see a dashboard
  async function canAccessDashboard(req: FastifyRequest, dashboardId: string): Promise<boolean> {
    const role = req.user.role;
    if (role === 'SUPER_ADMIN') return true;

    const dashboard = await prisma.dashboard.findFirst({ where: { id: dashboardId } });
    if (!dashboard) return false;

    if (role === 'ADMIN') return true;

    // Check assignment
    const assignment = await prisma.dashboardAssignment.findFirst({
      where: {
        dashboardId,
        OR: [
          { assigneeType: 'USER', userId: req.user.sub },
          { assigneeType: 'ROLE', roleValue: role },
        ],
      },
    });
    return !!assignment;
  }

  // ─── LIST DASHBOARDS (user's visible dashboards) ───────
  app.get('/', {
    preHandler: [app.requirePermission('DASHBOARD_VIEW')],
    schema: {
      tags: ['Dashboards'],
      summary: 'List dashboards visible to current user',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', default: 1 },
          limit: { type: 'integer', default: 20 },
        },
      },
    },
  }, async (req) => {
    const { page = 1, limit = 20 } = req.query as any;
    const role = req.user.role;
    let where: any = { isActive: true };

    if (role === 'SUPER_ADMIN' || role === 'ADMIN') {
      // No filter — see all dashboards
    } else {
      // Check for explicit dashboard assignments
      const assignments = await prisma.dashboardAssignment.findMany({
        where: {
          OR: [
            { assigneeType: 'USER', userId: req.user.sub },
            { assigneeType: 'ROLE', roleValue: role },
          ],
        },
        select: { dashboardId: true },
      });
      const ids = assignments.map(a => a.dashboardId);
      if (ids.length > 0) {
        // User has explicit assignments — show only those
        where = { id: { in: ids }, isActive: true };
      }
      // If no assignments — user passed permission check, show all active dashboards
    }

    const [data, total] = await Promise.all([
      prisma.dashboard.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
        include: { _count: { select: { widgets: true, assignments: true } } },
      }),
      prisma.dashboard.count({ where }),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  });

  // ─── GET DASHBOARD WITH WIDGETS ────────────────────────
  app.get('/:id', {
    preHandler: [app.requirePermission('DASHBOARD_VIEW')],
    schema: {
      tags: ['Dashboards'],
      summary: 'Get dashboard with all widgets',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await canAccessDashboard(req, id))) {
      return reply.code(404).send({ error: 'Dashboard not found' });
    }

    const dashboard = await prisma.dashboard.findUnique({
      where: { id },
      include: {
        widgets: { orderBy: { createdAt: 'asc' } },
        assignments: true,
      },
    });

    return dashboard;
  });

  // ─── CREATE DASHBOARD ──────────────────────────────────
  app.post('/', {
    schema: {
      tags: ['Dashboards'],
      summary: 'Create a new dashboard',
      body: {
        type: 'object',
        required: ['title'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 200 },
          description: { type: 'string', maxLength: 500 },
          layout: { type: 'object' },
          isDefault: { type: 'boolean' },
        },
      },
    },
    preHandler: [app.requirePermission('DASHBOARD_CREATE')],
  }, async (req, reply) => {
    const body = req.body as any;
    // If setting as default, unset other defaults
    if (body.isDefault) {
      await prisma.dashboard.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
    }

    const dashboard = await prisma.dashboard.create({
      data: {
        title: body.title,
        description: body.description,
        layout: body.layout || {},
        isDefault: body.isDefault || false,
        createdBy: req.user.sub,
      },
    });

    await auditLog({
      userId: req.user.username, userRole: req.user.role,
      action: 'DASHBOARD_CREATED', targetType: 'dashboard', targetId: dashboard.id,
      afterValue: { title: dashboard.title },
      ipAddress: req.ip, userAgent: req.headers['user-agent'],
      sessionId: req.user.sessionId,
    });

    return reply.code(201).send(dashboard);
  });

  // ─── UPDATE DASHBOARD ──────────────────────────────────
  app.put('/:id', {
    schema: {
      tags: ['Dashboards'],
      summary: 'Update dashboard',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
      body: {
        type: 'object',
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 200 },
          description: { type: 'string', maxLength: 500 },
          layout: { type: 'object' },
          isDefault: { type: 'boolean' },
          isActive: { type: 'boolean' },
        },
        // The handler does `data: body`, so every key the client sends reaches
        // Prisma. AJV's removeAdditional only strips unknown keys when the schema
        // declares this — without it a DASHBOARD_MANAGE holder could PUT
        // createdBy/createdAt and rewrite the row's provenance.
        additionalProperties: false,
      },
    },
    preHandler: [app.requirePermission('DASHBOARD_MANAGE')],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as any;
    const existing = await prisma.dashboard.findFirst({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'Dashboard not found' });

    if (body.isDefault) {
      await prisma.dashboard.updateMany({ where: { isDefault: true, id: { not: id } }, data: { isDefault: false } });
    }

    const dashboard = await prisma.dashboard.update({ where: { id }, data: body });
    return dashboard;
  });

  // ─── DELETE DASHBOARD ──────────────────────────────────
  app.delete('/:id', {
    schema: {
      tags: ['Dashboards'],
      summary: 'Delete dashboard',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
    },
    preHandler: [app.requirePermission('DASHBOARD_MANAGE')],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.dashboard.findFirst({ where: { id } });
    if (!existing) return reply.code(404).send({ error: 'Dashboard not found' });

    await prisma.dashboard.update({ where: { id }, data: { isActive: false } });
    return { success: true };
  });

  // ═══════════════════════════════════════════════════════
  // WIDGETS
  // ═══════════════════════════════════════════════════════

  // ─── ADD WIDGET ────────────────────────────────────────
  app.post('/:id/widgets', {
    schema: {
      tags: ['Dashboards'],
      summary: 'Add widget to dashboard',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
      body: {
        type: 'object',
        required: ['widgetType', 'title'],
        properties: {
          widgetType: { type: 'string', enum: ['timeseries_chart', 'gauge', 'value_card', 'entity_table', 'status_indicator', 'scada_symbol', 'map', 'html_widget', 'image'] },
          title: { type: 'string', maxLength: 200 },
          config: { type: 'object' },
          position: { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' }, w: { type: 'integer' }, h: { type: 'integer' } } },
          dataSource: { type: 'object' },
          refreshInterval: { type: 'integer', minimum: 0 },
        },
      },
    },
    preHandler: [app.requirePermission('DASHBOARD_MANAGE')],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as any;
    const dashboard = await prisma.dashboard.findFirst({ where: { id } });
    if (!dashboard) return reply.code(404).send({ error: 'Dashboard not found' });

    const widget = await prisma.dashboardWidget.create({
      data: {
        dashboardId: id,
        widgetType: body.widgetType,
        title: body.title,
        config: body.config || {},
        position: body.position || { x: 0, y: 0, w: 4, h: 3 },
        dataSource: body.dataSource || {},
        refreshInterval: body.refreshInterval ?? 30,
      },
    });

    return reply.code(201).send(widget);
  });

  // ─── UPDATE WIDGET ─────────────────────────────────────
  app.put('/:id/widgets/:widgetId', {
    schema: {
      tags: ['Dashboards'],
      summary: 'Update widget',
      params: {
        type: 'object',
        properties: { id: { type: 'string', format: 'uuid' }, widgetId: { type: 'string', format: 'uuid' } },
        required: ['id', 'widgetId'],
      },
      body: {
        type: 'object',
        properties: {
          title: { type: 'string', maxLength: 200 },
          config: { type: 'object' },
          position: { type: 'object' },
          dataSource: { type: 'object' },
          refreshInterval: { type: 'integer', minimum: 0 },
        },
        // Same as the dashboard PUT above. Worse here: dashboardId is writable, so
        // an unfiltered `data: body` let a caller re-parent a widget onto another
        // dashboard — straight past the ownership check this handler runs on the
        // PARENT id. widgetType is writable too, bypassing the create-time enum.
        additionalProperties: false,
      },
    },
    preHandler: [app.requirePermission('DASHBOARD_MANAGE')],
  }, async (req, reply) => {
    const { id, widgetId } = req.params as { id: string; widgetId: string };
    const body = req.body as any;

    const widget = await prisma.dashboardWidget.findFirst({ where: { id: widgetId, dashboardId: id } });
    if (!widget) return reply.code(404).send({ error: 'Widget not found' });

    const updated = await prisma.dashboardWidget.update({ where: { id: widgetId }, data: body });
    return updated;
  });

  // ─── DELETE WIDGET ─────────────────────────────────────
  app.delete('/:id/widgets/:widgetId', {
    schema: {
      tags: ['Dashboards'],
      summary: 'Remove widget',
      params: {
        type: 'object',
        properties: { id: { type: 'string', format: 'uuid' }, widgetId: { type: 'string', format: 'uuid' } },
        required: ['id', 'widgetId'],
      },
    },
    preHandler: [app.requirePermission('DASHBOARD_MANAGE')],
  }, async (req, reply) => {
    const { widgetId } = req.params as { widgetId: string };
    await prisma.dashboardWidget.delete({ where: { id: widgetId } });
    return { success: true };
  });

  // ─── BATCH UPDATE WIDGET POSITIONS (drag-and-drop) ─────
  app.put('/:id/layout', {
    schema: {
      tags: ['Dashboards'],
      summary: 'Batch update widget positions after drag-and-drop',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
      body: {
        type: 'object',
        required: ['positions'],
        properties: {
          positions: {
            type: 'array',
            items: {
              type: 'object',
              required: ['widgetId', 'x', 'y', 'w', 'h'],
              properties: {
                widgetId: { type: 'string', format: 'uuid' },
                x: { type: 'integer' }, y: { type: 'integer' },
                w: { type: 'integer' }, h: { type: 'integer' },
              },
            },
          },
        },
      },
    },
    preHandler: [app.requirePermission('DASHBOARD_MANAGE')],
  }, async (req) => {
    const { positions } = req.body as { positions: Array<{ widgetId: string; x: number; y: number; w: number; h: number }> };
    await Promise.all(positions.map(p =>
      prisma.dashboardWidget.update({
        where: { id: p.widgetId },
        data: { position: { x: p.x, y: p.y, w: p.w, h: p.h } },
      })
    ));
    return { success: true, updated: positions.length };
  });

  // ═══════════════════════════════════════════════════════
  // ASSIGNMENTS
  // ═══════════════════════════════════════════════════════

  // ─── ASSIGN DASHBOARD ──────────────────────────────────
  app.post('/:id/assign', {
    schema: {
      tags: ['Dashboards'],
      summary: 'Assign dashboard to user/org/role',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
      body: {
        type: 'object',
        required: ['assigneeType'],
        properties: {
          assigneeType: { type: 'string', enum: ['USER', 'ROLE'] },
          userId: { type: 'string', format: 'uuid' },
          roleValue: { type: 'string' },
        },
      },
    },
    preHandler: [app.requirePermission('DASHBOARD_ASSIGN')],
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as any;

    const assignment = await prisma.dashboardAssignment.create({
      data: {
        dashboardId: id,
        assigneeType: body.assigneeType,
        userId: body.userId || null,
        roleValue: body.roleValue || null,
      },
    });

    return reply.code(201).send(assignment);
  });

  // ─── REMOVE ASSIGNMENT ─────────────────────────────────
  app.delete('/:dashboardId/assign/:assignmentId', {
    schema: {
      tags: ['Dashboards'],
      summary: 'Remove dashboard assignment',
      params: {
        type: 'object',
        properties: { dashboardId: { type: 'string' }, assignmentId: { type: 'string', format: 'uuid' } },
        required: ['dashboardId', 'assignmentId'],
      },
    },
    preHandler: [app.requirePermission('DASHBOARD_ASSIGN')],
  }, async (req) => {
    const { assignmentId } = req.params as { assignmentId: string };
    await prisma.dashboardAssignment.delete({ where: { id: assignmentId } });
    return { success: true };
  });

  // ═══════════════════════════════════════════════════════
  // WIDGET DATA
  // ═══════════════════════════════════════════════════════

  // ─── GET WIDGET DATA ───────────────────────────────────
  app.get('/:id/data/:widgetId', {
    preHandler: [app.requirePermission('DASHBOARD_VIEW')],
    schema: {
      tags: ['Dashboards'],
      summary: 'Fetch data for a specific widget',
      params: {
        type: 'object',
        properties: { id: { type: 'string', format: 'uuid' }, widgetId: { type: 'string', format: 'uuid' } },
        required: ['id', 'widgetId'],
      },
    },
  }, async (req, reply) => {
    const { id, widgetId } = req.params as { id: string; widgetId: string };

    if (!(await canAccessDashboard(req, id))) {
      return reply.code(404).send({ error: 'Dashboard not found' });
    }

    const widget = await prisma.dashboardWidget.findFirst({ where: { id: widgetId, dashboardId: id } });
    if (!widget) return reply.code(404).send({ error: 'Widget not found' });

    const dataSource = widget.dataSource as any;
    const entityIds = dataSource?.entityIds || [];
    const telemetryKeys = dataSource?.telemetryKeys || [];

    if (entityIds.length === 0) {
      return { widgetId, data: [], message: 'No entity IDs configured' };
    }

    switch (widget.widgetType) {
      case 'value_card':
      case 'gauge':
      case 'status_indicator':
      case 'timeseries_chart': {
        // Telemetry source removed with data-ingestion removal (Phase 7); the
        // latest_telemetry cache table was dropped 2026-07-01. These widgets now
        // return empty.
        return { widgetId, widgetType: widget.widgetType, data: [] };
      }

      case 'entity_table': {
        const entities = await prisma.assetInstance.findMany({
          where: { id: { in: entityIds }, isActive: true },
          select: { id: true, name: true, status: true, attributes: true, templateId: true },
        });
        return { widgetId, widgetType: 'entity_table', data: entities };
      }

      default:
        return { widgetId, widgetType: widget.widgetType, data: [], message: 'Widget type data fetch not implemented' };
    }
  });

  // ─── WIDGET TYPES ──────────────────────────────────────
  app.get('/widget-types', {
    schema: {
      tags: ['Dashboards'],
      summary: 'List available widget types',
    },
  }, async () => {
    return [
      { type: 'timeseries_chart', label: 'Time Series Chart', icon: 'line-chart', description: 'Line/bar/area chart for telemetry history', category: 'Charts' },
      { type: 'gauge', label: 'Gauge', icon: 'gauge', description: 'Radial gauge for single telemetry value', category: 'Charts' },
      { type: 'value_card', label: 'Value Card', icon: 'hash', description: 'Display latest telemetry value', category: 'Cards' },
      { type: 'entity_table', label: 'Entity Table', icon: 'table', description: 'Entity list with attributes', category: 'Tables' },
      { type: 'status_indicator', label: 'Status Indicator', icon: 'circle', description: 'Online/offline LED indicator', category: 'Indicators' },
      { type: 'scada_symbol', label: 'SCADA Symbol', icon: 'cpu', description: 'SVG with telemetry data binding', category: 'SCADA' },
      { type: 'map', label: 'Map', icon: 'map-pin', description: 'Device location map', category: 'Maps' },
      { type: 'html_widget', label: 'Custom HTML', icon: 'code', description: 'Custom HTML/JS widget', category: 'Advanced' },
      { type: 'image', label: 'Image', icon: 'image', description: 'Static or dynamic image', category: 'Media' },
    ];
  });
}
