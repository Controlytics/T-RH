import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { X509Certificate } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { buildApp, loginAs, ADMIN_PASSWORD } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { invalidateRolePermsCache } from '../plugins/rbac.js';
import { createDeviceCaFiles, resetDeviceCaCache } from '../modules/instruments/device-ca.js';

/**
 * Issue / re-issue / revoke a device certificate (device certificates,
 * 2026-10-27). Mirrors regenerate-token: INSTRUMENT_UPDATE + an always-on
 * password re-auth, visibility-scoped, audited. The private key leaves once,
 * in the bundle; the instrument keeps only the issue id (the identity every
 * channel compares) and the metadata.
 */
const ENV_KEYS = ['DEVICE_CA_CERT_PATH', 'DEVICE_CA_KEY_PATH', 'TLS_CA_PATH'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const s = Date.now();
let app: FastifyInstance;
let admin: Record<string, string>;
let reauth: Record<string, string>;
let dir: string;
let profileId: string;
let instrumentId: string;
let otherId: string;
let operatorRoleId = '';
let operatorPermsBefore: string[] = [];
let operatorScopeBefore: unknown = null;

const url = () => `/api/instruments/${instrumentId}/device-certificate`;
const auditRows = (action: string) => prisma.auditTrail.findMany({ where: { action, targetId: instrumentId }, orderBy: { timestamp: 'asc' } });

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devcert-e2e-'));
  await createDeviceCaFiles(path.join(dir, 'device-ca.pem'), path.join(dir, 'device-ca.key'));
  fs.writeFileSync(path.join(dir, 'server-ca.pem'), 'SERVER-CA');
  process.env.DEVICE_CA_CERT_PATH = path.join(dir, 'device-ca.pem');
  process.env.DEVICE_CA_KEY_PATH = path.join(dir, 'device-ca.key');
  process.env.TLS_CA_PATH = path.join(dir, 'server-ca.pem');
  resetDeviceCaCache();

  app = await buildApp();
  admin = { authorization: `Bearer ${await loginAs(app)}` };
  reauth = { ...admin, 'x-reauth-password': ADMIN_PASSWORD };
  profileId = (await prisma.instrumentProfile.create({ data: { name: `fixture:devcert-routes-${s}` } })).id;
  instrumentId = (await prisma.instrument.create({ data: { name: `DCR-${s}`, code: `DCR-${s}`, profileId } })).id;
  otherId = (await prisma.instrument.create({ data: { name: `DCR-OTHER-${s}`, code: `DCR-OTHER-${s}`, profileId } })).id;

  // OPERATOR: may update instruments, but sees only `otherId`.
  const role = await prisma.role.findFirstOrThrow({ where: { name: 'OPERATOR' } });
  operatorRoleId = role.id;
  operatorPermsBefore = role.permissions as string[];
  await prisma.role.update({ where: { id: role.id }, data: { permissions: [...new Set([...operatorPermsBefore, 'INSTRUMENT_READ', 'INSTRUMENT_UPDATE'])] } });
  invalidateRolePermsCache('OPERATOR');
  const cfg = await prisma.roleConfig.findFirst({ where: { role: 'OPERATOR' } });
  operatorScopeBefore = cfg?.instrumentScope ?? null;
  await prisma.roleConfig.upsert({
    where: { role: 'OPERATOR' },
    create: { role: 'OPERATOR', instrumentScope: { locationIds: [], instrumentIds: [otherId] } as never },
    update: { instrumentScope: { locationIds: [], instrumentIds: [otherId] } as never },
  });
}, 60_000);

afterAll(async () => {
  // Config first, each step on its own — a failing suite must still hand back what it touched.
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  resetDeviceCaCache();
  await prisma.roleConfig.updateMany({ where: { role: 'OPERATOR' }, data: { instrumentScope: (operatorScopeBefore ?? Prisma.DbNull) as never } }).catch(() => {});
  if (operatorRoleId) await prisma.role.update({ where: { id: operatorRoleId }, data: { permissions: operatorPermsBefore as never } }).catch(() => {});
  invalidateRolePermsCache('OPERATOR');
  await prisma.instrument.deleteMany({ where: { id: { in: [instrumentId, otherId].filter(Boolean) } } }).catch(() => {});
  await prisma.instrumentProfile.deleteMany({ where: { id: profileId } }).catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
  await app?.close();
});

