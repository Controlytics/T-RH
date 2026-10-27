import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto';
import AdmZip from 'adm-zip';
import {
  DeviceCaNotConfiguredError,
  buildCertificateBundle,
  createDeviceCaFiles,
  issueDeviceCertificate,
  resetDeviceCaCache,
} from '../device-ca.js';

const KEYS = ['DEVICE_CA_CERT_PATH', 'DEVICE_CA_KEY_PATH'] as const;
const saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};
let dir: string;
let caCertPath: string;
let caKeyPath: string;

beforeAll(async () => {
  for (const k of KEYS) saved[k] = process.env[k];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-ca-issue-'));
  caCertPath = path.join(dir, 'device-ca.pem');
  caKeyPath = path.join(dir, 'device-ca.key');
  await createDeviceCaFiles(caCertPath, caKeyPath);
  process.env.DEVICE_CA_CERT_PATH = caCertPath;
  process.env.DEVICE_CA_KEY_PATH = caKeyPath;
  resetDeviceCaCache();
}, 60_000);

afterAll(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  fs.rmSync(dir, { recursive: true, force: true });
  resetDeviceCaCache();
});

describe('createDeviceCaFiles', () => {
  it('writes a CA certificate named DigiLog Device CA', () => {
    const ca = new X509Certificate(fs.readFileSync(caCertPath));
    expect(ca.ca).toBe(true);
    expect(ca.subject).toBe('CN=DigiLog Device CA');
    expect(new Date(ca.validTo).getTime() - Date.now()).toBeGreaterThan(19 * 365 * 864e5);
  });

  it('refuses to overwrite an existing CA — every issued certificate would be orphaned', async () => {
    await expect(createDeviceCaFiles(caCertPath, path.join(dir, 'other.key'))).rejects.toThrow(/exists/);
    await expect(createDeviceCaFiles(path.join(dir, 'other.pem'), caKeyPath)).rejects.toThrow(/exists/);
  });
});

describe('issueDeviceCertificate', () => {
  it('issues a client certificate the device CA signed, carrying the issue id and the code', async () => {
    const issued = await issueDeviceCertificate('CWH/RDU/001-00');
    const cert = new X509Certificate(issued.certificatePem);
    const ca = new X509Certificate(fs.readFileSync(caCertPath));

    expect(issued.issueId).toMatch(/^[0-9a-f]{32}$/);
    expect(cert.checkIssued(ca)).toBe(true);
    expect(cert.verify(ca.publicKey)).toBe(true);
    expect(cert.subject).toContain(`serialNumber=${issued.issueId}`);
    expect(cert.subject).toContain('CN=CWH/RDU/001-00');
    expect(cert.subject).toContain('O=DigiLog Device');
    expect(cert.ca).toBe(false);
    // Node's `keyUsage` is the EXTENDED key usage list: clientAuth.
    expect(cert.keyUsage).toContain('1.3.6.1.5.5.7.3.2');
    expect(issued.fingerprint).toBe(cert.fingerprint256.replace(/:/g, '').toLowerCase());
    expect(Math.abs(issued.notAfter.getTime() - new Date(cert.validTo).getTime())).toBeLessThan(1000);
    expect(new Date(cert.validTo).getTime()).toBeLessThanOrEqual(new Date(ca.validTo).getTime());
    expect(new Date(cert.validTo).getTime() - Date.now()).toBeGreaterThan(9 * 365 * 864e5);
  });

  it('returns the private key as PKCS#1 PEM, matching the certificate', async () => {
    const issued = await issueDeviceCertificate('Test');
    expect(issued.privateKeyPem.startsWith('-----BEGIN RSA PRIVATE KEY-----')).toBe(true);
    const fromKey = createPublicKey(createPrivateKey(issued.privateKeyPem)).export({ type: 'spki', format: 'der' });
    const fromCert = new X509Certificate(issued.certificatePem).publicKey.export({ type: 'spki', format: 'der' });
    expect(Buffer.compare(fromKey, fromCert)).toBe(0);
  });

  it('neutralises DN-special characters in the CN and caps it at 64 (a code is free text)', async () => {
    const forged = await issueDeviceCertificate(`X,SERIALNUMBER=${'b'.repeat(32)}`);
    const subject = new X509Certificate(forged.certificatePem).subject;
    // Exactly ONE serialNumber, and it is the issue id.
    expect(subject.match(/serialNumber=/g)).toHaveLength(1);
    expect(subject).toContain(`serialNumber=${forged.issueId}`);
    expect(subject).not.toMatch(/CN=.*[,+=\\";<>#]/);
    const long = await issueDeviceCertificate('C'.repeat(100));
    const cn = /CN=([^\n]*)/.exec(new X509Certificate(long.certificatePem).subject)?.[1] ?? '';
    expect(cn.length).toBeLessThanOrEqual(64);
  });

  it('gives every issue a new id', async () => {
    const a = await issueDeviceCertificate('Test');
    const b = await issueDeviceCertificate('Test');
    expect(a.issueId).not.toBe(b.issueId);
  });

  it('refuses when the device CA is not configured', async () => {
    const cert = process.env.DEVICE_CA_CERT_PATH;
    delete process.env.DEVICE_CA_CERT_PATH;
    try {
      await expect(issueDeviceCertificate('Test')).rejects.toBeInstanceOf(DeviceCaNotConfiguredError);
    } finally {
      process.env.DEVICE_CA_CERT_PATH = cert;
    }
  });
});

describe('buildCertificateBundle', () => {
  it('zips the certificate, the key and the server CA', async () => {
    const issued = await issueDeviceCertificate('Test');
    const zip = new AdmZip(buildCertificateBundle(issued, 'SERVER-CA'));
    expect(zip.getEntries().map((e) => e.entryName).sort()).toEqual(['ca.crt', 'client.crt', 'client.key']);
    expect(zip.readAsText('client.crt')).toBe(issued.certificatePem);
    expect(zip.readAsText('client.key')).toBe(issued.privateKeyPem);
    expect(zip.readAsText('ca.crt')).toBe('SERVER-CA');
  });

  it('leaves ca.crt out when the server CA is unknown', async () => {
    const issued = await issueDeviceCertificate('Test');
    const zip = new AdmZip(buildCertificateBundle(issued, null));
    expect(zip.getEntries().map((e) => e.entryName).sort()).toEqual(['client.crt', 'client.key']);
  });
});
