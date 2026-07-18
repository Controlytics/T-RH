/**
 * Notification Dispatcher — Central service that matches events to notification rules,
 * resolves recipients, and dispatches via the delivery service.
 */
import { prisma } from '../../lib/prisma.js';
import { sendNotification } from './delivery.service.js';
import { resolveTemplate } from './template-engine.js';
import { formatConfiguredDateTime } from '../../lib/format-datetime.js';

interface DispatchEvent {
  eventType: string;
  context: Record<string, unknown>;
  variables: Record<string, string>;
  forceRuleId?: string; // For testing a specific rule
}

// Cooldown tracking (in-memory, per rule)
// TODO: Move cooldown tracking to Redis for cross-instance consistency
const cooldownMap = new Map<string, number>();

/**
 * Main dispatcher: find matching rules, resolve recipients, send notifications.
 */
export async function dispatchNotification(event: DispatchEvent): Promise<void> {
  // [Dispatcher] event received
  const { eventType, context, variables, forceRuleId } = event;

  // Normalize the `timestamp` variable (callers pass UTC ISO) to the configured
  // timezone/format — IST by default — so every rendered email/SMS/in-app shows
  // local time, not raw UTC. Leaves non-parseable pre-formatted values untouched.
  if (variables.timestamp) {
    const formatted = await formatConfiguredDateTime(variables.timestamp);
    if (formatted) variables.timestamp = formatted;
  }

  // Build eventLabel, summary, and dynamic details HTML based on event type
  const EVENT_LABELS: Record<string, string> = {
    DEVICE_ONLINE: 'Device Online', DEVICE_OFFLINE: 'Device Offline', DEVICE_INACTIVITY: 'Device Inactive',
    USER_LOGIN: 'User Login', USER_CREATED: 'User Created', USER_LOCKED: 'User Locked',
    CHECKLIST_SUBMITTED: 'Checklist Submitted',
    CHECKLIST_APPROVED: 'Checklist Approved', CHECKLIST_REJECTED: 'Checklist Rejected', SYSTEM_ERROR: 'System Error',
  };
  // Which fields to show per event type (label -> variable key)
  const EVENT_FIELDS: Record<string, [string, string][]> = {
    DEVICE_ONLINE: [['Device','deviceName'],['UNS Path','unsPath'],['Protocol','protocol'],['Source IP','sourceIp'],['Time','timestamp']],
    DEVICE_OFFLINE: [['Device','deviceName'],['UNS Path','unsPath'],['Time','timestamp']],
    DEVICE_INACTIVITY: [['Device','deviceName'],['UNS Path','unsPath'],['Inactive Since','inactiveSince'],['Timeout (sec)','timeoutSeconds'],['Time','timestamp']],
    USER_LOGIN: [['Username','username'],['Full Name','fullName'],['Role','role'],['IP Address','ipAddress'],['Time','timestamp']],
    USER_CREATED: [['Username','username'],['Full Name','fullName'],['Email','email'],['Role','role'],['Created By','createdBy'],['Time','timestamp']],
    USER_LOCKED: [['Username','username'],['Full Name','fullName'],['Reason','reason'],['Failed Attempts','failedAttempts'],['IP Address','ipAddress'],['Time','timestamp']],
    CHECKLIST_SUBMITTED: [['Checklist','checklistName'],['Entity','entityName'],['Submitted By','submittedBy'],['Time','timestamp']],
    CHECKLIST_APPROVED: [['Checklist','checklistName'],['Approved By','approvedBy'],['Time','timestamp']],
    CHECKLIST_REJECTED: [['Checklist','checklistName'],['Rejected By','rejectedBy'],['Reason','reason'],['Time','timestamp']],
    SYSTEM_ERROR: [['Error Type','errorType'],['Message','errorMessage'],['URL','url'],['Time','timestamp']],
  };
  variables.eventLabel = EVENT_LABELS[eventType] ?? eventType;
  variables.summary = variables.message ?? variables.username ?? variables.deviceName ?? variables.checklistName ?? variables.errorType ?? eventType;

  // Build details HTML table with actual values for this event type
  const fields = EVENT_FIELDS[eventType] ?? [['Time','timestamp']];
  const detailRows = fields.map(([label, key]) => {
    const val = variables[key] ?? '';
    return '<tr><td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600;background:#f8fafc;width:180px">' + label + '</td><td style="padding:8px 12px;border:1px solid #e2e8f0">' + val + '</td></tr>';
  }).join('\n');
  variables.details = '<table style="border-collapse:collapse;width:100%;font-size:14px">' + detailRows + '</table>';

  // Build plain-text details for SMS
  const smsLines = fields.map(([label, key]) => {
    const val = variables[key] ?? '';
    return label + ': ' + val;
  }).filter(line => !line.endsWith(': ')).join('\n');
  variables.smsDetails = smsLines;

  // Find matching active rules (match against eventTypes array)
  const where: any = { isActive: true, eventTypes: { has: eventType as any } };
  if (forceRuleId) {
    where.id = forceRuleId;
    delete where.isActive; // Allow testing inactive rules
    delete where.eventTypes; // Allow testing regardless of event type
  }

  // [Dispatcher] querying rules
  const rules = await prisma.notificationRule.findMany({
    where,
    include: { recipients: true },
    orderBy: { priority: "desc" },
  });
  // [Dispatcher] rules matched

  for (const rule of rules) {
    // Check cooldown
    if (!forceRuleId && rule.cooldownMinutes > 0) {
      const lastFired = cooldownMap.get(rule.id) ?? 0;
      const cooldownMs = rule.cooldownMinutes * 60 * 1000;
      if (Date.now() - lastFired < cooldownMs) continue;
    }

    // Evaluate conditions
    if (!forceRuleId && !matchConditions(rule.conditions as Record<string, unknown>, context)) {
      continue;
    }

    // Resolve recipients to user list
    const users = await resolveRecipients(rule.recipients);
    // [Dispatcher] recipients resolved
    if (users.length === 0) continue;

    // Update cooldown
    cooldownMap.set(rule.id, Date.now());

    // Load templates: use rule's configured template if set, otherwise event-specific defaults
    let emailTemplate: { subject: string; bodyTemplate: string } | null = null;
    let smsTemplate: { bodyTemplate: string } | null = null;

    if (rule.emailEnabled && rule.emailTemplateId) {
      const t = await prisma.notificationTemplate.findUnique({ where: { id: rule.emailTemplateId } });
      if (t) emailTemplate = { subject: t.subject ?? '', bodyTemplate: t.bodyTemplate };
    }
    if (rule.smsEnabled && rule.smsTemplateId) {
      const t = await prisma.notificationTemplate.findUnique({ where: { id: rule.smsTemplateId } });
      if (t) smsTemplate = { bodyTemplate: t.bodyTemplate };
    }

    // Fall back to event-specific defaults if no DB template configured
    if (rule.emailEnabled && !emailTemplate) {
      emailTemplate = getDefaultEmailTemplate(eventType);
    }
    if (rule.smsEnabled && !smsTemplate) {
      smsTemplate = getDefaultSmsTemplate(eventType);
    }

    // Batch-fetch phone and telegram configs for all recipients
    const userIds = users.map(u => u.id);
    const configKeys = userIds.flatMap(id => [`user-phone-${id}`, `user-telegram-${id}`]);
    const allConfigs = configKeys.length > 0 ? await prisma.systemConfig.findMany({
      where: { configKey: { in: configKeys } },
    }) : [];
    const configMap = new Map(allConfigs.map(c => [c.configKey, c.configValue]));

    // Dispatch to each user
    for (const user of users) {
      const userVars = { ...variables, recipientName: user.fullName, recipientEmail: user.email ?? '' };

      // Email
      if (rule.emailEnabled && emailTemplate && user.email) {
        const subject = resolveTemplate(emailTemplate.subject, userVars);
        const body = resolveTemplate(emailTemplate.bodyTemplate, userVars);
        // [Dispatcher] sending email
        sendNotification({
          channel: 'EMAIL',
          recipient: user.email,
          subject,
          message: body,
          triggeredBy: 'notification-rule',
          metadata: { ruleName: rule.name, eventType, userId: user.id, ruleId: rule.id },
        }).catch(err => console.error(`[Dispatcher] Email to ${user.email} failed:`, err.message));
      }

      // SMS
      if (rule.smsEnabled && smsTemplate) {
        const phone = (configMap.get(`user-phone-${user.id}`) as any)?.phone;
        // [Dispatcher] checking SMS for user
        if (phone) {
          const body = resolveTemplate(smsTemplate.bodyTemplate, userVars);
          // [Dispatcher] sending SMS
          sendNotification({
            channel: 'SMS',
            recipient: phone,
            message: body,
            triggeredBy: 'notification-rule',
            metadata: { ruleName: rule.name, eventType, userId: user.id, ruleId: rule.id },
          }).catch(err => console.error(`[Dispatcher] SMS to ${phone} failed:`, err.message));
        }
      }

      // In-App
      if (rule.inAppEnabled) {
        const message = resolveTemplate(
          getDefaultInAppMessage(eventType),
          userVars,
        );
        try {
          await prisma.notification.create({
            data: {
              type: eventType as any,
              title: rule.name,
              message,
              // forUserId is VarChar(50) and the visibility filter compares it
              // against the caller's username — must be the username string,
              // not the user UUID. See resolveRecipients() for the select.
              forUserId: user.username,
              metadata: { eventType, severity: mapEventToSeverity(eventType) } as any,
            },
          });
        } catch (err: any) {
          console.error(`[Dispatcher] In-app notification for ${user.username} failed:`, err.message);
        }
      }
    }
  }
}

