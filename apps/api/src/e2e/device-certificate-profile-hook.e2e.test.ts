import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs, ADMIN_PASSWORD } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { invalidateRolePermsCache } from '../plugins/rbac.js';
import { generateToken, hashToken, tokenPrefix } from '../modules/instruments/token.js';
import { invalidateIngestAuthCache } from '../modules/instruments/ingest-auth.js';
import { invalidateChildMapCache } from '../modules/instruments/gateway-children.js';
import { resetCertificateRefusalLimiter } from '../modules/instruments/device-certificate.js';
import { createDeviceCaFiles, resetDeviceCaCache } from '../modules/instruments/device-ca.js';

/**
 * Device certificates (2026-10-27): the PROFILE switch (super admin, reason,
 * refused while no device CA is configured) and the EMQX hook, which judges
 * MQTT at CONNECT from the `cert_subject` EMQX forwards ("" = no certificate,
 * as measured on 5.3.2; plain 1883 always sends "").
 */
const ENV_KEYS = ['DEVICE_CA_CERT_PATH', 'DEVICE_CA_KEY_PATH', 'MQTT_USERNAME', 'MQTT_PASSWORD'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const S = Date.now();
const ISSUE_A = 'a1'.repeat(16);
const ISSUE_G = 'b2'.repeat(16);
let app: FastifyInstance;
let admin: Record<string, string>;
let dir: string;
let switchProfileId: string;
let freeProfileId: string;
let requiredProfileId: string;
const instrumentIds: string[] = [];
const inst: Record<string, { id: string; code: string; token: string }> = {};
let operatorRoleId = '';
let operatorPermsBefore: string[] = [];

async function mk(key: string, profileId: string, extra: Record<string, unknown> = {}) {
  const code = `DCH-${key}-${S}`;
  const row = await prisma.instrument.create({ data: { name: code, code, profileId, ...extra } });
  instrumentIds.push(row.id);
  const token = generateToken();
  await prisma.instrumentCredential.create({ data: { instrumentId: row.id, tokenHash: hashToken(token), tokenPrefix: tokenPrefix(token) } });
  inst[key] = { id: row.id, code, token };
}

const subject = (issueId: string) => `CN=whatever,SERIALNUMBER=${issueId},O=DigiLog Device`;
const ask = (key: string, certSubject: string) => app.inject({
  method: 'POST', url: '/api/ingest/v1/mqtt-auth',
  payload: { clientid: inst[key].code, username: inst[key].token, password: '', cert_subject: certSubject, cert_common_name: '' },
});
const putProfile = (id: string, payload: Record<string, unknown>, headers = admin) => app.inject({
  method: 'PUT', url: `/api/instrument-profiles/${id}`, headers: { ...headers, 'x-reauth-password': ADMIN_PASSWORD }, payload,
});
const refusals = (instrumentId: string) => prisma.deadLetter.count({ where: { instrumentId, transport: 'mqtt', reason: { contains: 'device certificate' } } });

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devcert-hook-'));
  await createDeviceCaFiles(path.join(dir, 'device-ca.pem'), path.join(dir, 'device-ca.key'));
  process.env.DEVICE_CA_CERT_PATH = path.join(dir, 'device-ca.pem');
  process.env.DEVICE_CA_KEY_PATH = path.join(dir, 'device-ca.key');
  process.env.MQTT_USERNAME = `bridge-${S}`;
  process.env.MQTT_PASSWORD = 'bridge-secret';
  resetDeviceCaCache();

  app = await buildApp();
  admin = { authorization: `Bearer ${await loginAs(app)}` };
  switchProfileId = (await prisma.instrumentProfile.create({ data: { name: `fixture:dch-switch-${S}` } })).id;
  freeProfileId = (await prisma.instrumentProfile.create({ data: { name: `fixture:dch-free-${S}` } })).id;
  requiredProfileId = (await prisma.instrumentProfile.create({ data: { name: `fixture:dch-required-${S}`, requireDeviceCertificate: true } })).id;
  await mk('A', switchProfileId, { deviceCertIssueId: ISSUE_A });
  await mk('NOCERT', switchProfileId);
  await mk('GW', freeProfileId, { isGateway: true, deviceCertIssueId: ISSUE_G });
  await mk('KID', requiredProfileId, { gatewayId: inst.GW.id });
  // A gateway with no certificate, reporting for an instrument of the switch profile.
  await mk('GW2', freeProfileId, { isGateway: true });
  await mk('B', switchProfileId, { gatewayId: inst.GW2.id });
  // A gateway whose only requiring child is DEACTIVATED.
  await mk('GW3', freeProfileId, { isGateway: true });
  await mk('KIDOFF', requiredProfileId, { gatewayId: inst.GW3.id, isActive: false });

  const role = await prisma.role.findFirstOrThrow({ where: { name: 'OPERATOR' } });
  operatorRoleId = role.id;
  operatorPermsBefore = role.permissions as string[];
  await prisma.role.update({ where: { id: role.id }, data: { permissions: [...new Set([...operatorPermsBefore, 'INSTRUMENT_READ', 'INSTRUMENT_UPDATE'])] } });
  invalidateRolePermsCache('OPERATOR');
}, 60_000);

