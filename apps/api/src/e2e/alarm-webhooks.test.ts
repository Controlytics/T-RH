import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { invalidateReauthCache } from '../lib/reauth-check.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';

/**
 * HTTP-level coverage of the alarm-webhook target module.
 *
 * Asserted over `app.inject` throughout, never off a function's return value: the
 * only thing that catches a field missing from the Fastify `response` schema is a
 * field missing from the JSON on the wire.
 *
 * The test fire points at a real `node:http` server on 127.0.0.1 rather than an
 * unroutable address. `deliverToTarget` retries three times, ~2s apart, and writes a
 * row per attempt — so a failing URL would cost >4s and produce three rows, testing
 * the retry loop instead of the route.
 */

let app: FastifyInstance;
let auth: Record<string, string>;
let hooter: http.Server;
let hooterUrl = '';
let hooterHits = 0;
let lastHooterBody = '';
let instrumentId = '';
const targets: string[] = [];

const reauth = { 'x-reauth-password': 'Admin@123' };
const headers = () => ({ ...auth, ...reauth });

let originalReauthRow: { configValue: unknown; configType: string; requiresReauth: boolean } | null = null;

beforeAll(async () => {
  app = await buildApp();
  auth = { authorization: `Bearer ${await loginAs(app)}` };

  // Flat shape — see auth-profile-reauth.test.ts's header comment: the seed writes a
  // nested `{ actions: [...] }` shape that `enforceReauth` does not read, so the gate
  // would never fire against the seeded row and "refused without reauth" would 201.
  const existing = await prisma.systemConfig.findUnique({ where: { configKey: 'action-reauth' } });
  if (existing) {
    originalReauthRow = {
      configValue: existing.configValue,
      configType: existing.configType,
      requiresReauth: existing.requiresReauth,
    };
  }
  await prisma.systemConfig.upsert({
    where: { configKey: 'action-reauth' },
    update: { configValue: { MANAGE_ALARM_WEBHOOK: ['SUPER_ADMIN'] } as never, configType: 'security', requiresReauth: false },
    create: { configKey: 'action-reauth', configValue: { MANAGE_ALARM_WEBHOOK: ['SUPER_ADMIN'] } as never, configType: 'security', requiresReauth: false },
  });
  invalidateReauthCache();

  hooter = http.createServer((req, res) => {
    hooterHits++;
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      lastHooterBody = body;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
    });
  });
  await new Promise<void>((resolve) => hooter.listen(0, '127.0.0.1', resolve));
  hooterUrl = `http://127.0.0.1:${(hooter.address() as AddressInfo).port}/alarm`;

  const inst = await app.inject({
    method: 'POST', url: '/api/instruments', headers: auth,
    payload: { name: 'hooter-e2e', code: `HOOK-E2E-${Date.now()}`, profileId: await fixtureProfileId('fixture:alarm-webhooks') },
  });
  expect(inst.statusCode).toBe(201);
  instrumentId = inst.json().id;
});

beforeEach(() => invalidateReauthCache());

afterAll(async () => {
  // Deliveries first: the FK is RESTRICT, so a target cleanup that skipped them would
  // fail silently and leave the 409 test interacting with the next run.
  for (const id of targets) {
    await prisma.alarmWebhookDelivery.deleteMany({ where: { targetId: id } });
    // deleteMany, not delete: the suite deletes some of these through the route, and
    // `delete` on an already-gone row logs a prisma error that reads like a failure.
    await prisma.alarmWebhookTarget.deleteMany({ where: { id } });
  }
  if (instrumentId) await app.inject({ method: 'DELETE', url: `/api/instruments/${instrumentId}`, headers: headers() });
  if (originalReauthRow) {
    await prisma.systemConfig.update({ where: { configKey: 'action-reauth' }, data: originalReauthRow as never });
  } else {
    await prisma.systemConfig.deleteMany({ where: { configKey: 'action-reauth' } });
  }
  invalidateReauthCache();
  await new Promise<void>((resolve) => hooter.close(() => resolve()));
  await app.close();
});

