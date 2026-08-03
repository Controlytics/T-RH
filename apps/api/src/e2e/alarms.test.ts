import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type FastifyInstance } from 'fastify';
import { hashPassword } from '../lib/password.js';

/**
 * Task 12 — alarm REST surface, including the 21 CFR §11.50 electronic
 * signature on acknowledgement.
 *
 * Provisions its own SUPER_ADMIN (`alarm_admin`) rather than the shared `admin`
 * fixture — see apps/api/CLAUDE.md's "per-file authoring tip".
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DISPATCHER = path.resolve(__dirname, '../modules/notification-delivery/notification-dispatcher.ts');
const RULES = path.resolve(__dirname, '../modules/notification-rules/routes.ts');

/**
 * The variable keys the CONSUMERS expect for ALARM_ACKNOWLEDGED, read out of
 * their source rather than restated here. Same approach as the ALARM_RAISED
 * binding test in modules/alarms/__tests__/alarm.service.test.ts — a
 * hand-copied list would drift in exactly the way this exists to prevent.
 */
function dispatcherKeys(): string[] {
  const src = readFileSync(DISPATCHER, 'utf8');
  // Match only the EVENT_FIELDS entry — the array-of-pairs form.
  // `ALARM_ACKNOWLEDGED:` also appears in EVENT_LABELS and the template maps.
  const line = /^\s*ALARM_ACKNOWLEDGED:\s*\[\[.*$/m.exec(src)?.[0] ?? '';
  return [...line.matchAll(/\['[^']*','([^']*)'\]/g)].map(m => m[1]);
}

function rulesKeys(): string[] {
  const src = readFileSync(RULES, 'utf8');
  const line = /^\s*ALARM_ACKNOWLEDGED:\s*\{.*$/m.exec(src)?.[0] ?? '';
  const arr = /variables:\s*\[([^\]]*)\]/.exec(line)?.[1] ?? '';
  return [...arr.matchAll(/'([^']+)'/g)].map(m => m[1]);
}

// Hoisted so the vi.mock factory below (which is hoisted above imports) can
// close over it.
const dispatch = vi.hoisted(() => vi.fn(async () => {}));

// Spread the REAL module so any other export keeps working — only the dispatch
// entry point is captured, so the ack's notification variables can be asserted
// without standing up SMTP.
vi.mock('../modules/notification-delivery/notification-dispatcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../modules/notification-delivery/notification-dispatcher.js')>();
  return { ...actual, dispatchNotification: dispatch };
});

const { buildApp, loginAs } = await import('./test-helper.js');
const { prisma } = await import('../lib/prisma.js');
const { isReauthRequired } = await import('../lib/reauth-check.js');

const ADMIN_USERNAME = 'alarm_admin';
const ADMIN_PASSWORD = 'AlarmAdmin@Test1';
const VIEWER_USERNAME = 'alarm_viewer';
const VIEWER_PASSWORD = 'AlarmViewer@Test1';

let app: FastifyInstance;
let token: string;
let instrumentId: string;
let thresholdId: string;

const runSuffix = Date.now();
const auth = () => ({ authorization: `Bearer ${token}` });

/** A fresh ACTIVE alarm on the fixture threshold. */
async function seedAlarm(key: string) {
  const now = new Date();
  return prisma.alarm.create({
    data: {
      instrumentId, key, thresholdId, severity: 'MAJOR', state: 'ACTIVE',
      firstBreachAt: now, lastBreachAt: now, breachCount: 3,
      triggerValue: 105, peakValue: 118,
    },
  });
}

beforeAll(async () => {
  app = await buildApp();

  const adminHash = await hashPassword(ADMIN_PASSWORD);
  await prisma.user.upsert({
    where: { username: ADMIN_USERNAME },
    update: {
      passwordHash: adminHash, fullName: 'Alarm Test Admin', role: 'SUPER_ADMIN',
      status: 'ENABLED', forcePasswordChange: false, isTemporaryPassword: false,
      failedLoginAttempts: 0, lockedAt: null, lockoutUntil: null,
    },
    create: {
      username: ADMIN_USERNAME, passwordHash: adminHash, fullName: 'Alarm Test Admin',
      email: 'alarm-test-admin@example.test', role: 'SUPER_ADMIN', status: 'ENABLED',
      forcePasswordChange: false, isTemporaryPassword: false,
    },
  });
  token = await loginAs(app, ADMIN_USERNAME, ADMIN_PASSWORD);

  const co = await app.inject({
    method: 'POST', url: '/api/hierarchy', headers: auth(),
    payload: { parentId: null, level: 'COMPANY', name: `AlarmCo${runSuffix}` },
  });
  expect(co.statusCode).toBe(200);
  const area = await app.inject({
    method: 'POST', url: '/api/hierarchy', headers: auth(),
    payload: { parentId: co.json().id, level: 'AREA', name: `AlarmArea-${runSuffix}` },
  });
  expect(area.statusCode).toBe(200);

  const profile = await app.inject({
    method: 'POST', url: '/api/communication-profiles', headers: auth(),
    payload: { name: `Alarm MQTT ${runSuffix}`, protocolKey: 'mqtt', config: { brokerUrl: 'mqtt://b:1883' } },
  });
  expect(profile.statusCode).toBe(200);

  // No gateway, so the instrument MUST carry its own communication profile —
  // the instruments_reachable_chk CHECK constraint rejects the row otherwise.
  const inst = await app.inject({
    method: 'POST', url: '/api/instruments', headers: auth(),
    payload: {
      name: `Chamber ${runSuffix}`, code: `ALM-${runSuffix}`, instrumentType: 'temperature-sensor',
      hierarchyNodeId: area.json().id, communicationProfileId: profile.json().id,
    },
  });
  expect(inst.statusCode).toBe(200);
  instrumentId = inst.json().id;

  const th = await app.inject({
    method: 'POST', url: '/api/alarm-thresholds', headers: auth(),
    payload: { instrumentId, key: 'temp', operator: 'GT', limit: 100, hysteresis: 2, severity: 'MAJOR' },
  });
  expect(th.statusCode).toBe(200);
  thresholdId = th.json().id;
});

afterAll(async () => {
  // alarms.threshold_id and alarms.instrument_id are both onDelete: Restrict —
  // the alarms have to go first or every delete below raises an FK violation.
  await prisma.alarm.deleteMany({ where: { instrumentId } });
  await prisma.alarmThreshold.deleteMany({ where: { instrumentId } });
  await prisma.instrument.deleteMany({ where: { id: instrumentId } });
  await app.close();
});

describe('alarm queue', () => {
  it('lists alarms and filters by state', async () => {
    const active = await seedAlarm(`list-active-${runSuffix}`);
    await prisma.alarm.update({
      where: { id: (await seedAlarm(`list-closed-${runSuffix}`)).id },
      data: { state: 'CLOSED', closedAt: new Date() },
    });

    const all = await app.inject({ method: 'GET', url: '/api/alarms', headers: auth() });
    expect(all.statusCode).toBe(200);
    expect(Array.isArray(all.json())).toBe(true);

    const filtered = await app.inject({ method: 'GET', url: '/api/alarms?state=ACTIVE', headers: auth() });
    expect(filtered.statusCode).toBe(200);
    const rows = filtered.json() as { id: string; state: string }[];
    expect(rows.every(r => r.state === 'ACTIVE')).toBe(true);
    expect(rows.map(r => r.id)).toContain(active.id);
  });

  it('returns one alarm with its instrument, and 404s on an unknown id', async () => {
    const alarm = await seedAlarm(`one-${runSuffix}`);
    const res = await app.inject({ method: 'GET', url: `/api/alarms/${alarm.id}`, headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json().instrument.id).toBe(instrumentId);

    const missing = await app.inject({ method: 'GET', url: '/api/alarms/no-such-alarm', headers: auth() });
    expect(missing.statusCode).toBe(404);
  });

  it('requires ALARM_VIEW — a token without it gets 403', async () => {
    const viewerHash = await hashPassword(VIEWER_PASSWORD);
    await prisma.user.upsert({
      where: { username: VIEWER_USERNAME },
      update: {
        passwordHash: viewerHash, fullName: 'Alarm Test Viewer', role: 'VIEWER',
        status: 'ENABLED', forcePasswordChange: false, isTemporaryPassword: false,
        failedLoginAttempts: 0, lockedAt: null, lockoutUntil: null,
      },
      create: {
        username: VIEWER_USERNAME, passwordHash: viewerHash, fullName: 'Alarm Test Viewer',
        email: 'alarm-test-viewer@example.test', role: 'VIEWER', status: 'ENABLED',
        forcePasswordChange: false, isTemporaryPassword: false,
      },
    });
    const viewerToken = await loginAs(app, VIEWER_USERNAME, VIEWER_PASSWORD);
    const res = await app.inject({
      method: 'GET', url: '/api/alarms', headers: { authorization: `Bearer ${viewerToken}` },
    });
    expect(res.statusCode).toBe(403);

    // The admin token was invalidated by nothing here, but loginAs terminates
    // sessions per user — re-login so later tests keep a live session.
    token = await loginAs(app, ADMIN_USERNAME, ADMIN_PASSWORD);
  });

  it('lists an instrument\'s thresholds', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/instruments/${instrumentId}/thresholds`, headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { id: string }[]).map(t => t.id)).toContain(thresholdId);
  });
});

describe('acknowledgement — the §11.50 electronic signature', () => {
  it('demands a password even when action-reauth has no policy for the role', async () => {
    // enforceReauthAlways, not enforceReauth. If this ever returns 200 the
    // signature has become disableable through the admin-managed config, which
    // is precisely what §11.50 forbids. A valid `reason` is supplied so the
    // body schema passes — otherwise this would 400 before reaching the gate.
    //
    // Proved directly rather than inferred: with NO policy configured for this
    // action, `enforceReauth` would wave the request straight through, so the
    // 401 below can only come from the always-on path. Without this line the
    // test would still pass if someone later configured ACKNOWLEDGE_ALARM in
    // the test DB — and would no longer discriminate the two functions.
    expect(await isReauthRequired('ACKNOWLEDGE_ALARM', 'SUPER_ADMIN')).toBe(false);

    const alarm = await seedAlarm(`noauth-${runSuffix}`);
    const res = await app.inject({
      method: 'POST', url: `/api/alarms/${alarm.id}/acknowledge`, headers: auth(),
      payload: { reason: 'Reviewed and dispositioned.' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('REAUTH_REQUIRED');

    const unchanged = await prisma.alarm.findUnique({ where: { id: alarm.id } });
    expect(unchanged!.state).toBe('ACTIVE');
    expect(unchanged!.ackedBy).toBeNull();
  });

  it('rejects a missing reason', async () => {
    const alarm = await seedAlarm(`noreason-${runSuffix}`);
    const res = await app.inject({
      method: 'POST', url: `/api/alarms/${alarm.id}/acknowledge`, headers: auth(),
      payload: { _currentPassword: ADMIN_PASSWORD },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a whitespace-only reason that the minLength schema lets through', async () => {
    // `minLength: 1` is satisfied by spaces. The reason IS the signed meaning
    // of the record, so a blank one must not be storable.
    // (stripHtml ESCAPES markup rather than removing it — see sanitize.ts's
    // `recursiveEscape` mode — so '<b></b>' is deliberately not tested here;
    // it survives as visible text, which is the project-wide behaviour.)
    const alarm = await seedAlarm(`blankreason-${runSuffix}`);
    const res = await app.inject({
      method: 'POST', url: `/api/alarms/${alarm.id}/acknowledge`, headers: auth(),
      payload: { reason: '    ', _currentPassword: ADMIN_PASSWORD },
    });
    expect(res.statusCode).toBe(400);
    expect((await prisma.alarm.findUnique({ where: { id: alarm.id } }))!.state).toBe('ACTIVE');
  });

  it('rejects a wrong password', async () => {
    const alarm = await seedAlarm(`badpwd-${runSuffix}`);
    const res = await app.inject({
      method: 'POST', url: `/api/alarms/${alarm.id}/acknowledge`, headers: auth(),
      payload: { reason: 'Reviewed.', _currentPassword: 'NotThePassword@9' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('REAUTH_FAILED');
  });

  it('acknowledges, writes an attributable audit row, and dispatches every variable its consumers render', async () => {
    const alarm = await seedAlarm(`ack-${runSuffix}`);
    dispatch.mockClear();

    const res = await app.inject({
      method: 'POST', url: `/api/alarms/${alarm.id}/acknowledge`, headers: auth(),
      payload: { reason: 'Excursion reviewed — filter changed, product unaffected.', _currentPassword: ADMIN_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe('ACTIVE_ACKED');
    expect(res.json().ackedBy).toBe(ADMIN_USERNAME);

    const stored = await prisma.alarm.findUnique({ where: { id: alarm.id } });
    expect(stored!.ackedAt).not.toBeNull();
    // ACTIVE_ACKED is not closed — the excursion has not recovered yet.
    expect(stored!.closedAt).toBeNull();

    const audit = await prisma.auditTrail.findFirst({
      where: { action: 'ALARM_ACKNOWLEDGED', targetId: alarm.id },
    });
    expect(audit).not.toBeNull();
    expect(audit!.userId).toBe(ADMIN_USERNAME);
    expect(audit!.reason).toContain('filter changed');
    expect(audit!.signatureMeaning).toBe('Acknowledged alarm');
    // AUDIT_TEMPLATE_DEFAULTS renders `Alarm "{targetName}" acknowledged by
    // {actor}`, and targetName comes off afterValue.name. Without it an
    // inspector sees WHO signed but not WHAT.
    expect((audit!.afterValue as { name?: string }).name).toContain(`Chamber ${runSuffix}`);

    // Producer-to-consumer binding, mirroring the ALARM_RAISED test: the keys
    // are read from the consumers' own source, so the NEXT divergence fails too.
    expect(dispatch).toHaveBeenCalledTimes(1);
    const sent = dispatch.mock.calls[0][0].variables as Record<string, string>;
    const expected = [...new Set([...dispatcherKeys(), ...rulesKeys()])];
    // Guard against a silently vacuous test: if either regex stops matching,
    // `expected` empties and the assertion below passes for free.
    expect(expected).toContain('instrumentName');
    expect(expected.length).toBeGreaterThan(4);
    expect(expected.filter(k => sent[k] === undefined || sent[k] === '')).toEqual([]);
  });

  it('closes an alarm that had already recovered, and refuses to sign it twice', async () => {
    const alarm = await seedAlarm(`resolved-${runSuffix}`);
    await prisma.alarm.update({
      where: { id: alarm.id }, data: { state: 'RESOLVED_UNACKED', resolvedAt: new Date() },
    });

    const first = await app.inject({
      method: 'POST', url: `/api/alarms/${alarm.id}/acknowledge`, headers: auth(),
      payload: { reason: 'Recovered and reviewed.', _currentPassword: ADMIN_PASSWORD },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().state).toBe('CLOSED');
    expect(first.json().closedAt).not.toBeNull();

    // applyAck returns null for CLOSED. That is a rejection, not a no-op — a
    // second acknowledgement would put a second attributable signature on one
    // event, and would overwrite the first signer's name and reason.
    const second = await app.inject({
      method: 'POST', url: `/api/alarms/${alarm.id}/acknowledge`, headers: auth(),
      payload: { reason: 'Signing again.', _currentPassword: ADMIN_PASSWORD },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('ALREADY_ACKNOWLEDGED');

    const after = await prisma.alarm.findUnique({ where: { id: alarm.id } });
    expect(after!.ackReason).toBe('Recovered and reviewed.');
    const rows = await prisma.auditTrail.count({
      where: { action: 'ALARM_ACKNOWLEDGED', targetId: alarm.id },
    });
    expect(rows).toBe(1);
  });
});

describe('threshold CRUD', () => {
  it('rejects OUT_OF_RANGE with limitLow >= limitHigh', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/alarm-thresholds', headers: auth(),
      payload: {
        instrumentId, key: `bad-range-${runSuffix}`, operator: 'OUT_OF_RANGE',
        limitLow: 80, limitHigh: 20, severity: 'MAJOR',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects OUT_OF_RANGE missing a limit', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/alarm-thresholds', headers: auth(),
      payload: {
        instrumentId, key: `half-range-${runSuffix}`, operator: 'OUT_OF_RANGE',
        limitLow: 20, severity: 'MAJOR',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a non-OUT_OF_RANGE operator with no limit', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/alarm-thresholds', headers: auth(),
      payload: { instrumentId, key: `nolimit-${runSuffix}`, operator: 'GT', severity: 'MAJOR' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a hysteresis so wide the alarm could never recover', async () => {
    // The evaluator recovers OUT_OF_RANGE only inside [low+h, high-h]. With
    // 2h >= (high - low) that window is empty and the alarm latches forever,
    // demanding a signed acknowledgement that no reading can ever avoid.
    const res = await app.inject({
      method: 'POST', url: '/api/alarm-thresholds', headers: auth(),
      payload: {
        instrumentId, key: `deadband-${runSuffix}`, operator: 'OUT_OF_RANGE',
        limitLow: 20, limitHigh: 30, hysteresis: 5, severity: 'MAJOR',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('could never recover');
  });

  it('rejects that same unrecoverable configuration arriving through PUT', async () => {
    // A PUT carrying ONLY hysteresis must be validated against the MERGED row.
    // Checking the patch alone would let the create-side guard be walked
    // around one field at a time.
    const created = await app.inject({
      method: 'POST', url: '/api/alarm-thresholds', headers: auth(),
      payload: {
        instrumentId, key: `put-deadband-${runSuffix}`, operator: 'OUT_OF_RANGE',
        limitLow: 20, limitHigh: 30, hysteresis: 1, severity: 'MAJOR',
      },
    });
    expect(created.statusCode).toBe(200);

    const res = await app.inject({
      method: 'PUT', url: `/api/alarm-thresholds/${created.json().id}`, headers: auth(),
      payload: { hysteresis: 6 },
    });
    expect(res.statusCode).toBe(400);

    const unchanged = await prisma.alarmThreshold.findUnique({ where: { id: created.json().id } });
    expect(unchanged!.hysteresis).toBe(1);
  });

  it('creates, updates and audits a threshold', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/alarm-thresholds', headers: auth(),
      payload: { instrumentId, key: `crud-${runSuffix}`, operator: 'LT', limit: 5, severity: 'MINOR' },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().id;
    expect(await prisma.auditTrail.count({
      where: { action: 'ALARM_THRESHOLD_CREATED', targetId: id },
    })).toBe(1);

    const updated = await app.inject({
      method: 'PUT', url: `/api/alarm-thresholds/${id}`, headers: auth(),
      payload: { limit: 3, severity: 'MAJOR' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().limit).toBe(3);
    expect(updated.json().severity).toBe('MAJOR');
    expect(await prisma.auditTrail.count({
      where: { action: 'ALARM_THRESHOLD_UPDATED', targetId: id },
    })).toBe(1);

    const deleted = await app.inject({
      method: 'DELETE', url: `/api/alarm-thresholds/${id}`, headers: auth(),
    });
    expect(deleted.statusCode).toBe(200);
    expect(await prisma.alarmThreshold.findUnique({ where: { id } })).toBeNull();
    expect(await prisma.auditTrail.count({
      where: { action: 'ALARM_THRESHOLD_DELETED', targetId: id },
    })).toBe(1);
  });

  it('refuses to delete a threshold that has raised alarms, with a readable 400', async () => {
    // alarms.threshold_id is onDelete: Restrict. The alarm rows are the
    // regulated record of the excursion; they must keep pointing at the limit
    // that raised them.
    await seedAlarm(`restrict-${runSuffix}`);
    const res = await app.inject({
      method: 'DELETE', url: `/api/alarm-thresholds/${thresholdId}`, headers: auth(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('isActive');
    expect(await prisma.alarmThreshold.findUnique({ where: { id: thresholdId } })).not.toBeNull();
  });
});

describe('instrument delete with alarm history', () => {
  it('returns a readable 400 rather than a raw P2003 500', async () => {
    // Pre-existing endpoint, newly reachable in this state: alarms.instrument_id
    // is onDelete: Restrict, so an instrument that has ever alarmed cannot be
    // deleted. Before this task the FK violation escaped as a 500.
    await seedAlarm(`instdel-${runSuffix}`);
    const res = await app.inject({
      method: 'DELETE', url: `/api/instruments/${instrumentId}`, headers: auth(),
    });
    expect(res.statusCode).toBe(400);
    expect(await prisma.instrument.findUnique({ where: { id: instrumentId } })).not.toBeNull();
  });
});