afterAll(async () => {
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  resetDeviceCaCache();
  if (operatorRoleId) await prisma.role.update({ where: { id: operatorRoleId }, data: { permissions: operatorPermsBefore as never } }).catch(() => {});
  invalidateRolePermsCache('OPERATOR');
  await prisma.deadLetter.deleteMany({ where: { instrumentId: { in: instrumentIds } } }).catch(() => {});
  await prisma.instrumentCredential.deleteMany({ where: { instrumentId: { in: instrumentIds } } }).catch(() => {});
  await prisma.instrument.updateMany({ where: { id: { in: instrumentIds } }, data: { gatewayId: null } }).catch(() => {});
  await prisma.instrument.deleteMany({ where: { id: { in: instrumentIds } } }).catch(() => {});
  await prisma.instrumentProfile.deleteMany({ where: { id: { in: [switchProfileId, freeProfileId, requiredProfileId].filter(Boolean) } } }).catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
  await app?.close();
});

beforeEach(() => {
  invalidateIngestAuthCache();
  invalidateChildMapCache();
  resetCertificateRefusalLimiter();
});

describe('profile switch: Require device certificate', () => {
  it('profiles carry the flag, OFF by default', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/instrument-profiles/${switchProfileId}`, headers: admin });
    expect(res.statusCode).toBe(200);
    expect(res.json().requireDeviceCertificate).toBe(false);
  });

  it('only a super admin may change it', async () => {
    const operator = { authorization: `Bearer ${await loginAs(app, 'RB0001', 'Test@1234')}` };
    const res = await app.inject({
      method: 'PUT', url: `/api/instrument-profiles/${switchProfileId}`,
      headers: { ...operator, 'x-reauth-password': 'Test@1234' },
      payload: { requireDeviceCertificate: true, reason: 'client requirement' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('SUPER_ADMIN_ONLY');
    admin = { authorization: `Bearer ${await loginAs(app)}` };
  });

  it('needs a reason', async () => {
    const res = await putProfile(switchProfileId, { requireDeviceCertificate: true });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('REASON_REQUIRED');
  });

  it('cannot be turned ON while the server has no device CA', async () => {
    const certPath = process.env.DEVICE_CA_CERT_PATH;
    delete process.env.DEVICE_CA_CERT_PATH;
    try {
      const res = await putProfile(switchProfileId, { requireDeviceCertificate: true, reason: 'client requirement' });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('DEVICE_CA_NOT_CONFIGURED');
    } finally {
      process.env.DEVICE_CA_CERT_PATH = certPath;
    }
  });

  it('ON: saved, audited before/after with the reason, and says how many instruments have no certificate', async () => {
    const res = await putProfile(switchProfileId, { requireDeviceCertificate: true, reason: 'client requirement' });
    expect(res.statusCode).toBe(200);
    expect(res.json().requireDeviceCertificate).toBe(true);
    expect(res.json().instrumentsWithoutCertificate).toBe(2);
    // The blast radius the switch cannot show by counting its own instruments:
    // a gateway reporting for one of them must now present its own certificate.
    expect(res.json().gatewaysNeedingCertificate).toEqual([{ code: inst.GW2.code, certificateIssued: false }]);
    const audit = await prisma.auditTrail.findFirst({
      where: { action: 'INSTRUMENT_PROFILE_UPDATED', targetId: switchProfileId }, orderBy: { timestamp: 'desc' },
    });
    expect(audit?.beforeValue).toMatchObject({ requireDeviceCertificate: false });
    expect(audit?.afterValue).toMatchObject({ requireDeviceCertificate: true });
    expect(audit?.reason).toBe('client requirement');
    expect(audit?.signatureMeaning).toMatch(/device certificate/i);
  });

  it('sending the stored value again is a no-op that needs no reason', async () => {
    const res = await putProfile(switchProfileId, { requireDeviceCertificate: true });
    expect(res.statusCode).toBe(200);
  });

  it('OFF needs a reason too, and is never refused for a missing device CA', async () => {
    expect((await putProfile(switchProfileId, { requireDeviceCertificate: false })).statusCode).toBe(400);
    const certPath = process.env.DEVICE_CA_CERT_PATH;
    delete process.env.DEVICE_CA_CERT_PATH;
    try {
      const res = await putProfile(switchProfileId, { requireDeviceCertificate: false, reason: 'test over' });
      expect(res.statusCode).toBe(200);
      expect(res.json().requireDeviceCertificate).toBe(false);
    } finally {
      process.env.DEVICE_CA_CERT_PATH = certPath;
    }
  });
});

describe('EMQX hook judges the certificate at CONNECT', () => {
  it('profile OFF: no certificate is fine (nothing changes when nothing is switched on)', async () => {
    await prisma.instrumentProfile.update({ where: { id: switchProfileId }, data: { requireDeviceCertificate: false } });
    expect((await ask('A', '')).json()).toEqual({ result: 'allow' });
  });

  describe('profile ON', () => {
    beforeAll(async () => {
      await prisma.instrumentProfile.update({ where: { id: switchProfileId }, data: { requireDeviceCertificate: true } });
    });

    it('no certificate (plain 1883, or mqtts without one) → deny, and one dead letter', async () => {
      const before = await refusals(inst.A.id);
      expect((await ask('A', '')).json()).toEqual({ result: 'deny' });
      expect((await ask('A', '')).json()).toEqual({ result: 'deny' });
      expect(await refusals(inst.A.id)).toBe(before + 1);
    });

    it('its current certificate → allow', async () => {
      expect((await ask('A', subject(ISSUE_A))).json()).toEqual({ result: 'allow' });
    });

    it('an older (re-issued) certificate → deny', async () => {
      expect((await ask('A', subject('c3'.repeat(16)))).json()).toEqual({ result: 'deny' });
    });

    it('an instrument with no certificate issued → deny, whatever it presents', async () => {
      expect((await ask('NOCERT', subject(ISSUE_A))).json()).toEqual({ result: 'deny' });
    });
  });

  it('the ingest bridge is never asked for a certificate', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/ingest/v1/mqtt-auth',
      payload: { clientid: 'digilog-ingest-bridge', username: `bridge-${S}`, password: 'bridge-secret', cert_subject: '' },
    });
    expect(res.json()).toEqual({ result: 'allow' });
  });

  it('a gateway with a child that requires a certificate must present its OWN current one', async () => {
    expect((await ask('GW', '')).json()).toEqual({ result: 'deny' });
    expect((await ask('GW', subject(ISSUE_G))).json()).toEqual({ result: 'allow' });
  });

  it("a gateway's refusal says WHY: it reports for an instrument that requires one", async () => {
    await ask('GW', '');
    const dl = await prisma.deadLetter.findFirst({
      where: { instrumentId: inst.GW.id, transport: 'mqtt' }, orderBy: { receivedAt: 'desc' },
    });
    expect(dl?.reason).toMatch(/gateway reports for an instrument whose profile requires a device certificate/);
  });

  it('a DEACTIVATED requiring child does not cut its gateway off', async () => {
    expect((await ask('GW3', '')).json()).toEqual({ result: 'allow' });
  });
});