/**
 * Resolve recipients from rules to actual user records.
 */
async function resolveRecipients(
  recipients: Array<{ recipientType: string; roleValue: string | null; groupId: string | null; userId: string | null }>
): Promise<Array<{ id: string; username: string; email: string | null; fullName: string }>> {
  // Collect all user IDs first, then do a single batch fetch
  const allUserIds = new Set<string>();
  const roles: string[] = [];
  const groupIds: string[] = [];

  for (const r of recipients) {
    if (r.recipientType === 'USER' && r.userId) {
      allUserIds.add(r.userId);
    } else if (r.recipientType === 'ROLE' && r.roleValue) {
      roles.push(r.roleValue);
    } else if (r.recipientType === 'GROUP' && r.groupId) {
      groupIds.push(r.groupId);
    }
  }

  // Fetch role-based and group-based user IDs in parallel
  const [roleUsers, groupMembers] = await Promise.all([
    roles.length > 0
      ? prisma.user.findMany({
          where: { role: { in: roles }, status: 'ENABLED' },
          select: { id: true },
        })
      : [],
    groupIds.length > 0
      ? prisma.userGroupMember.findMany({
          where: { groupId: { in: groupIds } },
          select: { userId: true },
        })
      : [],
  ]);

  for (const u of roleUsers) allUserIds.add(u.id);
  for (const m of groupMembers) allUserIds.add(m.userId);

  if (allUserIds.size === 0) return [];

  // Single batch fetch for all resolved user IDs.
  // `username` is required because in-app delivery writes
  // `Notification.forUserId` (VarChar(50)) and the per-user visibility filter
  // (notification.service.ts) matches against the caller's username.
  // Routing by `user.id` (UUID) silently drops every rule-driven in-app
  // notification.
  return prisma.user.findMany({
    where: { id: { in: Array.from(allUserIds) }, status: 'ENABLED' },
    select: { id: true, username: true, email: true, fullName: true },
  });
}

