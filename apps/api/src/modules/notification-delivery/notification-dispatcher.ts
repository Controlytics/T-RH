/**
 * Notification Dispatcher — Central service that matches events to notification rules,
 * resolves recipients, and dispatches via the delivery service.
 */
import { prisma } from '../../lib/prisma.js';
import { sendNotification } from './delivery.service.js';
import { resolveTemplate } from './template-engine.js';
import { formatConfiguredDateTime } from '../../lib/format-datetime.js';
import { logger } from '../../lib/logger.js';
import { roleHasPermission } from '../../plugins/rbac.js';
import { resolveVisibility } from '../instruments/visibility.js';
import { claimCooldown, releaseCooldown, cooldownKey } from './cooldown.js';

interface DispatchEvent {
  eventType: string;
  context: Record<string, unknown>;
  variables: Record<string, string>;
  forceRuleId?: string; // For testing a specific rule
  /**
   * Identity of THIS delivery of THIS event, stable across retries — the
   * notification worker passes `job:<graphile job id>` (audit 2026-10-12 #9).
   * Every log row / in-app row written for the event carries it; a retry skips
   * any (rule, channel, recipient) that already has one, so a job retried after a
   * later rule failed does not re-send to the recipients an earlier rule reached.
   * Absent for the direct (un-queued) callers, which are never retried.
   */
  dedupKey?: string;
}

/** Variables the callers pass as UTC ISO that must print in the configured zone. */
const TIME_VARIABLES = ['timestamp', 'raisedAt', 'clearedAt', 'inactiveSince'] as const;

/**
 * Main dispatcher: find matching rules, resolve recipients, send notifications.
 */
