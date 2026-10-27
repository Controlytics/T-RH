import fs from 'node:fs';
import path from 'node:path';
import { deviceCaAvailable, deviceCaPaths } from '../modules/instruments/device-ca.js';

export interface ApiHttpsOptions {
  key: Buffer;
  cert: Buffer;
  requestCert?: true;
  rejectUnauthorized?: false;
  ca?: Buffer;
}

/**
 * The API's TLS options. Lifted out of app.ts (2026-10-27) so a test can build
 * the exact same server.
 *
 * TLS cert location is env-overridable so the customer install can point it at
 * C:\ProgramData\DigiLog\certs (data dir → survives upgrades; regenerating the
 * CA on upgrade would re-break every client's trust). Defaults to the dev
 * repo's certs/server.{key,crt}. See EXE-PACKAGING-PLAN.md §13.
 *
 * DEVICE CERTIFICATES (2026-10-27): when the device CA is configured, ask every
 * client for a certificate (`requestCert`) and verify it against the DEVICE CA
 * ONLY (`ca`) — but reject NOBODY at the handshake (`rejectUnauthorized:
 * false`). Browsers, the EMQX auth hook and every device of a profile that
 * does not require a certificate connect exactly as before; the ingest routes
 * decide per instrument from `socket.authorized`. Naming only the device CA
 * in the CertificateRequest also means a browser holds no matching
 * certificate and shows no picker.
 */
export function buildHttpsOptions(env: NodeJS.ProcessEnv, defaultCertDir: string): ApiHttpsOptions | null {
  if (env.API_HTTPS !== 'true') return null;
  const options: ApiHttpsOptions = {
    key: fs.readFileSync(env.TLS_KEY_PATH ?? path.join(defaultCertDir, 'server.key')),
    cert: fs.readFileSync(env.TLS_CERT_PATH ?? path.join(defaultCertDir, 'server.crt')),
  };
  if (deviceCaAvailable(env)) {
    options.requestCert = true;
    options.rejectUnauthorized = false;
    options.ca = fs.readFileSync(deviceCaPaths(env)!.certPath);
  }
  return options;
}