describe('device certificate routes', () => {
  it('GET before any issue: available, not required, nothing issued', async () => {
    const res = await app.inject({ method: 'GET', url: url(), headers: admin });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: true, required: false, profileName: `fixture:devcert-routes-${s}`, issued: null });
  });

  it('POST refuses without the password re-auth', async () => {
    const res = await app.inject({ method: 'POST', url: url(), headers: admin });
    expect(res.statusCode).toBe(401);
    expect((await prisma.instrument.findUniqueOrThrow({ where: { id: instrumentId } })).deviceCertIssueId).toBeNull();
  });

  let firstIssueId = '';

  it('POST issues once: bundle with three files, the issue id stored, one audit row', async () => {
    const res = await app.inject({ method: 'POST', url: url(), headers: reauth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.issued.issueId).toMatch(/^[0-9a-f]{32}$/);
    expect(body.issued.issuedBy).toBe('admin');
    expect(body.fileName).toMatch(/\.zip$/);
    const zip = new AdmZip(Buffer.from(body.bundle, 'base64'));
    expect(zip.getEntries().map((e) => e.entryName).sort()).toEqual(['ca.crt', 'client.crt', 'client.key']);
    expect(zip.readAsText('ca.crt')).toBe('SERVER-CA');
    const cert = new X509Certificate(zip.readAsText('client.crt'));
    expect(cert.subject).toContain(`serialNumber=${body.issued.issueId}`);
    expect(body.issued.fingerprint).toBe(cert.fingerprint256.replace(/:/g, '').toLowerCase());

    const row = await prisma.instrument.findUniqueOrThrow({ where: { id: instrumentId } });
    expect(row.deviceCertIssueId).toBe(body.issued.issueId);
    expect(row.deviceCertFingerprint).toBe(body.issued.fingerprint);
    expect(row.deviceCertIssuedBy).toBe('admin');
    const audits = await auditRows('DEVICE_CERTIFICATE_ISSUED');
    expect(audits).toHaveLength(1);
    expect(audits[0].afterValue).toMatchObject({ code: `DCR-${s}`, issueId: body.issued.issueId, replacedIssueId: null });
    firstIssueId = body.issued.issueId;
  });

  it('GET shows the issued certificate — never the key', async () => {
    const res = await app.inject({ method: 'GET', url: url(), headers: admin });
    const body = res.json();
    expect(body.issued).toMatchObject({ issueId: firstIssueId, issuedBy: 'admin' });
    expect(JSON.stringify(body)).not.toContain('PRIVATE KEY');
  });

  it('re-issue replaces the id (pinning) and records which one it replaced', async () => {
    const res = await app.inject({ method: 'POST', url: url(), headers: reauth });
    expect(res.statusCode).toBe(200);
    const second = res.json().issued.issueId;
    expect(second).not.toBe(firstIssueId);
    expect((await prisma.instrument.findUniqueOrThrow({ where: { id: instrumentId } })).deviceCertIssueId).toBe(second);
    const audits = await auditRows('DEVICE_CERTIFICATE_ISSUED');
    expect(audits).toHaveLength(2);
    expect(audits[1].afterValue).toMatchObject({ issueId: second, replacedIssueId: firstIssueId });
  });

  it('renaming the instrument keeps its certificate (the CN is not the identity)', async () => {
    const before = (await prisma.instrument.findUniqueOrThrow({ where: { id: instrumentId } })).deviceCertIssueId;
    const put = await app.inject({ method: 'PUT', url: `/api/instruments/${instrumentId}`, headers: admin, payload: { code: `DCR-RENAMED-${s}` } });
    expect(put.statusCode).toBe(200);
    const res = await app.inject({ method: 'GET', url: url(), headers: admin });
    expect(res.json().issued.issueId).toBe(before);
  });

  it('DELETE revokes: id cleared, one audit row; a second DELETE is 409 NOT_ISSUED', async () => {
    const issueId = (await prisma.instrument.findUniqueOrThrow({ where: { id: instrumentId } })).deviceCertIssueId;
    expect((await app.inject({ method: 'DELETE', url: url(), headers: admin })).statusCode).toBe(401);
    const res = await app.inject({ method: 'DELETE', url: url(), headers: reauth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    const row = await prisma.instrument.findUniqueOrThrow({ where: { id: instrumentId } });
    expect(row.deviceCertIssueId).toBeNull();
    expect(row.deviceCertFingerprint).toBeNull();
    const audits = await auditRows('DEVICE_CERTIFICATE_REVOKED');
    expect(audits).toHaveLength(1);
    expect(audits[0].beforeValue).toMatchObject({ issueId });
    const again = await app.inject({ method: 'DELETE', url: url(), headers: reauth });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('NOT_ISSUED');
  });

  it('an instrument outside the caller\'s view is 404 on every device-certificate route', async () => {
    const operator = { authorization: `Bearer ${await loginAs(app, 'RB0001', 'Test@1234')}` };
    const opReauth = { ...operator, 'x-reauth-password': 'Test@1234' };
    expect((await app.inject({ method: 'GET', url: url(), headers: operator })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: url(), headers: opReauth })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: url(), headers: opReauth })).statusCode).toBe(404);
    // Positive control: the one in view answers.
    expect((await app.inject({ method: 'GET', url: `/api/instruments/${otherId}/device-certificate`, headers: operator })).statusCode).toBe(200);
    admin = { authorization: `Bearer ${await loginAs(app)}` };
    reauth = { ...admin, 'x-reauth-password': ADMIN_PASSWORD };
  });

  it('with no device CA: GET says unavailable, POST is 409 DEVICE_CA_NOT_CONFIGURED', async () => {
    const certPath = process.env.DEVICE_CA_CERT_PATH;
    delete process.env.DEVICE_CA_CERT_PATH;
    try {
      const get = await app.inject({ method: 'GET', url: url(), headers: admin });
      expect(get.json().available).toBe(false);
      const post = await app.inject({ method: 'POST', url: url(), headers: reauth });
      expect(post.statusCode).toBe(409);
      expect(post.json().error).toBe('DEVICE_CA_NOT_CONFIGURED');
    } finally {
      process.env.DEVICE_CA_CERT_PATH = certPath;
    }
  });
});