export async function dispatchNotification(event: DispatchEvent): Promise<void> {
  // [Dispatcher] event received
  const { eventType, context, variables, forceRuleId } = event;

  const { dedupKey } = event;

  // Normalize the time variables (callers pass UTC ISO) to the configured
  // timezone/format — IST by default — so every rendered email/SMS/in-app shows
  // local time, not raw UTC. Leaves non-parseable pre-formatted values untouched.
  // `raisedAt` joined `timestamp` 2026-10-12 (#12): the ALARM_CLEARED email printed
  // "Raised At 2026-10-12T04:00:00.000Z" beside a "Time" in IST.
  for (const key of TIME_VARIABLES) {
    const raw = variables[key];
    if (!raw || !/^\d{4}-\d{2}-\d{2}T/.test(raw)) continue;
    const formatted = await formatConfiguredDateTime(raw);
    if (formatted) variables[key] = formatted;
  }

  // Build eventLabel, summary, and dynamic details HTML based on event type
  const EVENT_LABELS: Record<string, string> = {
    DEVICE_ONLINE: 'Device Online', DEVICE_OFFLINE: 'Device Offline', DEVICE_INACTIVITY: 'Device Inactive',
    USER_LOGIN: 'User Login', USER_CREATED: 'User Created', USER_LOCKED: 'User Locked',
    SYSTEM_ERROR: 'System Error',
    ALARM_RAISED: 'Alarm Raised', ALARM_CLEARED: 'Alarm Cleared',
  };
  // Which fields to show per event type (label -> variable key)
  const EVENT_FIELDS: Record<string, [string, string][]> = {
    DEVICE_ONLINE: [['Device','deviceName'],['UNS Path','unsPath'],['Protocol','protocol'],['Source IP','sourceIp'],['Time','timestamp']],
    DEVICE_OFFLINE: [['Device','deviceName'],['UNS Path','unsPath'],['Time','timestamp']],
    DEVICE_INACTIVITY: [['Device','deviceName'],['UNS Path','unsPath'],['Inactive Since','inactiveSince'],['Timeout (sec)','timeoutSeconds'],['Time','timestamp']],
    USER_LOGIN: [['Username','username'],['Full Name','fullName'],['Role','role'],['IP Address','ipAddress'],['Time','timestamp']],
    USER_CREATED: [['Username','username'],['Full Name','fullName'],['Email','email'],['Role','role'],['Created By','createdBy'],['Time','timestamp']],
    USER_LOCKED: [['Username','username'],['Full Name','fullName'],['Reason','reason'],['Failed Attempts','failedAttempts'],['IP Address','ipAddress'],['Time','timestamp']],
    SYSTEM_ERROR: [['Error Type','errorType'],['Message','errorMessage'],['URL','url'],['Time','timestamp']],
    ALARM_RAISED: [['Instrument','instrument'],['Metric','metric'],['Reading','value'],['Condition','condition'],['Rule','ruleName'],['Time','timestamp']],
    ALARM_CLEARED: [['Instrument','instrument'],['Metric','metric'],['Condition','condition'],['Rule','ruleName'],['Raised At','raisedAt'],['Duration','duration'],['Time','timestamp']],
  };
  variables.eventLabel = EVENT_LABELS[eventType] ?? eventType;
  variables.summary = variables.message ?? variables.username ?? variables.deviceName ?? variables.errorType ?? variables.instrument ?? eventType;

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

  // What this event has ALREADY delivered, on an earlier attempt of the same job
  // (#9). Any row counts, whatever its status: a RETRYING/FAILED row has its own
  // durable retry chain, and a second row would be a second message.
  const done = new Set<string>();
  if (dedupKey) {
    // Raw SQL with `metadata->>'dedupKey'` — the exact expression the indexes
    // `notification_logs_dedup_key_idx` / `notifications_dedup_key_idx` are built
    // on (migration 20261012140100_notification_dedup_key_index). Prisma's JSON
    // path filter compiles to `#>` and would not use them: both tables only grow.
    const [logs, inApp] = await Promise.all([
      prisma.$queryRaw<{ channel: string; recipient: string; rule_id: string | null }[]>`
        SELECT channel::text AS channel, recipient, metadata->>'ruleId' AS rule_id
          FROM notification_logs WHERE metadata->>'dedupKey' = ${dedupKey}`,
      prisma.$queryRaw<{ for_user_id: string | null; rule_id: string | null }[]>`
        SELECT for_user_id, metadata->>'ruleId' AS rule_id
          FROM notifications WHERE metadata->>'dedupKey' = ${dedupKey}`,
    ]);
    for (const l of logs) done.add(`${l.rule_id}|${l.channel}|${l.recipient}`);
    for (const n of inApp) done.add(`${n.rule_id}|INAPP|${n.for_user_id}`);
  }

  // A fault in one rule (or one recipient) must not cost the others their
  // message; it is collected and re-thrown AFTER every rule has been tried, so the
  // notification job is retried — and the dedup set above keeps that retry from
  // re-sending what this attempt already delivered.
  const failures: unknown[] = [];

  for (const rule of rules) {
    try {
      // Evaluate conditions
      if (!forceRuleId && !matchConditions(rule.conditions as Record<string, unknown>, context)) {
        continue;
      }

      // Resolve recipients to user list — scoped for alarm events (#5).
      const users = await resolveRecipients(rule.recipients, eventType, context);
      // [Dispatcher] recipients resolved
      if (users.length === 0) continue;

      // Cooldown per rule + instrument + event type, claimed now and handed back
      // below if this event reached nobody (#4).
      const cdKey = cooldownKey(rule.id, eventType, context.instrumentId);
      const claimedAt = Date.now();
      if (!forceRuleId && !claimCooldown(cdKey, rule.cooldownMinutes * 60 * 1000, claimedAt, dedupKey)) continue;
      let reached = false;

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

      // Dispatch to each user. AWAITED (2026-10-12): the sends used to be fired and
      // forgotten, so nothing knew whether the event reached anyone (needed to
      // release the cooldown) and a throw could not make the job retry. Each send
      // makes one attempt; a failed attempt is retried durably by delivery.service.
      const meta = { ruleName: rule.name, eventType, ruleId: rule.id, ...(dedupKey ? { dedupKey } : {}) };
      const sends: Promise<boolean>[] = [];
      for (const user of users) {
        const userVars = { ...variables, recipientName: user.fullName, recipientEmail: user.email ?? '' };

        // Email
        if (rule.emailEnabled && emailTemplate && user.email && !done.has(`${rule.id}|EMAIL|${user.email}`)) {
          const tmpl = emailTemplate;
          const email = user.email;
          sends.push((async () => {
            const subject = resolveTemplate(tmpl.subject, userVars);
            const body = resolveTemplate(tmpl.bodyTemplate, userVars);
            const r = await sendNotification({
              channel: 'EMAIL', recipient: email, subject, message: body,
              triggeredBy: 'notification-rule', metadata: { ...meta, userId: user.id },
            });
            return r.success;
          })());
        }

        // SMS
        if (rule.smsEnabled && smsTemplate) {
          const phone = (configMap.get(`user-phone-${user.id}`) as any)?.phone as string | undefined;
          if (phone && !done.has(`${rule.id}|SMS|${phone}`)) {
            const tmpl = smsTemplate;
            sends.push((async () => {
              const body = resolveTemplate(tmpl.bodyTemplate, userVars);
              const r = await sendNotification({
                channel: 'SMS', recipient: phone, message: body,
                triggeredBy: 'notification-rule', metadata: { ...meta, userId: user.id },
              });
              return r.success;
            })());
          }
        }

        // In-App. `notifications.type` holds the rule's EVENT type, so every
        // NotificationEventType value must also be a NotificationType value —
        // ALARM_RAISED / ALARM_CLEARED were not until migration
        // 20261012140000_notification_type_alarm_events, and every in-app alarm
        // row failed at insert. A unit test now pins the two enums together.
        if (rule.inAppEnabled && !done.has(`${rule.id}|INAPP|${user.username}`)) {
          sends.push((async () => {
            const message = resolveTemplate(getDefaultInAppMessage(eventType), userVars);
            await prisma.notification.create({
              data: {
                type: eventType as any,
                title: rule.name,
                message,
                // forUserId is VarChar(50) and the visibility filter compares it
                // against the caller's username — must be the username string,
                // not the user UUID. See resolveRecipients() for the select.
                forUserId: user.username,
                metadata: { eventType, severity: mapEventToSeverity(eventType), ruleId: rule.id, ...(dedupKey ? { dedupKey } : {}) } as any,
              },
            });
            return true;
          })());
        }
      }

      const results = await Promise.allSettled(sends);
      for (const r of results) {
        if (r.status === 'fulfilled') {
          if (r.value) reached = true;
        } else {
          failures.push(r.reason);
          logger.error(`[Dispatcher] rule "${rule.name}" send failed:`, r.reason instanceof Error ? r.reason.message : String(r.reason));
        }
      }
      // Reached nobody: the window must not stand on a message never delivered (#4).
      // Retries already scheduled may still deliver it; the next event is then simply
      // not suppressed, which is the safe direction for an alarm.
      if (!reached && !forceRuleId) releaseCooldown(cdKey, claimedAt);
    } catch (err) {
      failures.push(err);
      logger.error(`[Dispatcher] rule "${rule.name}" failed:`, err instanceof Error ? err.message : String(err));
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, `[Dispatcher] ${failures.length} failure(s) dispatching ${eventType}`);
  }
}

