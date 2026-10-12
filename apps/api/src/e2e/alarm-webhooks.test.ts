import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { invalidateReauthCache } from '../lib/reauth-check.js';
import { fixtureProfileId } from '../test-support/fixture-profile.js';
import { Prisma } from '@prisma/client';
import { invalidateRolePermsCache } from '../plugins/rbac.js';
import { allowLoopbackForTests } from '../lib/outbound-guard.js';
import { SECRET_MASK } from '../lib/mask-secrets.js';

/**
 * HTTP-level coverage of the alarm-webhook target module.
 *
 * Asserted over `app.inject` throughout, never off a function's return value: the
 * only thing that catches a field missing from the Fastify `response` schema is a
 * field missing from the JSON on the wire.
 *
 * The test fire points at a real `node:http` server on 127.0.0.1 rather than an
 * unroutable address — an unreachable URL would test the transport, and the route's
 * own `timeoutMs`, instead of the route. (`POST /:id/test` sends ONE attempt as of
 * 2026-08-27 and writes one row; the three-attempt retry belongs to the annunciation
 * path in the worker, and is covered there.)
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

  // The hooter below listens on 127.0.0.1, which the outbound guard refuses in
  // production (audit 2026-10-12 #1). The SSRF tests at the end switch it back off.
  allowLoopbackForTests(true);
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
  allowLoopbackForTests(false);
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
      'cooldownSeconds', 'isActive', 'scopeLocationIds', 'scopeInstrumentIds',
      'instrumentCount', 'lastDeliveryStatus', 'lastDeliveryAt', 'createdAt', 'updatedAt',
    ]) {
      expect(body, `missing "${key}" — check the response schema`).toHaveProperty(key);
    }
    expect(body.method).toBe('POST');
    expect(body.bodyTemplate).toContain('${event}');
    // `severities` is deliberately NOT here: the column survives (§11 — see
    // target-scope.ts) but stopped being served on 2026-09-01 with the severity
    // concept. Asserted as an absence so it cannot drift back onto the wire.
    expect(body).not.toHaveProperty('severities');
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
    // exists for. stripHtml reduces this to '${event}${metric}' — still DAMAGED,
    // which is what this fixture has to be to prove anything.
    // (It named ${severity} until 2026-09-01. That is no longer a known variable,
    //  so the draft validator refused it and this test failed with a 400 — which
    //  is the unknown-variable rule working, not the exemption breaking.)
    const tpl = '<alarm><event>${event}</event><metric>${metric}</metric></alarm>';
    const res = await newTarget({ bodyTemplate: tpl, contentType: 'application/xml' });
    expect(res.statusCode).toBe(201);
    expect(res.json().bodyTemplate).toBe(tpl);
    expect(res.json().contentType).toBe('application/xml');
  });

  it('does not sanitise a tag-shaped url path — `url` is exempt', async () => {
    // stripHtml turns this into 'http://192.168.1.60:9/trigger', a DIFFERENT hooter.
    // (A LAN literal, not loopback: saving never contacts it, and loopback is now
    // refused outright — audit 2026-10-12 #1.)
    const url = 'http://192.168.1.60:9/<alarm>/trigger';
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

  it('keeps stored headers and successRegex through a PUT that changes only the url', async () => {
    // REWRITTEN 2026-09-01, not deleted. This used to pin the guard on
    // `severities: []`; that field is no longer served, but the GUARD it was
    // protecting is generic and still load-bearing — a partial update must not
    // overwrite a field it does not mention, because the draft for an update is
    // built from the CURRENT row and one `?? default` in the wrong place silently
    // rewrites stored configuration.
    //
    // Moved onto two fields where the damage would be real and invisible: an auth
    // header silently dropped makes every delivery 401 against a hooter that looks
    // configured, and a success regex silently dropped makes every delivery judged
    // by status code alone — so a device answering 200 with an error body reads as
    // annunciated when it was not.
    const authHeader = { Authorization: 'Bearer hooter-token' };
    const regex = '^OK$';
    // Header VALUES are masked on every response since audit 2026-10-12 #6; the
    // name survives so the page can show which header is set.
    const masked = { Authorization: SECRET_MASK };
    const created = await newTarget({ headers: authHeader, successRegex: regex });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect(created.json().headers).toEqual(masked);
    expect(created.json().successRegex).toBe(regex);

    const newUrl = `${hooterUrl}?moved=1`;
    const put = await app.inject({
      method: 'PUT', url: `/api/alarm-webhooks/${id}`, headers: headers(), payload: { url: newUrl },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().url).toBe(newUrl);
    expect(put.json().headers).toEqual(masked);
    expect(put.json().successRegex).toBe(regex);

    // Asserted on the stored row too: a correct response over a wrong column would pass
    // the check above and still be a silent data change.
    const stored = await prisma.alarmWebhookTarget.findUnique({ where: { id } });
    expect(stored!.headers).toEqual(authHeader);
    expect(stored!.successRegex).toBe(regex);

    const fetched = await app.inject({ method: 'GET', url: `/api/alarm-webhooks/${id}`, headers: auth });
    expect(fetched.json().headers).toEqual(masked);
    expect(fetched.json().successRegex).toBe(regex);
  });

  /**
   * Audit 2026-10-12 #6 — header VALUES (bearer tokens, API keys) were returned in
   * plain text to every ALARM_RULE_READ holder. Masked now; the page round-trips the
   * mask, which means "keep the stored value".
   */
  it('masks header values on the list and the item, and a masked value on PUT keeps the stored one', async () => {
    const created = await newTarget({ headers: { Authorization: 'Bearer real-secret', 'X-Site': 'QC-3' } });
    const id = created.json().id;

    const list = await app.inject({ method: 'GET', url: '/api/alarm-webhooks', headers: auth });
    const row = (list.json().data as { id: string; headers: Record<string, string> }[]).find((t) => t.id === id)!;
    expect(row.headers).toEqual({ Authorization: SECRET_MASK, 'X-Site': SECRET_MASK });
    expect(JSON.stringify(list.json())).not.toContain('real-secret');

    // The page sends back what it was given, plus one changed value and one new header.
    const put = await app.inject({
      method: 'PUT', url: `/api/alarm-webhooks/${id}`, headers: headers(),
      payload: { headers: { Authorization: SECRET_MASK, 'X-Site': 'QC-4', 'X-New': 'n' } },
    });
    expect(put.statusCode).toBe(200);
    const stored = await prisma.alarmWebhookTarget.findUnique({ where: { id } });
    expect(stored!.headers).toEqual({ Authorization: 'Bearer real-secret', 'X-Site': 'QC-4', 'X-New': 'n' });

    // A header OMITTED from the map is removed — that is how the page deletes one.
    const drop = await app.inject({
      method: 'PUT', url: `/api/alarm-webhooks/${id}`, headers: headers(),
      payload: { headers: { Authorization: SECRET_MASK } },
    });
    expect(drop.statusCode).toBe(200);
    expect((await prisma.alarmWebhookTarget.findUnique({ where: { id } }))!.headers)
      .toEqual({ Authorization: 'Bearer real-secret' });
  });

  /**
   * Audit 2026-10-12 follow-up — a hooter or relay that authenticates by a query
   * token (`?token=…`) had it shown to every ALARM_RULE_READ holder, in the
   * delivery log and in the audit trail. Secret-NAMED query values are masked
   * (device settings like `relay=1` stay readable); a mask on save keeps the
   * stored value.
   */
  it('masks a secret-named URL query value everywhere it is shown, and a round trip keeps it', async () => {
    const secretUrl = `${hooterUrl}?token=URL-SECRET-1&relay=1`;
    const created = await newTarget({ url: secretUrl });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    const shownUrl = `${hooterUrl}?token=${SECRET_MASK}&relay=1`;
    expect(created.json().url).toBe(shownUrl);

    const got = await app.inject({ method: 'GET', url: `/api/alarm-webhooks/${id}`, headers: auth });
    expect(got.json().url).toBe(shownUrl);

    // The screen saves what it was shown: the stored URL is unchanged.
    const put = await app.inject({
      method: 'PUT', url: `/api/alarm-webhooks/${id}`, headers: headers(),
      payload: { url: shownUrl, name: `renamed-${Date.now()}` },
    });
    expect(put.statusCode).toBe(200);
    expect((await prisma.alarmWebhookTarget.findUnique({ where: { id } }))!.url).toBe(secretUrl);

    // The test fire still SENDS the real URL (the hooter checks the token)…
    await app.inject({ method: 'POST', url: `/api/alarm-webhooks/${id}/test`, headers: headers() });
    // …but neither the delivery log nor the audit trail shows it.
    const log = await app.inject({ method: 'GET', url: `/api/alarm-webhooks/${id}/deliveries`, headers: auth });
    expect(JSON.stringify(log.json())).not.toContain('URL-SECRET-1');
    const audits = await prisma.auditTrail.findMany({ where: { targetId: id } });
    for (const a of audits) {
      expect(JSON.stringify([a.beforeValue, a.afterValue, a.signatureMeaning])).not.toContain('URL-SECRET-1');
    }
  });

  it('refuses a mask for a header name that has no stored value', async () => {
    const id = (await newTarget({ headers: { Authorization: 'Bearer x' } })).json().id;
    const res = await app.inject({
      method: 'PUT', url: `/api/alarm-webhooks/${id}`, headers: headers(),
      payload: { headers: { 'X-Renamed': SECRET_MASK } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().field).toBe('headers');
    expect((await prisma.alarmWebhookTarget.findUnique({ where: { id } }))!.headers).toEqual({ Authorization: 'Bearer x' });
  });

  /**
   * Audit 2026-10-12 #7 — the update audit row recorded only name/url/method/
   * isActive, so a change of SCOPE (which instruments sound this hooter) or of a
   * fire flag left no before/after in the §11 trail.
   */
  it('the update audit row carries scope, fire flags and every stored field except header values', async () => {
    const id = (await newTarget({ headers: { Authorization: 'Bearer audit-secret' } })).json().id;
    const res = await app.inject({
      method: 'PUT', url: `/api/alarm-webhooks/${id}`, headers: headers(),
      payload: { scopeInstrumentIds: [], fireOnCleared: false, timeoutMs: 1500 },
    });
    expect(res.statusCode).toBe(200);
    const audit = await prisma.auditTrail.findFirst({
      where: { action: 'ALARM_WEBHOOK_UPDATED', targetId: id },
      orderBy: { timestamp: 'desc' },
    });
    const before = audit!.beforeValue as Record<string, unknown>;
    const after = audit!.afterValue as Record<string, unknown>;
    expect(before.scopeInstrumentIds).toEqual([instrumentId]);
    expect(after.scopeInstrumentIds).toEqual([]);
    expect(before.fireOnCleared).toBe(true);
    expect(after.fireOnCleared).toBe(false);
    expect(before.timeoutMs).toBe(5000);
    expect(after.timeoutMs).toBe(1500);
    for (const k of ['scopeLocationIds', 'fireOnRaised', 'fireOnAcknowledged', 'cooldownSeconds', 'contentType',
      'bodyTemplate', 'successRegex', 'description', 'headerNames']) {
      expect(after, `afterValue missing ${k}`).toHaveProperty(k);
    }
    expect(after.headerNames).toEqual(['Authorization']);
    expect(JSON.stringify([before, after, audit!.signatureMeaning])).not.toContain('audit-secret');
  });

  it('breaks a same-millisecond delivery tie by attempt, agreeing with the delivery log', async () => {
    const id = (await newTarget()).json().id;

    // One timestamp, three attempts — exactly what a retry burst writes. `createdAt` alone
    // cannot order these, so the list row and the log could disagree about which one is
    // "last" unless both fall back to `attempt`.
    const at = new Date();
    await prisma.alarmWebhookDelivery.createMany({
      data: [1, 2, 3].map((attempt) => ({
        targetId: id,
        event: 'RAISED',
        url: hooterUrl,
        requestBody: `{"attempt":${attempt}}`,
        httpStatus: attempt === 3 ? 200 : 500,
        attempt,
        // The LAST attempt succeeded, so a tie-break that picked any other row would
        // report FAILED for a target that is in fact working — the exact misreading the
        // column exists to prevent.
        status: attempt === 3 ? 'SENT' : 'FAILED',
        createdAt: at,
        sentAt: at,
      })),
    });

    const log = await app.inject({ method: 'GET', url: `/api/alarm-webhooks/${id}/deliveries`, headers: auth });
    expect(log.json().total).toBe(3);
    const first = log.json().data[0];
    expect(first.attempt).toBe(3);

    const row = (await app.inject({ method: 'GET', url: '/api/alarm-webhooks', headers: auth }))
      .json().data.find((t: { id: string }) => t.id === id);
    // The two surfaces must name the same delivery, not merely both be plausible.
    expect(row.lastDeliveryStatus).toBe(first.status);
    expect(row.lastDeliveryStatus).toBe('SENT');
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

/**
 * The delivery log IS instrument-visibility scoped, unlike the config routes.
 *
 * `requestBody` is stored verbatim and, under the default template, carries the
 * instrument code and the reading for every excursion — so a role with a restricted
 * `instrument_scope` reading another instrument's delivery rows would leak exactly what
 * project D withholds. `alarm_webhooks.view` is configurable, so that role can hold
 * ALARM_RULE_READ; this is reachable, not hypothetical.
 *
 * Driven through the SEEDED OPERATOR rather than `admin`: SUPER_ADMIN short-circuits
 * `resolveVisibility` to unrestricted, so every assertion here would pass against an
 * unscoped route if it were run as admin. OPERATOR is granted ALARM_RULE_READ *and
 * nothing else* and scoped to a functional location the fixture instrument is not in —
 * an unplaced instrument is invisible to any active scope.
 */
describe('alarm webhook delivery log — instrument visibility', () => {
  let operator: Record<string, string>;
  let scopedTargetId = '';
  let alarmId = '';
  /** An alarm on a SECOND instrument, this one INSIDE the operator's scope. */
  let visibleAlarmId = '';
  let visibleInstrumentId = '';
  let flId = '';
  let rolePermsBefore: string[] = [];
  let roleId = '';

  beforeAll(async () => {
    const fl = await prisma.functionalLocation.create({
      data: { name: `hooter-e2e-fl-${Date.now()}`, type: 'BLOCK' },
    });
    flId = fl.id;

    const role = await prisma.role.findFirstOrThrow({ where: { name: 'OPERATOR' } });
    roleId = role.id;
    rolePermsBefore = role.permissions as string[];
    await prisma.role.update({
      where: { id: roleId },
      data: { permissions: [...rolePermsBefore, 'ALARM_RULE_READ'] },
    });
    invalidateRolePermsCache('OPERATOR');
    await prisma.roleConfig.upsert({
      where: { role: 'OPERATOR' },
      create: { role: 'OPERATOR', instrumentScope: [flId] },
      update: { instrumentScope: [flId] },
    });

    const created = await newTarget();
    expect(created.statusCode).toBe(201);
    scopedTargetId = created.json().id;

    // A real alarm on the fixture instrument, which has NO functional location and is
    // therefore outside the operator's scope.
    const alarm = await prisma.alarm.create({
      data: {
        instrumentId,
        metric: 'TEMPERATURE',
        severity: 'CRITICAL',
        state: 'ACTIVE',
        triggeredValue: 31.5,
        ruleSnapshot: { name: 'visibility fixture' } as never,
      },
    });
    alarmId = alarm.id;

    // Two rows: one that names an instrument, one TEST fire that names none.
    await prisma.alarmWebhookDelivery.createMany({
      data: [
        {
          targetId: scopedTargetId, alarmId, event: 'RAISED', url: hooterUrl,
          requestBody: '{"instrument":"SECRET-CODE","value":31.5}',
          httpStatus: 200, attempt: 1, status: 'SENT', sentAt: new Date(),
        },
        {
          targetId: scopedTargetId, alarmId: null, event: 'TEST', url: hooterUrl,
          requestBody: '{"event":"TEST"}',
          httpStatus: 200, attempt: 1, status: 'SENT', sentAt: new Date(),
        },
      ],
    });

    // A SECOND instrument, placed INSIDE the operator's scope, with its own alarm and
    // delivery row. Without it these tests could not tell correct scoping from a filter
    // that blocks everything with an alarm — delete the `{ alarm: { instrument } }`
    // branch and the TEST-row assertions alone would still pass.
    const vis = await app.inject({
      method: 'POST', url: '/api/instruments', headers: auth,
      payload: {
        name: 'hooter-e2e-visible', code: `HOOK-E2E-VIS-${Date.now()}`,
        profileId: await fixtureProfileId('fixture:alarm-webhooks'),
      },
    });
    expect(vis.statusCode).toBe(201);
    visibleInstrumentId = vis.json().id;
    await prisma.instrument.update({
      where: { id: visibleInstrumentId }, data: { functionalLocationId: flId },
    });
    const visibleAlarm = await prisma.alarm.create({
      data: {
        instrumentId: visibleInstrumentId,
        metric: 'TEMPERATURE',
        severity: 'MAJOR',
        state: 'ACTIVE',
        triggeredValue: 29.1,
        ruleSnapshot: { name: 'visibility fixture (in scope)' } as never,
      },
    });
    visibleAlarmId = visibleAlarm.id;
    await prisma.alarmWebhookDelivery.create({
      data: {
        targetId: scopedTargetId, alarmId: visibleAlarmId, event: 'RAISED', url: hooterUrl,
        requestBody: '{"instrument":"IN-SCOPE-CODE","value":29.1}',
        httpStatus: 200, attempt: 1, status: 'SENT', sentAt: new Date(),
      },
    });

    operator = { authorization: `Bearer ${await loginAs(app, 'RB0001', 'Test@1234')}` };
  });

  afterAll(async () => {
    // Deliveries before the alarm: both FKs are RESTRICT.
    await prisma.alarmWebhookDelivery.deleteMany({ where: { targetId: scopedTargetId } });
    await prisma.alarm.deleteMany({ where: { id: { in: [alarmId, visibleAlarmId].filter(Boolean) } } });
    if (visibleInstrumentId) {
      await app.inject({ method: 'DELETE', url: `/api/instruments/${visibleInstrumentId}`, headers: headers() });
    }
    await prisma.roleConfig.updateMany({
      where: { role: 'OPERATOR' }, data: { instrumentScope: Prisma.DbNull },
    });
    if (roleId) {
      await prisma.role.update({ where: { id: roleId }, data: { permissions: rolePermsBefore as never } });
      invalidateRolePermsCache('OPERATOR');
    }
    if (flId) await prisma.functionalLocation.deleteMany({ where: { id: flId } });
    // The admin token was not invalidated by the operator login, but re-login keeps the
    // rest of the file independent of the order vitest happens to run these in.
    auth = { authorization: `Bearer ${await loginAs(app)}` };
  });

  it('an unrestricted caller sees both rows', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/alarm-webhooks/${scopedTargetId}/deliveries`, headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { event: string }[]; total: number };
    expect(body.total).toBe(3);
    expect(body.data.map((d) => d.event).sort()).toEqual(['RAISED', 'RAISED', 'TEST']);
  });

  it('a scoped role does not see the delivery row for an instrument outside its scope', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/alarm-webhooks/${scopedTargetId}/deliveries`, headers: operator,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { event: string; requestBody: string }[]; total: number };
    // BOTH directions, or this proves nothing: the row for the OUT-OF-SCOPE instrument
    // is gone, the row for the IN-SCOPE one is still there, and the TEST row survives
    // because it names no instrument.
    expect(body.data.map((d) => d.event).sort()).toEqual(['RAISED', 'TEST']);
    // total must agree with the page, or the footer and pager contradict the rows.
    expect(body.total).toBe(2);
    // The whole point: the verbatim body, and the instrument code inside it, is gone.
    expect(body.data.some((d) => d.requestBody.includes('SECRET-CODE'))).toBe(false);
    expect(body.data.some((d) => d.requestBody.includes('IN-SCOPE-CODE'))).toBe(true);
  });

  it('the status filter still narrows the scoped page and its total', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/alarm-webhooks/${scopedTargetId}/deliveries?status=FAILED`, headers: operator,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(0);
  });
});

/**
 * Audit 2026-10-12 #1 — SSRF to the EC2 metadata service. An ALARM_RULE_MANAGE
 * holder could save http://169.254.169.254/… with PUT/GET and any headers, and the
 * test-fire returned 1,000 characters of the answer: an IMDSv2 token, then the
 * instance role's credentials. Refused at save (literal AND resolved name) and at
 * send (for a row stored before the fix, or a name that rebinds).
 */
describe('alarm webhook targets — outbound guard (SSRF)', () => {
  beforeAll(() => allowLoopbackForTests(false));
  afterAll(() => allowLoopbackForTests(true));

  it('refuses to save the metadata service as a target', async () => {
    const res = await newTarget({
      url: 'http://169.254.169.254/latest/api/token', method: 'PUT',
      headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '21600' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().field).toBe('url');
  });

  it('refuses to save a NAME that resolves to loopback', async () => {
    const port = new URL(hooterUrl).port;
    const res = await newTarget({ url: `http://localhost:${port}/alarm` });
    expect(res.statusCode).toBe(400);
    expect(res.json().field).toBe('url');
  });

  it('refuses to move an existing target onto the metadata service', async () => {
    allowLoopbackForTests(true);
    const id = (await newTarget()).json().id;
    allowLoopbackForTests(false);
    const res = await app.inject({
      method: 'PUT', url: `/api/alarm-webhooks/${id}`, headers: headers(),
      payload: { url: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().field).toBe('url');
  });

  it('a target stored before the fix is refused at SEND, and returns nothing', async () => {
    // Written straight to the table: the row an upgraded install may already hold.
    const row = await prisma.alarmWebhookTarget.create({
      data: {
        name: `legacy-imds-${Date.now()}`, url: 'http://169.254.169.254/latest/api/token', method: 'PUT',
        headers: {}, contentType: 'application/json', bodyTemplate: '{"event":"${event}"}',
        timeoutMs: 2000, cooldownSeconds: 0, scopeLocationIds: [], scopeInstrumentIds: [],
      },
    });
    targets.push(row.id);
    const res = await app.inject({ method: 'POST', url: `/api/alarm-webhooks/${row.id}/test`, headers: headers() });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(false);
    expect(res.json().httpStatus).toBeNull();
    expect(res.json().responseSnippet).toBeNull();
    expect(res.json().error).toMatch(/Refused/);
  });
});
