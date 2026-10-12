/**
 * The notification dispatcher against alarm events, on the real database
 * (rules, recipients, roles, scopes and log rows real; the email channel and the
 * job producer stubbed).
 *
 *  #4  cooldown was keyed on rule.id across the whole fleet and claimed before
 *      the send: instrument B's alarm a minute after A's was dropped, so was
 *      ALARM_CLEARED, and a failed send burned the window.
 *  #5  recipients were filtered only by ENABLED: a role without ALARM_READ, or
 *      scoped to Block A, was emailed every Block-B excursion.
 *  #9  a notification job retried after a later failure re-sent to the
 *      recipients an earlier rule had already reached.
 *  #12 the ALARM_CLEARED email printed raisedAt as raw UTC ISO beside a
 *      timestamp in the configured zone.
 *
 * Other suites' rules may match the same events in this shared database, so every
 * assertion counts sends to THIS file's recipients only.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

const emailSend = vi.fn();
vi.mock('../channels/email-channel.js', () => ({
  emailChannel: { name: 'EMAIL', send: (...a: unknown[]) => emailSend(...a), testConnection: vi.fn() },
}));
const addJob = vi.fn(async () => ({ id: 'job' }));
vi.mock('@digilog/queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@digilog/queue')>()),
  getProducer: async () => ({ addJob }),
}));

// A transient fault inside rule 2's rendering, armed per test (#9).
let failMarkedTemplateOnce = false;
vi.mock('../template-engine.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../template-engine.js')>();
  return {
    ...real,
    resolveTemplate: (template: string, vars: Record<string, string>) => {
      if (failMarkedTemplateOnce && template.includes('NDT-FAIL-MARK')) {
        failMarkedTemplateOnce = false;
        throw new Error('connection reset');
      }
      return real.resolveTemplate(template, vars);
    },
  };
});

import { prisma } from '../../../lib/prisma.js';
import { invalidateRolePermsCache } from '../../../plugins/rbac.js';
import { fixtureProfileId } from '../../../test-support/fixture-profile.js';
import { formatConfiguredDateTime } from '../../../lib/format-datetime.js';
import { dispatchNotification } from '../notification-dispatcher.js';
import { resetNotificationCooldowns } from '../cooldown.js';
import { notificationService } from '../../notifications/notification.service.js';
import { NotificationEventType, NotificationType } from '@prisma/client';

const S = `${Date.now()}`;
const ROLE_READ = `NDT_READ_${S}`.slice(0, 50);
const ROLE_NOREAD = `NDT_NOREAD_${S}`.slice(0, 50);
const ROLE_WIDE = `NDT_WIDE_${S}`.slice(0, 50);
const mail = (n: string) => `ndt-${n}-${S}@test.example`;

const ids = {
  areaA: '', areaB: '', instA: '', instB: '', instC: '', instD: '',
  uReader: '', uNoRead: '', uWide: '', uDedup1: '', uDedup2: '',
  rule: '', rule1: '', rule2: '', template: '',
};
const ALL_MAILS = ['reader', 'noread', 'wide', 'dedup1', 'dedup2'].map(mail);

const sentTo = (who: string) => emailSend.mock.calls.filter((c) => (c[0] as { recipient: string }).recipient === mail(who));
const raised = (instrumentId: string, dedupKey?: string) => dispatchNotification({
  eventType: 'ALARM_RAISED',
  context: { metric: 'TEMPERATURE', instrumentId },
  variables: { instrument: 'X', metric: 'TEMPERATURE', value: '30', condition: 'above 25', ruleName: 'High Temperature', timestamp: new Date().toISOString() },
  ...(dedupKey ? { dedupKey } : {}),
} as Parameters<typeof dispatchNotification>[0]);

beforeAll(async () => {
  for (const [name, perms] of [[ROLE_READ, ['ALARM_READ']], [ROLE_NOREAD, ['INSTRUMENT_READ']], [ROLE_WIDE, ['ALARM_READ']]] as const) {
    await prisma.role.create({ data: { name, displayName: name, hierarchyLevel: 1, permissions: [...perms] } });
  }
  invalidateRolePermsCache();
  const areaA = await prisma.functionalLocation.create({ data: { name: `ndt-a-${S}`, type: 'BLOCK' } });
  const areaB = await prisma.functionalLocation.create({ data: { name: `ndt-b-${S}`, type: 'BLOCK' } });
  ids.areaA = areaA.id; ids.areaB = areaB.id;
  await prisma.roleConfig.create({ data: { role: ROLE_READ, instrumentScope: { locationIds: [areaA.id], instrumentIds: [] } } });

  const profileId = await fixtureProfileId('fixture:notification-dispatcher');
  const inst = (code: string, fl: string) => prisma.instrument.create({ data: { code: `NDT-${code}-${S}`, name: code, profileId, functionalLocationId: fl } });
  ids.instA = (await inst('A', areaA.id)).id;
  ids.instB = (await inst('B', areaB.id)).id;
  ids.instC = (await inst('C', areaA.id)).id;
  ids.instD = (await inst('D', areaA.id)).id;

  const user = (n: string, role: string) => prisma.user.create({
    data: { username: `ndt_${n}_${S}`.slice(0, 50), fullName: n, email: mail(n), passwordHash: 'x', role, status: 'ENABLED' },
  });
  ids.uReader = (await user('reader', ROLE_READ)).id;
  ids.uNoRead = (await user('noread', ROLE_NOREAD)).id;
  ids.uWide = (await user('wide', ROLE_WIDE)).id;
  ids.uDedup1 = (await user('dedup1', ROLE_WIDE)).id;
  ids.uDedup2 = (await user('dedup2', ROLE_WIDE)).id;

  const rule = await prisma.notificationRule.create({
    data: {
      name: `ndt main ${S}`, eventType: 'ALARM_RAISED', eventTypes: ['ALARM_RAISED', 'ALARM_CLEARED'],
      emailEnabled: true, inAppEnabled: false, cooldownMinutes: 10, priority: 1,
      // Only this file's fixtures: other suites' events must not hit it.
      conditions: { instrumentId: [ids.instA, ids.instB, ids.instC, ids.instD] },
      recipients: { create: [ids.uReader, ids.uNoRead, ids.uWide].map((userId) => ({ recipientType: 'USER', userId })) },
    },
  });
  ids.rule = rule.id;

  const template = await prisma.notificationTemplate.create({
    data: { name: `ndt-tpl-${S}`, channel: 'EMAIL', subject: 'tpl', bodyTemplate: '<p>${instrument}</p><!-- NDT-FAIL-MARK -->' },
  });
  ids.template = template.id;
  ids.rule1 = (await prisma.notificationRule.create({
    data: {
      name: `ndt r1 ${S}`, eventType: 'ALARM_RAISED', eventTypes: ['ALARM_RAISED'], priority: 50,
      emailEnabled: true, inAppEnabled: true, conditions: { instrumentId: ids.instD },
      recipients: { create: [{ recipientType: 'USER', userId: ids.uDedup1 }] },
    },
  })).id;
  ids.rule2 = (await prisma.notificationRule.create({
    data: {
      name: `ndt r2 ${S}`, eventType: 'ALARM_RAISED', eventTypes: ['ALARM_RAISED'], priority: 40,
      emailEnabled: true, inAppEnabled: false, conditions: { instrumentId: ids.instD }, emailTemplateId: template.id,
      recipients: { create: [{ recipientType: 'USER', userId: ids.uDedup2 }] },
    },
  })).id;
});

afterAll(async () => {
  await prisma.notificationRule.deleteMany({ where: { id: { in: [ids.rule, ids.rule1, ids.rule2].filter(Boolean) } } });
  await prisma.notificationTemplate.deleteMany({ where: { name: `ndt-tpl-${S}` } });
  await prisma.notificationLog.deleteMany({ where: { recipient: { in: ALL_MAILS } } });
  await prisma.notification.deleteMany({ where: { forUserId: { startsWith: 'ndt_' } } });
  await prisma.user.deleteMany({ where: { email: { in: ALL_MAILS } } });
  await prisma.instrument.deleteMany({ where: { code: { startsWith: 'NDT-' } } });
  await prisma.roleConfig.deleteMany({ where: { role: { in: [ROLE_READ, ROLE_NOREAD, ROLE_WIDE] } } });
  await prisma.functionalLocation.deleteMany({ where: { id: { in: [ids.areaA, ids.areaB].filter(Boolean) } } });
  await prisma.role.deleteMany({ where: { name: { in: [ROLE_READ, ROLE_NOREAD, ROLE_WIDE] } } });
  invalidateRolePermsCache();
});

beforeEach(() => {
  emailSend.mockReset();
  emailSend.mockResolvedValue({ success: true, messageId: 'm' });
});

describe('#5 recipients are scoped like the Alarms page', () => {
  it('a role WITHOUT ALARM_READ is not emailed; one scoped to the alarm\'s block is', async () => {
    resetNotificationCooldowns();
    await raised(ids.instA);
    expect(sentTo('reader')).toHaveLength(1);
    expect(sentTo('wide')).toHaveLength(1);
    expect(sentTo('noread')).toHaveLength(0);
  });

  it('a user scoped to Block A is not emailed about an instrument in Block B', async () => {
    await raised(ids.instB);
    expect(sentTo('reader')).toHaveLength(0);
    // ...and this second instrument's alarm, a moment after the first, was not
    // swallowed by the first one's cooldown (#4).
    expect(sentTo('wide')).toHaveLength(1);
  });
});

describe('#4 cooldown is per rule + instrument + event, and released on a failed send', () => {
  it('ALARM_CLEARED is never suppressed by the RAISED cooldown, and prints raisedAt in the configured zone (#12)', async () => {
    const raisedAt = '2026-10-12T04:00:00.000Z';
    await dispatchNotification({
      eventType: 'ALARM_CLEARED',
      context: { metric: 'TEMPERATURE', instrumentId: ids.instA },
      variables: { instrument: 'X', metric: 'TEMPERATURE', condition: 'above 25', ruleName: 'High Temperature', raisedAt, duration: '5 min', timestamp: new Date().toISOString() },
    });
    const sends = sentTo('wide');
    expect(sends).toHaveLength(1);
    const message = (sends[0][0] as { message: string }).message;
    expect(message).not.toContain(raisedAt);
    expect(message).toContain(await formatConfiguredDateTime(raisedAt));
  });

  it('the same instrument raising again inside the window IS suppressed', async () => {
    await raised(ids.instA);
    expect(sentTo('wide')).toHaveLength(0);
  });

  it('a send that reached nobody releases the window', async () => {
    emailSend.mockResolvedValue({ success: false, error: 'smtp down' });
    await raised(ids.instC);
    emailSend.mockReset();
    emailSend.mockResolvedValue({ success: true, messageId: 'm' });
    await raised(ids.instC);
    expect(sentTo('wide')).toHaveLength(1);
  });
});

describe('#9 a retried notification job does not re-send to recipients already reached', () => {
  it('rule 1 delivered, rule 2 failed with an error; the retry reaches rule 2 only', async () => {
    failMarkedTemplateOnce = true;
    await expect(raised(ids.instD, 'job:ndt-1')).rejects.toThrow();
    expect(sentTo('dedup1')).toHaveLength(1);
    expect(sentTo('dedup2')).toHaveLength(0);

    // graphile-worker retries the SAME job — same dedup key.
    await raised(ids.instD, 'job:ndt-1');
    expect(sentTo('dedup1')).toHaveLength(1);
    expect(sentTo('dedup2')).toHaveLength(1);
    // Rule 1 has in-app ON: exactly ONE in-app row, though the job ran twice.
    // (Until migration 20261012140000 NotificationType had no ALARM_RAISED and no
    // in-app alarm row could be stored at all.)
    const inApp = await prisma.notification.findMany({ where: { forUserId: { startsWith: 'ndt_dedup1_' } } });
    expect(inApp).toHaveLength(1);
    expect(inApp[0].type).toBe('ALARM_RAISED');
  });
});

describe('in-app alarm notifications are stored and shown', () => {
  it('a rule with in-app ON stores an ALARM_CLEARED row the recipient\'s notification list returns', async () => {
    await prisma.notificationRule.update({ where: { id: ids.rule1 }, data: { eventTypes: ['ALARM_RAISED', 'ALARM_CLEARED'] } });
    await dispatchNotification({
      eventType: 'ALARM_CLEARED',
      context: { metric: 'TEMPERATURE', instrumentId: ids.instD },
      variables: { instrument: 'X', metric: 'TEMPERATURE', condition: 'above 25', ruleName: 'High Temperature', raisedAt: new Date().toISOString(), duration: '5 min', timestamp: new Date().toISOString() },
    });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: ids.uDedup1 } });
    const list = await notificationService.list({ page: '1', limit: '50' }, user.role, user.username);
    const cleared = (list.data as { type: string; message: string }[]).filter((n) => n.type === 'ALARM_CLEARED');
    expect(cleared).toHaveLength(1);
    expect(cleared[0].message).toContain('cleared');
  });
});

describe('the dedup lookup is indexed (#9)', () => {
  it('both tables answer metadata->>\'dedupKey\' from an index', async () => {
    for (const table of ['notification_logs', 'notifications']) {
      const plan = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
        return tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
          `EXPLAIN SELECT 1 FROM ${table} WHERE metadata->>'dedupKey' = 'job:x'`,
        );
      });
      expect(plan.map((r) => r['QUERY PLAN']).join('\n')).toMatch(/dedup_key_idx/);
    }
  });
});

describe('enum parity', () => {
  // `notifications.type` stores the rule's EVENT type, so every value a rule can
  // subscribe to must be storable there. ALARM_RAISED/ALARM_CLEARED were missing
  // for two months and every in-app alarm row failed at insert.
  it('every NotificationEventType is a NotificationType', () => {
    for (const v of Object.values(NotificationEventType)) {
      expect(Object.values(NotificationType), v).toContain(v);
    }
  });
});