/**
 * Resolve recipients from rules to actual user records.
 */
async function resolveRecipients(
  recipients: Array<{ recipientType: string; roleValue: string | null; groupId: string | null; userId: string | null }>,
  eventType: string,
  context: Record<string, unknown>,
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
  const users = await prisma.user.findMany({
    where: { id: { in: Array.from(allUserIds) }, status: 'ENABLED' },
    select: { id: true, username: true, email: true, fullName: true, role: true },
  });
  return (await scopeToAlarm(users, eventType, context))
    .map(({ role: _role, ...u }) => u);
}

/**
 * An alarm notification goes only to someone who could see the alarm (audit
 * 2026-10-12 #5). Recipients used to be filtered on ENABLED alone, so a role
 * without ALARM_READ — or one scoped to Block A — was emailed every Block-B
 * excursion: the instrument code, the reading and the condition, outside the
 * scope the Alarms page enforces for the same person.
 *
 * The same two answers the Alarms page uses, from the same resolvers:
 *  - ALARM_READ by `roleHasPermission` (the rule `requirePermission` applies,
 *    including an inactive role holding nothing);
 *  - the alarm's instrument within `resolveVisibility` for that user (the ONE
 *    visibility resolver; its `userId` is the USERNAME).
 * An alarm event with no instrument in its context (the rule test-fire) checks
 * the permission only. Non-alarm events are unchanged.
 */
