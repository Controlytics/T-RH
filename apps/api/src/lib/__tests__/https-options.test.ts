import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildHttpsOptions } from '../https-options.js';

/**
 * The API asks TLS clients for a certificate ONLY when the device CA is
 * configured (device certificates, 2026-10-27) — and even then never rejects
 * one that sends none (`rejectUnauthorized: false`): browsers, the EMQX hook
 * and every device of a profile that does not require a certificate must
 * connect exactly as before. The per-instrument decision is the route's.
 */
let dir: string;
const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  API_HTTPS: 'true',
  TLS_KEY_PATH: path.join(dir, 'server.key'),
  TLS_CERT_PATH: path.join(dir, 'server.crt'),
  ...extra,
});

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'https-options-'));
  fs.writeFileSync(path.join(dir, 'server.key'), 'KEY');
  fs.writeFileSync(path.join(dir, 'server.crt'), 'CERT');
  fs.writeFileSync(path.join(dir, 'device-ca.pem'), 'DEVICE-CA');
  fs.writeFileSync(path.join(dir, 'device-ca.key'), 'DEVICE-CA-KEY');
});

afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('buildHttpsOptions', () => {
  it('is null unless API_HTTPS is "true"', () => {
    expect(buildHttpsOptions({}, dir)).toBeNull();
    expect(buildHttpsOptions({ API_HTTPS: 'false' }, dir)).toBeNull();
  });

  it('serves the server key and certificate, and asks for nothing more without a device CA', () => {
    const o = buildHttpsOptions(env(), dir);
    expect(o?.key.toString()).toBe('KEY');
    expect(o?.cert.toString()).toBe('CERT');
    expect(o).not.toHaveProperty('requestCert');
    expect(o).not.toHaveProperty('ca');
  });

  it('falls back to server.key / server.crt in the default directory', () => {
    const o = buildHttpsOptions({ API_HTTPS: 'true' }, dir);
    expect(o?.cert.toString()).toBe('CERT');
  });

  it('with a device CA: requests a client certificate, verifies it against that CA only, rejects nobody', () => {
    const o = buildHttpsOptions(env({
      DEVICE_CA_CERT_PATH: path.join(dir, 'device-ca.pem'),
      DEVICE_CA_KEY_PATH: path.join(dir, 'device-ca.key'),
    }), dir);
    expect(o?.requestCert).toBe(true);
    expect(o?.rejectUnauthorized).toBe(false);
    expect(o?.ca?.toString()).toBe('DEVICE-CA');
  });

  it('a device CA path whose file is missing counts as not configured', () => {
    const o = buildHttpsOptions(env({
      DEVICE_CA_CERT_PATH: path.join(dir, 'missing.pem'),
      DEVICE_CA_KEY_PATH: path.join(dir, 'device-ca.key'),
    }), dir);
    expect(o).not.toHaveProperty('requestCert');
  });
});
