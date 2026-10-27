import fs from 'node:fs';
import path from 'node:path';

/**
 * The DEVICE CA (2026-10-27) — the CA that issues each instrument's client
 * certificate (`device-certificate.ts` is the decision; this is the issuer).
 *
 * Deliberately SEPARATE from the server CA (`rootCA.pem` / `rootCA.key`): the
 * API must hold this key to issue certificates from the app, and the server CA
 * key stays root-only — a compromised API process can forge a device identity,
 * never a server certificate.
 *
 * Configured by two env paths. Both set AND both files present = the feature
 * is available; anything less = inert, and every install that never sets them
 * behaves exactly as before (no client certificate is requested, EMQX does not
 * verify one, the profile switch cannot be turned on). Availability is checked
 * on every call — a file that disappears turns the feature off at once instead
 * of serving a cached key.
 */

export function deviceCaPaths(): { certPath: string; keyPath: string } | null {
  const certPath = process.env.DEVICE_CA_CERT_PATH;
  const keyPath = process.env.DEVICE_CA_KEY_PATH;
  if (!certPath || !keyPath) return null;
  return { certPath, keyPath };
}

export function deviceCaAvailable(): boolean {
  const p = deviceCaPaths();
  return p !== null && fs.existsSync(p.certPath) && fs.existsSync(p.keyPath);
}

let cached: { key: string; ca: { certPem: string; keyPem: string } } | null = null;

export function resetDeviceCaCache(): void { cached = null; }

export async function loadDeviceCa(): Promise<{ certPem: string; keyPem: string } | null> {
  if (!deviceCaAvailable()) return null;
  const p = deviceCaPaths()!;
  const key = `${p.certPath}|${p.keyPath}`;
  if (cached?.key === key) return cached.ca;
  const [certPem, keyPem] = await Promise.all([
    fs.promises.readFile(p.certPath, 'utf8'),
    fs.promises.readFile(p.keyPath, 'utf8'),
  ]);
  cached = { key, ca: { certPem, keyPem } };
  return cached.ca;
}

/**
 * The SERVER CA — what the device already uses to trust https / mqtts — for
 * the `ca.crt` inside the certificate bundle. `TLS_CA_PATH`, else `rootCA.pem`
 * beside `TLS_CERT_PATH` (the layout every installer writes). On this dev
 * checkout neither is right by default: `certs/rootCA.pem` signs nothing and
 * the mkcert CA lives under %LOCALAPPDATA% — set TLS_CA_PATH there.
 */
export function serverCaPem(): string | null {
  const explicit = process.env.TLS_CA_PATH;
  const candidate = explicit
    ?? (process.env.TLS_CERT_PATH ? path.join(path.dirname(process.env.TLS_CERT_PATH), 'rootCA.pem') : null);
  if (!candidate || !fs.existsSync(candidate)) return null;
  return fs.readFileSync(candidate, 'utf8');
}
