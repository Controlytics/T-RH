import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deviceCaAvailable, deviceCaPaths, loadDeviceCa, resetDeviceCaCache, serverCaPem } from '../device-ca.js';

const KEYS = ['DEVICE_CA_CERT_PATH', 'DEVICE_CA_KEY_PATH', 'TLS_CA_PATH', 'TLS_CERT_PATH'] as const;
const saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};
let dir: string;
let cert: string;
let key: string;

beforeEach(() => {
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-ca-'));
  cert = path.join(dir, 'device-ca.pem');
  key = path.join(dir, 'device-ca.key');
  fs.writeFileSync(cert, 'CERT');
  fs.writeFileSync(key, 'KEY');
  resetDeviceCaCache();
});

afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  fs.rmSync(dir, { recursive: true, force: true });
  resetDeviceCaCache();
});

describe('device CA availability — inert unless BOTH files are configured and present', () => {
  it('is unavailable with no env', async () => {
    expect(deviceCaPaths()).toBeNull();
    expect(deviceCaAvailable()).toBe(false);
    await expect(loadDeviceCa()).resolves.toBeNull();
  });

  it('is unavailable with only one of the two paths', () => {
    process.env.DEVICE_CA_CERT_PATH = cert;
    expect(deviceCaAvailable()).toBe(false);
  });

  it('is available when both are set and both files exist', async () => {
    process.env.DEVICE_CA_CERT_PATH = cert;
    process.env.DEVICE_CA_KEY_PATH = key;
    expect(deviceCaPaths()).toEqual({ certPath: cert, keyPath: key });
    expect(deviceCaAvailable()).toBe(true);
    await expect(loadDeviceCa()).resolves.toEqual({ certPem: 'CERT', keyPem: 'KEY' });
  });

  it('turns unavailable the moment a file disappears, even after a successful load', async () => {
    process.env.DEVICE_CA_CERT_PATH = cert;
    process.env.DEVICE_CA_KEY_PATH = key;
    await loadDeviceCa();
    fs.rmSync(cert);
    expect(deviceCaAvailable()).toBe(false);
  });
});

describe('serverCaPem — the CA the device already uses to trust the server', () => {
  it('reads TLS_CA_PATH when set', () => {
    const ca = path.join(dir, 'custom-ca.pem');
    fs.writeFileSync(ca, 'SERVER-CA');
    process.env.TLS_CA_PATH = ca;
    expect(serverCaPem()).toBe('SERVER-CA');
  });

  it('falls back to rootCA.pem beside TLS_CERT_PATH', () => {
    fs.writeFileSync(path.join(dir, 'rootCA.pem'), 'ROOT');
    process.env.TLS_CERT_PATH = path.join(dir, 'server.crt');
    expect(serverCaPem()).toBe('ROOT');
  });

  it('is null when there is nothing to read', () => {
    process.env.TLS_CERT_PATH = path.join(dir, 'server.crt');
    expect(serverCaPem()).toBeNull();
  });
});
