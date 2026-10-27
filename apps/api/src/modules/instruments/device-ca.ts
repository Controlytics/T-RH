// tsyringe (a dependency of @peculiar/x509) refuses to load without a Reflect
// metadata polyfill. Imported here, the one module that issues certificates.
import 'reflect-metadata';
import fs from 'node:fs';
import path from 'node:path';
import { X509Certificate as NodeX509Certificate, createPrivateKey, randomBytes, webcrypto } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import AdmZip from 'adm-zip';

// Node can PARSE X.509 but not SIGN it, hence the library; it runs on Node's
// own WebCrypto.
x509.cryptoProvider.set(webcrypto as unknown as Crypto);

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

export function deviceCaPaths(env: NodeJS.ProcessEnv = process.env): { certPath: string; keyPath: string } | null {
  const certPath = env.DEVICE_CA_CERT_PATH;
  const keyPath = env.DEVICE_CA_KEY_PATH;
  if (!certPath || !keyPath) return null;
  return { certPath, keyPath };
}

export function deviceCaAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  const p = deviceCaPaths(env);
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

export class DeviceCaNotConfiguredError extends Error {
  readonly code = 'DEVICE_CA_NOT_CONFIGURED';
  constructor() { super('Device certificates are not set up on this server (no device CA configured).'); }
}

export interface IssuedDeviceCertificate {
  issueId: string;
  certificatePem: string;
  /** PKCS#1 (`BEGIN RSA PRIVATE KEY`) — the form embedded TLS stacks accept most widely. Never stored. */
  privateKeyPem: string;
  /** SHA-256 of the DER certificate, lowercase hex, no colons. */
  fingerprint: string;
  notBefore: Date;
  notAfter: Date;
}

const RSA: RsaHashedKeyGenParams = {
  name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', publicExponent: new Uint8Array([1, 0, 1]), modulusLength: 2048,
};
const CA_YEARS = 20;
const DEVICE_YEARS = 10;
// The server judges a client certificate against ITS clock, which is synced;
// a few minutes back covers the gap between issuing here and a broker or a
// second node that is a little behind.
const BACKDATE_MS = 5 * 60_000;

function plusYears(d: Date, years: number): Date {
  const out = new Date(d);
  out.setUTCFullYear(out.getUTCFullYear() + years);
  return out;
}

/** A positive 16-byte X.509 serial (the leading 01 keeps the DER INTEGER positive). */
function certSerial(): string { return `01${randomBytes(15).toString('hex')}`; }

async function newRsaKeys(): Promise<CryptoKeyPair> {
  return webcrypto.subtle.generateKey(RSA, true, ['sign', 'verify']) as Promise<CryptoKeyPair>;
}

async function privateKeyDer(key: CryptoKey): Promise<Buffer> {
  return Buffer.from(await webcrypto.subtle.exportKey('pkcs8', key));
}

/**
 * Create the device CA ONCE. Refuses to replace an existing file: a new CA
 * would orphan every certificate already issued, i.e. silently cut off every
 * device that carries one. Used by `scripts/create-device-ca.ts` and tests;
 * the installers create it with openssl, the same way they make the server CA.
 */
export async function createDeviceCaFiles(certPath: string, keyPath: string): Promise<void> {
  for (const p of [certPath, keyPath]) {
    if (fs.existsSync(p)) throw new Error(`${p} exists — refusing to replace a device CA (every certificate it issued would stop working)`);
  }
  const keys = await newRsaKeys();
  const notBefore = new Date();
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: certSerial(),
    name: 'CN=DigiLog Device CA',
    notBefore,
    notAfter: plusYears(notBefore, CA_YEARS),
    keys,
    signingAlgorithm: RSA,
    extensions: [
      new x509.BasicConstraintsExtension(true, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  const keyPem = createPrivateKey({ key: await privateKeyDer(keys.privateKey), format: 'der', type: 'pkcs8' })
    .export({ type: 'pkcs8', format: 'pem' }) as string;
  // Key first, exclusive-create, owner-only where the OS honours it; the
  // installers then hand it to the service user's group.
  fs.writeFileSync(keyPath, keyPem, { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(certPath, cert.toString('pem'), { flag: 'wx' });
}

/**
 * Issue a client certificate for one instrument. Subject
 * `O=DigiLog Device, serialNumber=<issueId>, CN=<code>`: the issue id is the
 * identity every channel compares; the CN is informational (a rename does not
 * invalidate it). Built from attribute OIDs, not a DN string, so a code with
 * `,` `=` or `+` needs no escaping.
 */
export async function issueDeviceCertificate(code: string): Promise<IssuedDeviceCertificate> {
  const ca = await loadDeviceCa();
  if (!ca) throw new DeviceCaNotConfiguredError();
  const caCert = new x509.X509Certificate(ca.certPem);
  const caKey = await webcrypto.subtle.importKey(
    'pkcs8',
    createPrivateKey(ca.keyPem).export({ type: 'pkcs8', format: 'der' }),
    RSA, false, ['sign'],
  );

  const keys = await newRsaKeys();
  const issueId = randomBytes(16).toString('hex');
  const notBefore = new Date(Date.now() - BACKDATE_MS);
  const wanted = plusYears(new Date(), DEVICE_YEARS);
  const notAfter = wanted.getTime() < caCert.notAfter.getTime() ? wanted : new Date(caCert.notAfter);

  const extensions: x509.Extension[] = [
    new x509.BasicConstraintsExtension(false, undefined, true),
    new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment, true),
    new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth], false),
    await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
  ];
  const caSki = caCert.getExtension(x509.SubjectKeyIdentifierExtension);
  if (caSki) extensions.push(new x509.AuthorityKeyIdentifierExtension(caSki.keyId));

  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: certSerial(),
    subject: new x509.Name([
      { '2.5.4.10': ['DigiLog Device'] }, // O
      { '2.5.4.5': [issueId] },           // serialNumber
      { '2.5.4.3': [code] },              // CN
    ]),
    issuer: caCert.subjectName,
    notBefore,
    notAfter,
    publicKey: keys.publicKey,
    signingKey: caKey,
    signingAlgorithm: RSA,
    extensions,
  });

  const certificatePem = cert.toString('pem');
  const privateKeyPem = createPrivateKey({ key: await privateKeyDer(keys.privateKey), format: 'der', type: 'pkcs8' })
    .export({ type: 'pkcs1', format: 'pem' }) as string;
  const fingerprint = new NodeX509Certificate(certificatePem).fingerprint256.replace(/:/g, '').toLowerCase();
  return { issueId, certificatePem, privateKeyPem, fingerprint, notBefore, notAfter };
}

/** The one-time download: client.crt, client.key and — when known — the server's ca.crt. */
export function buildCertificateBundle(issued: IssuedDeviceCertificate, serverCa: string | null): Buffer {
  const zip = new AdmZip();
  zip.addFile('client.crt', Buffer.from(issued.certificatePem, 'utf8'));
  zip.addFile('client.key', Buffer.from(issued.privateKeyPem, 'utf8'));
  if (serverCa !== null) zip.addFile('ca.crt', Buffer.from(serverCa, 'utf8'));
  return zip.toBuffer();
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