async function scopeToAlarm<T extends { username: string; role: string }>(
  users: T[],
  eventType: string,
  context: Record<string, unknown>,
): Promise<T[]> {
  if (!eventType.startsWith('ALARM_')) return users;
  const instrumentId = typeof context.instrumentId === 'string' && context.instrumentId ? context.instrumentId : null;
  const out: T[] = [];
  for (const u of users) {
    if (!(await roleHasPermission(u.role, 'ALARM_READ'))) continue;
    if (instrumentId) {
      const { where } = await resolveVisibility({ userId: u.username, userRole: u.role });
      if (where) {
        const visible = await prisma.instrument.count({ where: { AND: [{ id: instrumentId }, where] } });
        if (visible === 0) continue;
      }
    }
    out.push(u);
  }
  return out;
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
    ALARM_RAISED: {
      subject: '[DigiLog] Alarm Raised: ${instrument}',
      body: `<h2>Alarm Raised</h2>
<table style="border-collapse:collapse;width:100%">
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Instrument</td><td style="padding:6px 12px;border:1px solid #ddd">\${instrument}</td></tr>
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Condition</td><td style="padding:6px 12px;border:1px solid #ddd">\${condition}</td></tr>
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Reading</td><td style="padding:6px 12px;border:1px solid #ddd">\${value}</td></tr>
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Rule</td><td style="padding:6px 12px;border:1px solid #ddd">\${ruleName}</td></tr>
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Time</td><td style="padding:6px 12px;border:1px solid #ddd">\${timestamp}</td></tr>
</table>
<p>Acknowledging this alarm is an electronic signature and requires a reason.</p>`,
    },
    ALARM_CLEARED: {
      subject: '[DigiLog] Alarm Cleared: ${instrument}',
      body: `<h2>Alarm Cleared</h2>
<table style="border-collapse:collapse;width:100%">
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Instrument</td><td style="padding:6px 12px;border:1px solid #ddd">\${instrument}</td></tr>
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Condition</td><td style="padding:6px 12px;border:1px solid #ddd">\${condition}</td></tr>
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Raised At</td><td style="padding:6px 12px;border:1px solid #ddd">\${raisedAt}</td></tr>
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Duration</td><td style="padding:6px 12px;border:1px solid #ddd">\${duration}</td></tr>
<tr><td style="padding:6px 12px;border:1px solid #ddd;font-weight:bold">Time</td><td style="padding:6px 12px;border:1px solid #ddd">\${timestamp}</td></tr>
</table>
<p>Clearing is automatic and does NOT acknowledge the alarm — it still needs answering for.</p>`,
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
    SYSTEM_ERROR: 'System error: ${errorMessage}',
    ALARM_RAISED: 'Alarm on ${instrument}: ${condition} (read ${value})',
    ALARM_CLEARED: 'Alarm on ${instrument} cleared after ${duration}',
  };
  return msgs[eventType] ?? `Notification: ${eventType}`;
}
