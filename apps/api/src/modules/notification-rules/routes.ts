/**
 * Notification Rules Routes — CRUD for event-based notification rules
 * with role/group/user recipient targeting.
 */
import { type FastifyInstance } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { buildContext } from '../../lib/build-context.js';
import { auditLog } from '../../lib/audit.js';
import { NotFoundError } from '../../lib/errors.js';
import { dispatchNotification } from '../notification-delivery/notification-dispatcher.js';

const EVENT_TYPE_META: Record<string, { label: string; module: string; variables: string[] }> = {
  DEVICE_ONLINE:        { label: 'Device Online',         module: 'devices',    variables: ['deviceName', 'deviceId', 'timestamp'] },
  DEVICE_OFFLINE:       { label: 'Device Offline',        module: 'devices',    variables: ['deviceName', 'deviceId', 'lastSeen', 'timestamp'] },
  DEVICE_INACTIVITY:    { label: 'Device Inactivity',     module: 'devices',    variables: ['deviceName', 'deviceId', 'inactiveSince', 'timestamp'] },
  USER_LOGIN:           { label: 'User Login',            module: 'users',      variables: ['username', 'fullName', 'ipAddress', 'timestamp'] },
  USER_CREATED:         { label: 'User Created',          module: 'users',      variables: ['username', 'fullName', 'role', 'createdBy', 'timestamp'] },
  USER_LOCKED:          { label: 'User Locked',           module: 'users',      variables: ['username', 'fullName', 'reason', 'timestamp'] },
  CHECKLIST_SUBMITTED:  { label: 'Checklist Submitted',   module: 'checklists', variables: ['checklistName', 'submittedBy', 'timestamp'] },
  CHECKLIST_APPROVED:   { label: 'Checklist Approved',    module: 'checklists', variables: ['checklistName', 'approvedBy', 'timestamp'] },
  CHECKLIST_REJECTED:   { label: 'Checklist Rejected',    module: 'checklists', variables: ['checklistName', 'rejectedBy', 'reason', 'timestamp'] },
  SYSTEM_ERROR:         { label: 'System Error',          module: 'system',     variables: ['errorType', 'errorMessage', 'timestamp'] },
};

