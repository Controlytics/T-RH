/**
 * Conditional global setup for the windows-server-stack integration suite.
 *
 * When INTEGRATION_TEST !== '1' the suite as a whole is `describe.skipIf`'d
 * and we MUST NOT touch the DB — otherwise running the workspace on a box
 * that lacks Postgres explodes during setup before any test gets to skip
 * itself. In that case this hook is a no-op.
 *
 * When the gate is on, we delegate to the API's globalSetup so the tests
 * inherit the same idempotent SUPER_ADMIN/`admin` fixture the e2e suite
 * uses (vitest.global-setup.ts in apps/api/).
 */
export default async function setup(): Promise<void> {
  if (process.env.INTEGRATION_TEST !== '1') return;
  const mod = (await import('../../apps/api/vitest.global-setup.ts')) as {
    default: () => Promise<void>;
  };
  await mod.default();
}
