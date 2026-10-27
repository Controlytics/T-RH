import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { generateToken, hashToken, tokenPrefix } from '../modules/instruments/token.js';
import { resolveInstrumentByToken, invalidateIngestAuthCache } from '../modules/instruments/ingest-auth.js';
import { childMapFor, invalidateChildMapCache } from '../modules/instruments/gateway-children.js';

/**
 * The certificate facts ride on the cached ingest identity and the gateway
 * child map (device certificates, 2026-10-27), read through the REAL Prisma
 * selects — a mocked row cannot catch a select that forgot the profile flag.
 */
const ISSUE = 'aa'.repeat(16);
const stamp = Date.now();
let requiredProfileId: string;
let freeProfileId: string;
const ids: string[] = [];
let gatewayId: string;
let requiredToken: string;
let freeToken: string;

async function instrument(code: string, profileId: string, extra: Record<string, unknown> = {}): Promise<string> {
  const row = await prisma.instrument.create({ data: { name: code, code, profileId, ...extra } });
  ids.push(row.id);
  return row.id;
}

async function credential(instrumentId: string): Promise<string> {
  const token = generateToken();
  await prisma.instrumentCredential.create({ data: { instrumentId, tokenHash: hashToken(token), tokenPrefix: tokenPrefix(token) } });
  return token;
}

beforeAll(async () => {
  requiredProfileId = (await prisma.instrumentProfile.create({
    data: { name: `fixture:devcert-required-${stamp}`, requireDeviceCertificate: true },
  })).id;
  freeProfileId = (await prisma.instrumentProfile.create({ data: { name: `fixture:devcert-free-${stamp}` } })).id;
  const required = await instrument(`DCI-REQ-${stamp}`, requiredProfileId, { deviceCertIssueId: ISSUE });
  const free = await instrument(`DCI-FREE-${stamp}`, freeProfileId);
  requiredToken = await credential(required);
  freeToken = await credential(free);
  gatewayId = await instrument(`DCI-GW-${stamp}`, freeProfileId, { isGateway: true });
  await instrument(`DCI-KID-REQ-${stamp}`, requiredProfileId, { gatewayId });
  await instrument(`DCI-KID-FREE-${stamp}`, freeProfileId, { gatewayId });
  invalidateIngestAuthCache();
  invalidateChildMapCache();
});

afterAll(async () => {
  await prisma.instrumentCredential.deleteMany({ where: { instrumentId: { in: ids } } });
  await prisma.instrument.updateMany({ where: { id: { in: ids } }, data: { gatewayId: null } });
  await prisma.instrument.deleteMany({ where: { id: { in: ids } } });
  await prisma.instrumentProfile.deleteMany({ where: { id: { in: [requiredProfileId, freeProfileId] } } });
});

describe('ingest identity carries the device-certificate facts', () => {
  it('an instrument in a requiring profile: required, with its current issue id', async () => {
    const identity = await resolveInstrumentByToken(requiredToken);
    expect(identity?.deviceCert).toEqual({ required: true, issueId: ISSUE });
  });

  it('an instrument in an ordinary profile: not required, no issue id', async () => {
    const identity = await resolveInstrumentByToken(freeToken);
    expect(identity?.deviceCert).toEqual({ required: false, issueId: null });
  });
});

describe('gateway child map carries whether each child requires a certificate', () => {
  it('flags the child in the requiring profile only', async () => {
    const map = await childMapFor(gatewayId);
    expect(map.get(`DCI-KID-REQ-${stamp}`)?.requiresCertificate).toBe(true);
    expect(map.get(`DCI-KID-FREE-${stamp}`)?.requiresCertificate).toBe(false);
  });
});