/**
 * Match event context against rule conditions.
 */
function matchConditions(conditions: Record<string, unknown>, context: Record<string, unknown>): boolean {
  if (!conditions || Object.keys(conditions).length === 0) return true;

  for (const [key, value] of Object.entries(conditions)) {
    const contextValue = context[key];
    if (Array.isArray(value)) {
      // Array means "any of these values"
      if (!value.includes(contextValue)) return false;
    } else if (value !== undefined && value !== null && value !== '') {
      if (String(contextValue) !== String(value)) return false;
    }
  }
  return true;
}

function mapEventToSeverity(eventType: string): string {
  if (eventType.includes('ERROR')) return 'WARNING';
  if (eventType.includes('OFFLINE') || eventType.includes('LOCKED')) return 'WARNING';
  return 'INFO';
}

function getDefaultEmailTemplate(eventType: string): { subject: string; bodyTemplate: string } {
  const templates: Record<string, { subject: string; body: string }> = {
    DEVICE_ONLINE: {
      subject: '[DigiLog] Device Online: ${deviceName}',
      body: `<h2>Device Back Online</h2>
<table style="border-collapse:collapse;width:100%">
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Device</td><td style="padding:6px 12px;border:1px solid #ddd">\${deviceName}</td></tr>
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">UNS Path</td><td style="padding:6px 12px;border:1px solid #ddd">\${unsPath}</td></tr>
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Protocol</td><td style="padding:6px 12px;border:1px solid #ddd">\${protocol}</td></tr>
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Source IP</td><td style="padding:6px 12px;border:1px solid #ddd">\${sourceIp}</td></tr>
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Time</td><td style="padding:6px 12px;border:1px solid #ddd">\${timestamp}</td></tr>
</table>`,
    },
    DEVICE_OFFLINE: {
      subject: '[DigiLog] Device Offline: ${deviceName}',
      body: `<h2>Device Went Offline</h2>
<table style="border-collapse:collapse;width:100%">
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Device</td><td style="padding:6px 12px;border:1px solid #ddd">\${deviceName}</td></tr>
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">UNS Path</td><td style="padding:6px 12px;border:1px solid #ddd">\${unsPath}</td></tr>
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Time</td><td style="padding:6px 12px;border:1px solid #ddd">\${timestamp}</td></tr>
</table>`,
    },
    DEVICE_INACTIVITY: {
      subject: '[DigiLog] Device Inactive: ${deviceName}',
      body: `<h2>Device Inactive</h2>
<table style="border-collapse:collapse;width:100%">
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Device</td><td style="padding:6px 12px;border:1px solid #ddd">\${deviceName}</td></tr>
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">UNS Path</td><td style="padding:6px 12px;border:1px solid #ddd">\${unsPath}</td></tr>
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Inactive Since</td><td style="padding:6px 12px;border:1px solid #ddd">\${inactiveSince}</td></tr>
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Timeout (sec)</td><td style="padding:6px 12px;border:1px solid #ddd">\${timeoutSeconds}</td></tr>
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Time</td><td style="padding:6px 12px;border:1px solid #ddd">\${timestamp}</td></tr>
</table>`,
    },
    USER_LOGIN: {
      subject: '[DigiLog] User Login: ${username}',
      body: `<h2>User Login</h2>
<table style="border-collapse:collapse;width:100%">
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Username</td><td style="padding:6px 12px;border:1px solid #ddd">\${username}</td></tr>
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Full Name</td><td style="padding:6px 12px;border:1px solid #ddd">\${fullName}</td></tr>
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Role</td><td style="padding:6px 12px;border:1px solid #ddd">\${role}</td></tr>
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">IP Address</td><td style="padding:6px 12px;border:1px solid #ddd">\${ipAddress}</td></tr>
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Time</td><td style="padding:6px 12px;border:1px solid #ddd">\${timestamp}</td></tr>
</table>`,
    },
    USER_CREATED: {
      subject: '[DigiLog] New User Created: ${username}',
      body: `<h2>New User Created</h2>
<table style="border-collapse:collapse;width:100%">
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Username</td><td style="padding:6px 12px;border:1px solid #ddd">\${username}</td></tr>
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Full Name</td><td style="padding:6px 12px;border:1px solid #ddd">\${fullName}</td></tr>
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Email</td><td style="padding:6px 12px;border:1px solid #ddd">\${email}</td></tr>
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Role</td><td style="padding:6px 12px;border:1px solid #ddd">\${role}</td></tr>
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Created By</td><td style="padding:6px 12px;border:1px solid #ddd">\${createdBy}</td></tr>
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Time</td><td style="padding:6px 12px;border:1px solid #ddd">\${timestamp}</td></tr>
</table>`,
    },
    USER_LOCKED: {
      subject: '[DigiLog] Account Locked: ${username}',
      body: `<h2>User Account Locked</h2>
<table style="border-collapse:collapse;width:100%">
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Username</td><td style="padding:6px 12px;border:1px solid #ddd">\${username}</td></tr>
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Full Name</td><td style="padding:6px 12px;border:1px solid #ddd">\${fullName}</td></tr>
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Reason</td><td style="padding:6px 12px;border:1px solid #ddd">\${reason}</td></tr>
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Failed Attempts</td><td style="padding:6px 12px;border:1px solid #ddd">\${failedAttempts}</td></tr>
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">IP Address</td><td style="padding:6px 12px;border:1px solid #ddd">\${ipAddress}</td></tr>
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Time</td><td style="padding:6px 12px;border:1px solid #ddd">\${timestamp}</td></tr>
</table>`,
    },
    CHECKLIST_SUBMITTED: {
      subject: '[DigiLog] Checklist Submitted: ${checklistName}',
      body: `<h2>Checklist Submitted</h2>
<table style="border-collapse:collapse;width:100%">
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Checklist</td><td style="padding:6px 12px;border:1px solid #ddd">\${checklistName}</td></tr>
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Entity</td><td style="padding:6px 12px;border:1px solid #ddd">\${entityName}</td></tr>
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Submitted By</td><td style="padding:6px 12px;border:1px solid #ddd">\${submittedBy}</td></tr>
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Time</td><td style="padding:6px 12px;border:1px solid #ddd">\${timestamp}</td></tr>
</table>`,
    },
    CHECKLIST_APPROVED: {
      subject: '[DigiLog] Checklist Approved: ${checklistName}',
      body: `<h2>Checklist Approved</h2>
<table style="border-collapse:collapse;width:100%">
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Checklist</td><td style="padding:6px 12px;border:1px solid #ddd">\${checklistName}</td></tr>
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Approved By</td><td style="padding:6px 12px;border:1px solid #ddd">\${approvedBy}</td></tr>
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Time</td><td style="padding:6px 12px;border:1px solid #ddd">\${timestamp}</td></tr>
</table>`,
    },
    CHECKLIST_REJECTED: {
      subject: '[DigiLog] Checklist Rejected: ${checklistName}',
      body: `<h2>Checklist Rejected</h2>
<table style="border-collapse:collapse;width:100%">
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Checklist</td><td style="padding:6px 12px;border:1px solid #ddd">\${checklistName}</td></tr>
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Rejected By</td><td style="padding:6px 12px;border:1px solid #ddd">\${rejectedBy}</td></tr>
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Reason</td><td style="padding:6px 12px;border:1px solid #ddd">\${reason}</td></tr>
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Time</td><td style="padding:6px 12px;border:1px solid #ddd">\${timestamp}</td></tr>
</table>`,
    },
    SYSTEM_ERROR: {
      subject: '[DigiLog] System Error: ${errorType}',
      body: `<h2>System Error</h2>
<table style="border-collapse:collapse;width:100%">
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Error Type</td><td style="padding:6px 12px;border:1px solid #ddd">\${errorType}</td></tr>
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Message</td><td style="padding:6px 12px;border:1px solid #ddd">\${errorMessage}</td></tr>
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">URL</td><td style="padding:6px 12px;border:1px solid #ddd">\${url}</td></tr>
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Time</td><td style="padding:6px 12px;border:1px solid #ddd">\${timestamp}</td></tr>
</table>`,
    },
  };

  const tmpl = templates[eventType];
  if (tmpl) {
    return { subject: tmpl.subject, bodyTemplate: tmpl.body };
  }
  return { subject: `[DigiLog] Alert: ${eventType}`, bodyTemplate: `<h2>DigiLog Alert</h2><p>Event: <strong>\${eventType}</strong></p><p>Time: \${timestamp}</p>` };
}

function getDefaultSmsTemplate(eventType: string): { bodyTemplate: string } {
  return { bodyTemplate: 'DigiLog ${eventLabel}: ${summary}' + '\n' + '${smsDetails}' };
}

function getDefaultInAppMessage(eventType: string): string {
  const msgs: Record<string, string> = {
    DEVICE_ONLINE: 'Device ${deviceName} is back online',
    DEVICE_OFFLINE: 'Device ${deviceName} went offline',
    DEVICE_INACTIVITY: 'Device ${deviceName} has been inactive since ${inactiveSince}',
    USER_LOGIN: 'User ${username} logged in',
    USER_CREATED: 'New user ${username} created by ${createdBy}',
    USER_LOCKED: 'User ${username} account locked: ${reason}',
    CHECKLIST_SUBMITTED: 'Checklist ${checklistName} submitted by ${submittedBy}',
    CHECKLIST_APPROVED: 'Checklist ${checklistName} approved by ${approvedBy}',
    CHECKLIST_REJECTED: 'Checklist ${checklistName} rejected by ${rejectedBy}',
    SYSTEM_ERROR: 'System error: ${errorMessage}',
  };
  return msgs[eventType] ?? `Notification: ${eventType}`;
}