export default async function notificationRulesRoutes(app: FastifyInstance) {

  // GET /api/notification-rules/event-types — available event types
  app.get('/event-types', {
    preHandler: [app.requirePermission('CONFIG_READ')],
    schema: { tags: ['Notification Rules'], summary: 'List available event types' },
  }, async () => {
    return Object.entries(EVENT_TYPE_META).map(([key, meta]) => ({
      value: key,
      ...meta,
    }));
  });

  // GET /api/notification-rules — list all rules
  app.get('/', {
    preHandler: [app.requirePermission('CONFIG_READ')],
    schema: { tags: ['Notification Rules'], summary: 'List notification rules' },
  }, async () => {
    const rules = await prisma.notificationRule.findMany({
      include: { recipients: true },
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
    });

    // Enrich recipient info
    const groupIds = rules.flatMap(r => r.recipients.filter(rc => rc.groupId).map(rc => rc.groupId!));
    const userIds = rules.flatMap(r => r.recipients.filter(rc => rc.userId).map(rc => rc.userId!));

    const [groups, users] = await Promise.all([
      groupIds.length ? prisma.userGroup.findMany({ where: { id: { in: groupIds } }, select: { id: true, name: true } }) : [],
      userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true, fullName: true } }) : [],
    ]);

    const groupMap = new Map(groups.map(g => [g.id, g.name]));
    const userMap = new Map(users.map(u => [u.id, u]));

    const data = rules.map(rule => {
      const types = rule.eventTypes?.length ? rule.eventTypes : [rule.eventType];
      const typesMeta = types.map(et => EVENT_TYPE_META[et] ? { value: et, ...EVENT_TYPE_META[et] } : null).filter(Boolean);
      return {
        ...rule,
        eventTypes: types,
        eventTypeMeta: EVENT_TYPE_META[rule.eventType] ?? null,
        eventTypesMeta: typesMeta,
        recipients: rule.recipients.map(r => ({
        ...r,
        displayName: r.recipientType === 'ROLE' ? r.roleValue
          : r.recipientType === 'GROUP' ? groupMap.get(r.groupId!) ?? r.groupId
          : r.recipientType === 'USER' ? (userMap.get(r.userId!)?.fullName ?? r.userId)
          : 'Unknown',
      })),
      };
    });

    return { data, total: data.length };
  });

  // GET /api/notification-rules/:id — single rule
  app.get('/:id', {
    preHandler: [app.requirePermission('CONFIG_READ')],
    schema: {
      tags: ['Notification Rules'],
      summary: 'Get notification rule',
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (req) => {
    const { id } = req.params as { id: string };
    return prisma.notificationRule.findUniqueOrThrow({
      where: { id },
      include: { recipients: true },
    });
  });

  // POST /api/notification-rules — create rule
  app.post('/', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: {
      tags: ['Notification Rules'],
      summary: 'Create notification rule',
      body: {
        type: 'object',
        required: ['name', 'eventTypes'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200 },
          description: { type: 'string', maxLength: 500 },
          eventType: { type: 'string' },
          eventTypes: { type: 'array', items: { type: 'string' }, minItems: 1 },
          conditions: { type: 'object' },
          emailEnabled: { type: 'boolean' },
          smsEnabled: { type: 'boolean' },
          inAppEnabled: { type: 'boolean' },
          emailTemplateId: { type: 'string' },
          smsTemplateId: { type: 'string' },
          cooldownMinutes: { type: 'integer', minimum: 0 },
          priority: { type: 'integer' },
          isActive: { type: 'boolean' },
          recipients: {
            type: 'array',
            items: {
              type: 'object',
              required: ['recipientType'],
              properties: {
                recipientType: { type: 'string', enum: ['ROLE', 'GROUP', 'USER'] },
                roleValue: { type: 'string' },
                groupId: { type: 'string' },
                userId: { type: 'string' },
              },
            },
          },
        },
      },
    },
  }, async (req) => {
    const body = req.body as any;
    const ctx = buildContext(req);
    const { recipients, ...ruleData } = body;

    // Normalize: accept eventTypes array or single eventType
    if (ruleData.eventTypes?.length) {
      ruleData.eventType = ruleData.eventTypes[0];
    } else if (ruleData.eventType && !ruleData.eventTypes?.length) {
      ruleData.eventTypes = [ruleData.eventType];
    }

    const rule = await prisma.notificationRule.create({
      data: {
        ...ruleData,
        conditions: ruleData.conditions ?? {},
        createdBy: ctx.userId,
        recipients: recipients?.length ? {
          create: recipients.map((r: any) => ({
            recipientType: r.recipientType,
            roleValue: r.recipientType === 'ROLE' ? r.roleValue : null,
            groupId: r.recipientType === 'GROUP' ? r.groupId : null,
            userId: r.recipientType === 'USER' ? r.userId : null,
          })),
        } : undefined,
      },
      include: { recipients: true },
    });

    await auditLog({ action: 'NOTIFICATION_RULE_CREATED', targetType: 'NotificationRule', targetId: rule.id, afterValue: { name: rule.name, eventType: rule.eventType }, userId: ctx.userId, userRole: ctx.userRole });
    return rule;
  });

  // PUT /api/notification-rules/:id — update rule
  app.put('/:id', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: {
      tags: ['Notification Rules'],
      summary: 'Update notification rule',
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200 },
          description: { type: 'string', maxLength: 500 },
          eventType: { type: 'string' },
          eventTypes: { type: 'array', items: { type: 'string' }, minItems: 1 },
          conditions: { type: 'object' },
          emailEnabled: { type: 'boolean' },
          smsEnabled: { type: 'boolean' },
          inAppEnabled: { type: 'boolean' },
          emailTemplateId: { type: 'string' },
          smsTemplateId: { type: 'string' },
          cooldownMinutes: { type: 'integer', minimum: 0 },
          priority: { type: 'integer' },
          isActive: { type: 'boolean' },
          recipients: {
            type: 'array',
            items: {
              type: 'object',
              required: ['recipientType'],
              properties: {
                recipientType: { type: 'string', enum: ['ROLE', 'GROUP', 'USER'] },
                roleValue: { type: 'string' },
                groupId: { type: 'string' },
                userId: { type: 'string' },
              },
            },
          },
        },
      },
    },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as any;
    const { recipients, ...ruleData } = body;

    // Normalize: accept eventTypes array or single eventType
    if (ruleData.eventTypes?.length) {
      ruleData.eventType = ruleData.eventTypes[0];
    } else if (ruleData.eventType && !ruleData.eventTypes?.length) {
      ruleData.eventTypes = [ruleData.eventType];
    }

    // Strip computed/non-DB fields
    const { id: _id, eventTypeMeta, eventTypesMeta, createdAt, updatedAt, createdBy, ...cleanData } = ruleData;

    // Convert empty strings to null for optional UUID fields
    if (cleanData.emailTemplateId === '') cleanData.emailTemplateId = null;
    if (cleanData.smsTemplateId === '') cleanData.smsTemplateId = null;
    if (cleanData.description === '') cleanData.description = null;

    // Update rule + replace recipients in transaction
    const rule = await prisma.$transaction(async (tx) => {
      const updated = await tx.notificationRule.update({
        where: { id },
        data: cleanData,
      });

      if (recipients !== undefined) {
        await tx.notificationRuleRecipient.deleteMany({ where: { ruleId: id } });
        if (recipients.length) {
          await tx.notificationRuleRecipient.createMany({
            data: recipients.map((r: any) => ({
              ruleId: id,
              recipientType: r.recipientType,
              roleValue: r.recipientType === 'ROLE' ? r.roleValue : null,
              groupId: r.recipientType === 'GROUP' ? r.groupId : null,
              userId: r.recipientType === 'USER' ? r.userId : null,
            })),
          });
        }
      }

      return tx.notificationRule.findUniqueOrThrow({
        where: { id },
        include: { recipients: true },
      });
    });

    const ctx = buildContext(req);
    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'NOTIFICATION_RULE_UPDATED', targetType: 'notification_rule', targetId: id,
      afterValue: { name: rule.name, eventType: rule.eventType },
      ipAddress: req.ip, sessionId: req.user.sessionId,
    });

    return rule;
  });

  // DELETE /api/notification-rules/:id
  app.delete('/:id', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: {
      tags: ['Notification Rules'],
      summary: 'Delete notification rule',
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.notificationRule.findUnique({ where: { id } });
    await prisma.notificationRule.delete({ where: { id } });

    const ctx = buildContext(req);
    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'NOTIFICATION_RULE_DELETED', targetType: 'notification_rule', targetId: id,
      beforeValue: existing ? { name: existing.name, eventType: existing.eventType } : undefined,
      ipAddress: req.ip, sessionId: req.user.sessionId,
    });

    return { success: true };
  });

  // PUT /api/notification-rules/:id/toggle — enable/disable
  app.put('/:id/toggle', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: {
      tags: ['Notification Rules'],
      summary: 'Toggle notification rule active status',
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (req) => {
    const { id } = req.params as { id: string };
    // Single statement: a find-then-update read-modify-write lets two concurrent
    // toggles read the same isActive and net to one flip.
    // updated_at is set explicitly: Prisma's @updatedAt is client-side and does
    // not apply to raw SQL.
    const updated = await prisma.$queryRaw<Array<{ id: string; name: string; is_active: boolean }>>`
      UPDATE notification_rules SET is_active = NOT is_active, updated_at = now()
      WHERE id = ${id}::uuid
      RETURNING id, name, is_active
    `;
    if (updated.length === 0) throw new NotFoundError('Notification rule not found');
    const row = updated[0];

    // Reuses NOTIFICATION_RULE_UPDATED: disabling a rule silences its alerts with
    // the same operational effect as deleting it, so it is a record change.
    const ctx = buildContext(req);
    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'NOTIFICATION_RULE_UPDATED', targetType: 'notification_rule', targetId: id,
      beforeValue: { name: row.name, isActive: !row.is_active },
      afterValue: { name: row.name, isActive: row.is_active },
      signatureMeaning: `Notification rule "${row.name}" ${row.is_active ? 'enabled' : 'disabled'}`,
      ipAddress: req.ip, sessionId: req.user.sessionId,
    });

    return prisma.notificationRule.findUniqueOrThrow({ where: { id } });
  });

  // POST /api/notification-rules/:id/test — test fire a rule
  app.post('/:id/test', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: {
      tags: ['Notification Rules'],
      summary: 'Test-fire a notification rule',
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const rule = await prisma.notificationRule.findUniqueOrThrow({
      where: { id },
      include: { recipients: true },
    });

    const meta = EVENT_TYPE_META[rule.eventType];
    const testVars: Record<string, string> = {};
    for (const v of (meta?.variables ?? [])) {
      testVars[v] = `[Test ${v}]`;
    }
    testVars.timestamp = new Date().toISOString();

    try {
      await dispatchNotification({
        eventType: rule.eventType as any,
        context: {},
        variables: testVars,
        forceRuleId: id,
      });
      return { success: true, message: `Test notification dispatched for rule "${rule.name}"` };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });
}
