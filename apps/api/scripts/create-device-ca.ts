/**
 * Create the DEVICE CA once (device certificates, 2026-10-27) — for local dev
 * and manual installs. The installers (`scripts/linux/digilog-lib.sh`,
 * `scripts/install.ps1`) create it with openssl instead, the same way they
 * create the server CA.
 *
 *   npx tsx scripts/create-device-ca.ts <device-ca.pem> <device-ca.key>
 *
 * Refuses to overwrite either file: a new CA would orphan every certificate
 * already issued. Then point the API at them:
 *   DEVICE_CA_CERT_PATH=<device-ca.pem>
 *   DEVICE_CA_KEY_PATH=<device-ca.key>
 * and restart it (and EMQX, whose SSL listener verifies against the .pem).
 */
import { createDeviceCaFiles } from '../src/modules/instruments/device-ca.js';

const [certPath, keyPath] = process.argv.slice(2);
if (!certPath || !keyPath) {
  console.error('usage: npx tsx scripts/create-device-ca.ts <device-ca.pem> <device-ca.key>');
  process.exit(2);
}
createDeviceCaFiles(certPath, keyPath)
  .then(() => console.log(`Device CA written:\n  ${certPath}\n  ${keyPath}`))
  .catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
