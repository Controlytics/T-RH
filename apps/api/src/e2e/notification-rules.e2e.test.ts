import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs, authGet, authPost, authPut, authDelete } from './test-helper.js';
import { prisma } from '../lib/prisma.js';

/**
 * Notification rules — previously ZERO test coverage (audit finding H4).
 *
 * This module decides WHO gets told when something goes wrong: an alarm
 * raised, a §11 event recorded, a system error. Its failure mode is silence,
 * which nobody reports as a bug.
 *
 * The rule row and its recipients are written together — the recipients are a
 * separate table (`notification_rule_recipients`) reached only through a
 * nested `include`, which is why a Prisma-client census reads that table as
 * unused. These tests exercise it through HTTP, the way the dispatcher does.
 */

/** Well-formed uuid that names no row — distinguishes 404 from a parse error. */
const ABSENT_UUID = '00000000-0000-4000-8000-000000000000';

describe('notification-rules e2e', () => {
  let app: FastifyInstance;
  let token: string;
  const created: string[] = [];
  let eventType: string;

  beforeAll(async () => {
    app = await buildApp();
    token = await loginAs(app);

    // Take a real event type from the server rather than hardcoding one — the
    // enum has changed twice and a stale literal would fail for the wrong reason.
    const res = await authGet(app, '/api/notification-rules/event-types', token);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const list = Array.isArray(body) ? body : body.eventTypes ?? body.data ?? [];
    expect(list.length).toBeGreaterThan(0);
    const first = list[0];
    eventType = typeof first === 'string' ? first : first.value ?? first.eventType ?? first.key;
    expect(typeof eventType).toBe('string');
  });

  afterAll(async () => {
    for (const id of created) {
      await prisma.notificationRule.deleteMany({ where: { id } });
    }
    await app.close();
  });

  async function makeRule(extra: Record<string, unknown> = {}) {
    const res = await authPost(app, '/api/notification-rules', token, {
      name: `E2E Rule ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      eventTypes: [eventType],
      ...extra,
    });
    expect(res.statusCode).toBe(200);
    const rule = JSON.parse(res.body);
    created.push(rule.id);
    return rule;
  }

  describe('event types', () => {
    it('lists event types a rule can subscribe to', async () => {
      const res = await authGet(app, '/api/notification-rules/event-types', token);
      expect(res.statusCode).toBe(200);
    });
  });

  describe('CRUD', () => {
    it('creates a rule', async () => {
      const rule = await makeRule();
      expect(rule.id).toBeTruthy();
      expect(rule.eventTypes).toContain(eventType);
    });

    // The handler normalises between the singular `eventType` column and the
    // `eventTypes` array. If those two ever disagree, the dispatcher matches on
    // one while the UI shows the other — a rule that looks armed and is not.
    it('keeps eventType and eventTypes consistent', async () => {
      const rule = await makeRule();
      expect(rule.eventType).toBe(rule.eventTypes[0]);
    });

    it('rejects a rule with no event types', async () => {
      const res = await authPost(app, '/api/notification-rules', token, { name: 'no events' });
      expect(res.statusCode).toBe(400);
    });

    it('rejects an empty eventTypes array', async () => {
      const res = await authPost(app, '/api/notification-rules', token, {
        name: 'empty', eventTypes: [],
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects a rule with no name', async () => {
      const res = await authPost(app, '/api/notification-rules', token, {
        eventTypes: [eventType],
      });
      expect(res.statusCode).toBe(400);
    });

    it('fetches a rule by id', async () => {
      const rule = await makeRule();
      const res = await authGet(app, `/api/notification-rules/${rule.id}`, token);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).id).toBe(rule.id);
    });

    it('lists rules including the one just created', async () => {
      const rule = await makeRule();
      const res = await authGet(app, '/api/notification-rules', token);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const rules = Array.isArray(body) ? body : body.rules ?? body.data ?? [];
      expect(rules.map((r: any) => r.id)).toContain(rule.id);
    });

    it('updates a rule', async () => {
      const rule = await makeRule();
      const res = await authPut(app, `/api/notification-rules/${rule.id}`, token, {
        description: 'updated',
      });
      expect(res.statusCode).toBe(200);
      const row = await prisma.notificationRule.findUnique({ where: { id: rule.id } });
      expect(row?.description).toBe('updated');
    });

    // The PUT handler destructures createdBy/createdAt/id out of the body
    // before it reaches Prisma. That is the only thing standing between a
    // client and rewriting a rule's provenance, since the body schema does not
    // set additionalProperties:false. Pin it.
    it('does not let a client rewrite provenance fields', async () => {
      const rule = await makeRule();
      const before = await prisma.notificationRule.findUnique({ where: { id: rule.id } });
      const res = await authPut(app, `/api/notification-rules/${rule.id}`, token, {
        description: 'legit',
        createdBy: 'attacker',
      });
      expect(res.statusCode).toBe(200);
      const after = await prisma.notificationRule.findUnique({ where: { id: rule.id } });
      expect(after?.createdBy).toBe(before?.createdBy);
      expect(after?.createdBy).not.toBe('attacker');
    });

    it('deletes a rule', async () => {
      const rule = await makeRule();
      const res = await authDelete(app, `/api/notification-rules/${rule.id}`, token);
      expect(res.statusCode).toBe(200);
      expect(
        await prisma.notificationRule.findUnique({ where: { id: rule.id } }),
      ).toBeNull();
    });

    it('404s on a valid but absent id', async () => {
      const res = await authGet(app, `/api/notification-rules/${ABSENT_UUID}`, token);
      expect(res.statusCode).toBe(404);
    });

    it('400s on a malformed id rather than 500', async () => {
      const res = await authGet(app, '/api/notification-rules/not-a-uuid', token);
      expect(res.statusCode).toBe(400);
    });
  });

  describe('recipients — who actually gets told', () => {
    it('persists ROLE recipients through the nested write', async () => {
      const rule = await makeRule({
        recipients: [{ recipientType: 'ROLE', roleValue: 'SUPER_ADMIN' }],
      });
      const rows = await prisma.notificationRuleRecipient.findMany({
        where: { ruleId: rule.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].recipientType).toBe('ROLE');
      expect(rows[0].roleValue).toBe('SUPER_ADMIN');
    });

    // The create/update handlers null the two irrelevant columns per recipient
    // type. Without that a ROLE recipient could carry a stale groupId and be
    // resolved twice by the dispatcher.
    it('nulls the columns that do not apply to the recipient type', async () => {
      const rule = await makeRule({
        recipients: [{
          recipientType: 'ROLE',
          roleValue: 'SUPER_ADMIN',
          groupId: ABSENT_UUID,
          userId: ABSENT_UUID,
        }],
      });
      const row = await prisma.notificationRuleRecipient.findFirst({
        where: { ruleId: rule.id },
      });
      expect(row?.roleValue).toBe('SUPER_ADMIN');
      expect(row?.groupId).toBeNull();
      expect(row?.userId).toBeNull();
    });

    it('rejects an unknown recipientType', async () => {
      const res = await authPost(app, '/api/notification-rules', token, {
        name: `E2E Bad ${Date.now()}`,
        eventTypes: [eventType],
        recipients: [{ recipientType: 'CARRIER_PIGEON' }],
      });
      expect(res.statusCode).toBe(400);
    });

    // PUT replaces recipients wholesale. A partial update that silently kept
    // the old set would leave people notified after an admin removed them.
    it('replaces the recipient set on update', async () => {
      const rule = await makeRule({
        recipients: [{ recipientType: 'ROLE', roleValue: 'SUPER_ADMIN' }],
      });
      const res = await authPut(app, `/api/notification-rules/${rule.id}`, token, {
        recipients: [{ recipientType: 'ROLE', roleValue: 'OPERATOR' }],
      });
      expect(res.statusCode).toBe(200);

      const rows = await prisma.notificationRuleRecipient.findMany({
        where: { ruleId: rule.id },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].roleValue).toBe('OPERATOR');
    });

    it('clears recipients when an empty array is sent', async () => {
      const rule = await makeRule({
        recipients: [{ recipientType: 'ROLE', roleValue: 'SUPER_ADMIN' }],
      });
      await authPut(app, `/api/notification-rules/${rule.id}`, token, { recipients: [] });
      expect(
        await prisma.notificationRuleRecipient.count({ where: { ruleId: rule.id } }),
      ).toBe(0);
    });

    // Omitting the key entirely is NOT the same as sending []. An update that
    // does not mention recipients must leave them alone, or every edit to a
    // rule's name would silently unsubscribe everyone.
    it('leaves recipients untouched when the key is omitted', async () => {
      const rule = await makeRule({
        recipients: [{ recipientType: 'ROLE', roleValue: 'SUPER_ADMIN' }],
      });
      await authPut(app, `/api/notification-rules/${rule.id}`, token, {
        description: 'renamed only',
      });
      expect(
        await prisma.notificationRuleRecipient.count({ where: { ruleId: rule.id } }),
      ).toBe(1);
    });

    it('cascades recipients when the rule is deleted', async () => {
      const rule = await makeRule({
        recipients: [{ recipientType: 'ROLE', roleValue: 'SUPER_ADMIN' }],
      });
      await authDelete(app, `/api/notification-rules/${rule.id}`, token);
      expect(
        await prisma.notificationRuleRecipient.count({ where: { ruleId: rule.id } }),
      ).toBe(0);
    });
  });

  describe('toggle', () => {
    it('flips isActive and persists it', async () => {
      const rule = await makeRule({ isActive: true });
      const res = await authPut(app, `/api/notification-rules/${rule.id}/toggle`, token, {});
      expect(res.statusCode).toBe(200);
      const row = await prisma.notificationRule.findUnique({ where: { id: rule.id } });
      expect(row?.isActive).toBe(false);
    });
  });

  describe('audit trail', () => {
    it('audits rule creation', async () => {
      const rule = await makeRule();
      const row = await prisma.auditTrail.findFirst({
        where: { action: 'NOTIFICATION_RULE_CREATED', targetId: rule.id },
      });
      expect(row).not.toBeNull();
    });
  });

  describe('authentication', () => {
    it('rejects an unauthenticated list', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/notification-rules' });
      expect(res.statusCode).toBe(401);
    });

    it('rejects an unauthenticated create', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/notification-rules',
        payload: { name: 'x', eventTypes: [eventType] },
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