function payload(over: Record<string, unknown> = {}) {
  return {
    name: `hooter-e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    url: hooterUrl,
    scopeInstrumentIds: [instrumentId],
    ...over,
  };
}

async function newTarget(over: Record<string, unknown> = {}) {
  const res = await app.inject({ method: 'POST', url: '/api/alarm-webhooks', headers: headers(), payload: payload(over) });
  if (res.statusCode === 201) targets.push(res.json().id);
  return res;
}

describe('alarm webhook targets', () => {
  it('refuses an unauthenticated list', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/alarm-webhooks' });
    expect(res.statusCode).toBe(401);
  });

  it('lists for an authenticated caller', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/alarm-webhooks', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().data)).toBe(true);
  });

  it('refuses a create with no re-authentication', async () => {
    // A VALID payload with no reauth header: Fastify's body-schema validation runs
    // before the handler, so an invalid one would 400 before enforceReauth ever ran.
    const res = await app.inject({ method: 'POST', url: '/api/alarm-webhooks', headers: auth, payload: payload() });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('REAUTH_REQUIRED');
    expect(res.json().action).toBe('MANAGE_ALARM_WEBHOOK');
  });

  it('creates with re-authentication and returns EVERY declared field on the wire', async () => {
    const res = await newTarget({ description: 'QC-3 corridor hooter' });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    // The response-schema strip check. Fastify drops what it does not declare, in
    // silence, and a server-side assertion would still pass.
    for (const key of [
      'id', 'name', 'description', 'url', 'method', 'headers', 'contentType', 'bodyTemplate',
      'successRegex', 'timeoutMs', 'fireOnRaised', 'fireOnCleared', 'fireOnAcknowledged',
      'severities', 'cooldownSeconds', 'isActive', 'scopeLocationIds', 'scopeInstrumentIds',
      'instrumentCount', 'lastDeliveryStatus', 'lastDeliveryAt', 'createdAt', 'updatedAt',
    ]) {
      expect(body, `missing "${key}" — check the response schema`).toHaveProperty(key);
    }
    expect(body.method).toBe('POST');
    expect(body.bodyTemplate).toContain('${event}');
    expect(body.severities).toBeNull();
    expect(body.isActive).toBe(true);
    // Resolved server-side: the one instrument this target's scope names.
    expect(body.instrumentCount).toBe(1);
    // Never fired, so there is nothing to report — not a fabricated "SENT".
    expect(body.lastDeliveryStatus).toBeNull();
    expect(body.lastDeliveryAt).toBeNull();
  });

  it('reports the last delivery outcome on the list once the target has fired', async () => {
    const id = (await newTarget()).json().id;

    const before = (await app.inject({ method: 'GET', url: '/api/alarm-webhooks', headers: auth }))
      .json().data.find((t: { id: string }) => t.id === id);
    expect(before.lastDeliveryStatus).toBeNull();
    expect(before.lastDeliveryAt).toBeNull();

    await app.inject({ method: 'POST', url: `/api/alarm-webhooks/${id}/test`, headers: headers() });

    const after = (await app.inject({ method: 'GET', url: '/api/alarm-webhooks', headers: auth }))
      .json().data.find((t: { id: string }) => t.id === id);
    expect(after.lastDeliveryStatus).toBe('SENT');
    // A timestamp, not just a truthy string — the page renders it as a date.
    expect(Number.isNaN(Date.parse(after.lastDeliveryAt))).toBe(false);
  });

  it('reports the resolved instrument count so an empty scope is visible', async () => {
    const res = await newTarget({ scopeInstrumentIds: [] });
    expect(res.statusCode).toBe(201);
    expect(res.json().instrumentCount).toBe(0);
  });

  it('refuses a url that is not http(s), naming the field', async () => {
    const res = await newTarget({ url: 'ftp://192.168.1.60/alarm' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('VALIDATION_ERROR');
    expect(res.json().field).toBe('url');
  });

  it('refuses a body template naming a variable no event provides', async () => {
    const res = await newTarget({ bodyTemplate: '{"x":"${nonsense}"}' });
    expect(res.statusCode).toBe(400);
    expect(res.json().field).toBe('bodyTemplate');
    expect(res.json().message).toContain('nonsense');
  });

  // ── The four `sanitizeStrings` skipKeys exemptions ────────────────────────
  //
  // Every fixture below is TAG-SHAPED, and `stripHtml` was run against each one
  // directly to confirm it is damaged: an unexempted implementation stores a
  // different string and the assertion fails. A JSON template, a plain URL and a
  // reason like "value < 20" all survive stripHtml untouched, so a fixture of that
  // kind would pass with the exemption removed and prove nothing.

  it('does not sanitise an XML body template — `bodyTemplate` is exempt', async () => {
    // A genuinely supported configuration: contentType is operator-set and
    // renderWebhookBody honours it, so an XML hooter is the real case the exemption
    // exists for. stripHtml reduces this to '${event}${severity}'.
    const tpl = '<alarm><event>${event}</event><severity>${severity}</severity></alarm>';
    const res = await newTarget({ bodyTemplate: tpl, contentType: 'application/xml' });
    expect(res.statusCode).toBe(201);
    expect(res.json().bodyTemplate).toBe(tpl);
    expect(res.json().contentType).toBe('application/xml');
  });

  it('does not sanitise a tag-shaped url path — `url` is exempt', async () => {
    // stripHtml turns this into 'http://127.0.0.1:9/trigger', a DIFFERENT hooter.
    const url = 'http://127.0.0.1:9/<alarm>/trigger';
    const res = await newTarget({ url });
    expect(res.statusCode).toBe(201);
    expect(res.json().url).toBe(url);
  });

  it('does not sanitise a tag-shaped success regex — `successRegex` is exempt', async () => {
    // Cheap hardware answers with an XML-ish ack. stripHtml reduces this to '^$',
    // which matches only an empty body — every delivery would fail closed.
    const successRegex = '^<ok>$';
    const res = await newTarget({ successRegex });
    expect(res.statusCode).toBe(201);
    expect(res.json().successRegex).toBe(successRegex);
  });

  it('fetches one target', async () => {
    const id = (await newTarget()).json().id;
    const res = await app.inject({ method: 'GET', url: `/api/alarm-webhooks/${id}`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(id);
  });

  it('updates a field and writes ALARM_WEBHOOK_UPDATED with a beforeValue', async () => {
    const created = await newTarget();
    const id = created.json().id;
    const before = created.json().name;

    const res = await app.inject({
      method: 'PUT', url: `/api/alarm-webhooks/${id}`, headers: headers(),
      payload: { name: 'renamed by e2e', cooldownSeconds: 30 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('renamed by e2e');
    expect(res.json().cooldownSeconds).toBe(30);
    // A partial body must not wipe what it omits.
    expect(res.json().url).toBe(hooterUrl);
    expect(res.json().scopeInstrumentIds).toEqual([instrumentId]);

    const audit = await prisma.auditTrail.findFirst({
      where: { action: 'ALARM_WEBHOOK_UPDATED', targetId: id },
      orderBy: { timestamp: 'desc' },
    });
    expect(audit).not.toBeNull();
    expect((audit!.beforeValue as { name: string }).name).toBe(before);
    expect((audit!.afterValue as { name: string }).name).toBe('renamed by e2e');
  });

  it('toggles isActive with a partial body', async () => {
    const id = (await newTarget()).json().id;
    const off = await app.inject({ method: 'PUT', url: `/api/alarm-webhooks/${id}`, headers: headers(), payload: { isActive: false } });
    expect(off.json().isActive).toBe(false);
    // The count measures SCOPE, not current fireability — a deactivated target still
    // names its instrument, and reporting 0 would hide the mistake the count exists for.
    expect(off.json().instrumentCount).toBe(1);
    const on = await app.inject({ method: 'PUT', url: `/api/alarm-webhooks/${id}`, headers: headers(), payload: { isActive: true } });
    expect(on.json().isActive).toBe(true);
  });

  it('refuses a delete with no reason', async () => {
    const id = (await newTarget()).json().id;
    // Reauth header present, so the 400 isolates the missing reason.
    const res = await app.inject({ method: 'DELETE', url: `/api/alarm-webhooks/${id}`, headers: headers() });
    expect(res.statusCode).toBe(400);
    expect(await prisma.alarmWebhookTarget.findUnique({ where: { id } })).not.toBeNull();
  });

  it('keeps a tag-shaped reason verbatim — `reason` is exempt from sanitisation', async () => {
    const id = (await newTarget()).json().id;
    // stripHtml reduces this to 'decommissioned', silently blanking the reference
    // out of a regulated record. ("value < 20 per SOP-114" would NOT be damaged —
    // `<` followed by a space is not tag-shaped — so it proves nothing here.)
    const reason = 'decommissioned <per SOP-114>';
    const res = await app.inject({
      method: 'DELETE', url: `/api/alarm-webhooks/${id}`, headers: headers(), payload: { reason },
    });
    expect(res.statusCode).toBe(204);
    const audit = await prisma.auditTrail.findFirst({
      where: { action: 'ALARM_WEBHOOK_DELETED', targetId: id },
      orderBy: { timestamp: 'desc' },
    });
    expect(audit).not.toBeNull();
    expect(audit!.reason).toBe(reason);
    expect((audit!.beforeValue as { name: string }).name).toBeTruthy();
    expect(await prisma.alarmWebhookTarget.findUnique({ where: { id } })).toBeNull();
  });

  it('404s an unknown target on get, update, delete, test and deliveries', async () => {
    const ghost = '00000000-0000-4000-8000-000000000000';
    expect((await app.inject({ method: 'GET', url: `/api/alarm-webhooks/${ghost}`, headers: auth })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: `/api/alarm-webhooks/${ghost}`, headers: headers(), payload: { isActive: false } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/alarm-webhooks/${ghost}`, headers: headers(), payload: { reason: 'x' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/alarm-webhooks/${ghost}/test`, headers: headers() })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/alarm-webhooks/${ghost}/deliveries`, headers: auth })).statusCode).toBe(404);
  });

  it('test-fires, writing ONE delivery row with event TEST and alarmId null', async () => {
    // Deliberately deactivated and scoped to nothing: a test fire ignores both, because
    // commissioning a hooter must not require first configuring what you are testing.
    const created = await newTarget({ isActive: false, scopeInstrumentIds: [] });
    const id = created.json().id;
    const hitsBefore = hooterHits;

    const res = await app.inject({ method: 'POST', url: `/api/alarm-webhooks/${id}/test`, headers: headers() });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().httpStatus).toBe(200);
    expect(res.json().responseSnippet).toBe('OK');
    expect(res.json().error).toBeNull();
    expect(hooterHits).toBe(hitsBefore + 1);
    expect(lastHooterBody).toContain('"event":"TEST"');

    const rows = await prisma.alarmWebhookDelivery.findMany({ where: { targetId: id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].event).toBe('TEST');
    expect(rows[0].alarmId).toBeNull();
    expect(rows[0].status).toBe('SENT');

    const audit = await prisma.auditTrail.findFirst({
      where: { action: 'ALARM_WEBHOOK_TESTED', targetId: id },
      orderBy: { timestamp: 'desc' },
    });
    expect(audit).not.toBeNull();
    // The outcome, not just the fact of a test: "test-fired" alone is not evidence.
    expect((audit!.afterValue as { ok: boolean }).ok).toBe(true);
  });

  it('returns the delivery log newest first', async () => {
    const id = (await newTarget()).json().id;
    await app.inject({ method: 'POST', url: `/api/alarm-webhooks/${id}/test`, headers: headers() });

    const res = await app.inject({ method: 'GET', url: `/api/alarm-webhooks/${id}/deliveries`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);
    const row = res.json().data[0];
    for (const key of [
      'id', 'targetId', 'alarmId', 'event', 'url', 'requestBody', 'httpStatus',
      'responseSnippet', 'attempt', 'status', 'error', 'createdAt', 'sentAt',
    ]) {
      expect(row, `missing "${key}" — check the response schema`).toHaveProperty(key);
    }
    expect(row.event).toBe('TEST');
    expect(row.alarmId).toBeNull();
    expect(row.httpStatus).toBe(200);
    // Stored verbatim: re-rendering it later from a since-edited template would be
    // a fabrication.
    expect(row.requestBody).toContain('"event":"TEST"');
  });

  it('filters the delivery log by status, narrowing the rows AND the total', async () => {
    const id = (await newTarget()).json().id;
    await app.inject({ method: 'POST', url: `/api/alarm-webhooks/${id}/test`, headers: headers() });

    const sent = await app.inject({ method: 'GET', url: `/api/alarm-webhooks/${id}/deliveries?status=SENT`, headers: auth });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().total).toBe(1);
    expect(sent.json().data).toHaveLength(1);
    expect(sent.json().data[0].status).toBe('SENT');

    // The total MUST move with the rows. A filtered page against an unfiltered total
    // is what drives a pager past the end of the filtered set.
    const failed = await app.inject({ method: 'GET', url: `/api/alarm-webhooks/${id}/deliveries?status=FAILED`, headers: auth });
    expect(failed.statusCode).toBe(200);
    expect(failed.json().total).toBe(0);
    expect(failed.json().data).toHaveLength(0);

    // An unknown status is refused by the schema rather than silently matching nothing,
    // which would be indistinguishable from "this target has never failed".
    const bogus = await app.inject({ method: 'GET', url: `/api/alarm-webhooks/${id}/deliveries?status=NOPE`, headers: auth });
    expect(bogus.statusCode).toBe(400);
  });

  it('refuses to delete a target that has delivery records, and says how many', async () => {
    const id = (await newTarget()).json().id;
    await app.inject({ method: 'POST', url: `/api/alarm-webhooks/${id}/test`, headers: headers() });

    const res = await app.inject({
      method: 'DELETE', url: `/api/alarm-webhooks/${id}`, headers: headers(), payload: { reason: 'no longer needed' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('TARGET_HAS_DELIVERIES');
    expect(res.json().message).toContain('1 delivery record');
    expect(res.json().message).toContain('Deactivate');
    expect(await prisma.alarmWebhookTarget.findUnique({ where: { id } })).not.toBeNull();
  });
});
