import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * The Windows installer scripts are never run on this laptop (no installer may
 * run here, and there is no clean VM yet — audit P1-3). These read them AS TEXT
 * and pin the contracts audit 2026-11-07 found broken:
 *
 * - S9-1 (CRITICAL): `install.ps1` never set MAINTENANCE_CRONTAB_PATH. The API's
 *   default (`../../../packages/queue/crontab.txt` from `runtime\api\dist`) does
 *   not exist in an install, so the job runner never started: no alarm pass, no
 *   OFFLINE detection, no notifications, no partitions — while the installer
 *   reported success, because it checked HTTP 200 only.
 * - S9-5: the standalone Postgres `provision-db.ps1` starts was left running when
 *   the service for the same data directory was registered and started.
 * - S9-14: `upgrade.ps1` probed `http://` against an API that serves HTTPS only,
 *   so every upgrade ended in "did not report healthy".
 */
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
// The scripts are CRLF; `$` in a multiline regex stops at `\n`, not `\r\n`.
const read = (rel: string) => readFileSync(path.join(repo, rel), 'utf8').replace(/\r\n/g, '\n');

describe('the scripts keep code ASCII', () => {
  // Windows PowerShell 5.1 reads a script WITHOUT a BOM as the ANSI code page: a
  // UTF-8 em dash becomes `â€”`, whose last byte is a right double quote there —
  // inside a string or a command that breaks the parse on a customer machine. In
  // a `#` comment it only garbles the text (both scripts carry a few such).
  for (const rel of ['scripts/install.ps1', 'scripts/upgrade.ps1']) {
    it(`${rel} has no non-ASCII character outside a comment line`, () => {
      const code = read(rel).split('\n').filter((l) => !l.trimStart().startsWith('#'));
      expect(code.filter((l) => /[^\x00-\x7F]/.test(l))).toEqual([]);
    });
  }
});

describe('scripts/install.ps1', () => {
  const install = read('scripts/install.ps1');

  it('writes MAINTENANCE_CRONTAB_PATH, pointing where stage-runtime.ps1 puts the crontab', () => {
    expect(read('scripts/stage-runtime.ps1')).toContain('runtime\\queue\\crontab.txt');
    expect(install).toMatch(/^MAINTENANCE_CRONTAB_PATH=\$crontabPath$/m);
    expect(install).toMatch(/\$crontabPath\s*=\s*Join-Path \$InstallDir 'runtime\\queue\\crontab\.txt'/);
  });

  it('stops the provisioning Postgres before the database service is registered', () => {
    expect(install).toMatch(/\$provArgs = @\{[^}]*StopWhenDone = \$true/s);
  });

  it('requires the job runner to be RUNNING, not just HTTP 200', () => {
    expect(install).toMatch(/\.jobRunner/);
    expect(install).toMatch(/-eq 'running'/);
  });
});

describe('scripts/upgrade.ps1', () => {
  const upgrade = read('scripts/upgrade.ps1');

  it('adds MAINTENANCE_CRONTAB_PATH to an install that predates it, and keeps an existing one', () => {
    expect(upgrade).toMatch(/MAINTENANCE_CRONTAB_PATH/);
    expect(upgrade).toMatch(/runtime\\queue\\crontab\.txt/);
    expect(upgrade).toMatch(/\^\\s\*MAINTENANCE_CRONTAB_PATH\\s\*=/);
  });

  it('probes the API over HTTPS — the API serves nothing on plain HTTP', () => {
    expect(upgrade).not.toMatch(/http:\/\/localhost:\$ApiPort/);
    expect(upgrade).toMatch(/https:\/\/localhost:\$ApiPort\/api\/health/);
  });

  it('requires the job runner to be RUNNING, not just HTTP 200', () => {
    expect(upgrade).toMatch(/\.jobRunner/);
    expect(upgrade).toMatch(/-eq 'running'/);
  });
});

/**
 * S2-H1: graphile-worker 0.16.6 left an unhandled rejection that exited the API on a
 * database drop. `patches/graphile-worker+0.16.6.patch` fixes it, applied by the root
 * `postinstall` — but patch-package exits 0 when it finds NO patch, so a clean room
 * without `patches/` would ship the crash silently. These pin every install path.
 */
describe('the graphile-worker patch reaches every install (S2-H1)', () => {
  const MARKER = 'compliance-core patch (patches/graphile-worker+0.16.6.patch';

  it('the root postinstall applies patches and fails loudly on a patch that does not apply or no longer matches', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string>; dependencies?: Record<string, string> };
    expect(pkg.scripts.postinstall).toBe('patch-package --error-on-fail --error-on-warn');
    // A PRODUCTION dependency: both installers and the .deb run `npm ci --omit=dev`.
    expect(pkg.dependencies?.['patch-package']).toBeDefined();
    expect(read('patches/graphile-worker+0.16.6.patch')).toContain(MARKER);
  });

  it('the patch is checked out LF — a CRLF copy would not apply', () => {
    expect(read('.gitattributes')).toMatch(/^patches\/\*\* text eol=lf$/m);
  });

  it('the .deb build copies patches/ into its clean room and refuses a runtime without the patch', () => {
    const deb = read('scripts/linux/build-deb.sh');
    const copy = deb.indexOf('cp -r patches "$CLEAN/patches"');
    const ci = deb.indexOf('npm ci --omit=dev', copy);
    expect(copy).toBeGreaterThan(-1);
    expect(ci).toBeGreaterThan(copy);
    expect(deb).toContain(`grep -qF "${MARKER}" "$CLEAN/node_modules/graphile-worker/dist/runner.js"`);
  });

  it('the Windows installer build refuses a clean room without the patch', () => {
    const inst = read('scripts/build-installer.ps1');
    expect(inst).toMatch(/git archive --format=tar HEAD/);
    expect(inst).toContain(`'node_modules\\graphile-worker\\dist\\runner.js' -SimpleMatch -Quiet -Pattern '${MARKER}'`);
    expect(inst).toMatch(/\$global:LASTEXITCODE = 1/);
  });
});
