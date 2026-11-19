import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadReleaseInfo, DEFAULT_RELEASE_FILES, PRODUCT_NAME, type ReleaseInfoFiles } from '../release-info.js';

const FILES: ReleaseInfoFiles = { defaultReleaseFile: '/opt/x/runtime/release.json', rootPackageJson: '/opt/x/package.json' };

function enoent(file: string): never {
  const err = new Error(`ENOENT: no such file or directory, open '${file}'`) as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  throw err;
}

/** A readFile over an in-memory folder; anything absent is ENOENT, as fs would say. */
function reader(contents: Record<string, string>) {
  return (file: string) => (file in contents ? contents[file] : enoent(file));
}

const RELEASE = JSON.stringify({ product: 'T&RH Monitoring', version: '1.2.3', build: 57, commit: 'abc123', date: '2026-11-19T10:00:00Z' });

describe('loadReleaseInfo', () => {
  it('reads the installed runtime/release.json', () => {
    const { info, problems } = loadReleaseInfo({}, reader({ [FILES.defaultReleaseFile]: RELEASE }), FILES);
    expect(info).toEqual({ product: 'T&RH Monitoring', version: '1.2.3', build: 57, commit: 'abc123', date: '2026-11-19T10:00:00Z', source: 'release.json' });
    expect(problems).toEqual([]);
  });

  it('prefers RELEASE_INFO_PATH over the default file', () => {
    const other = JSON.stringify({ version: '9.9.9', build: null });
    const { info } = loadReleaseInfo(
      { RELEASE_INFO_PATH: '/etc/rel.json' },
      reader({ '/etc/rel.json': other, [FILES.defaultReleaseFile]: RELEASE }),
      FILES,
    );
    expect(info.version).toBe('9.9.9');
    expect(info.build).toBeNull();
    expect(info.source).toBe('RELEASE_INFO_PATH');
    expect(info.product).toBe(PRODUCT_NAME);
  });

  it('a named RELEASE_INFO_PATH that is missing is a problem, and the default file still answers', () => {
    const { info, problems } = loadReleaseInfo({ RELEASE_INFO_PATH: '/nope.json' }, reader({ [FILES.defaultReleaseFile]: RELEASE }), FILES);
    expect(info.source).toBe('release.json');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('/nope.json');
  });

  it('a checkout (no release file) reports the root package.json version as -dev, with no problem', () => {
    const { info, problems } = loadReleaseInfo({}, reader({ [FILES.rootPackageJson]: JSON.stringify({ version: '1.0.0' }) }), FILES);
    expect(info).toEqual({ product: PRODUCT_NAME, version: '1.0.0-dev', build: null, commit: null, date: null, source: 'package.json' });
    expect(problems).toEqual([]);
  });

  it('nothing found: "unknown", and says where it looked', () => {
    const { info, problems } = loadReleaseInfo({}, reader({}), FILES);
    expect(info.version).toBe('unknown');
    expect(info.source).toBe('none');
    expect(problems.at(-1)).toContain(FILES.defaultReleaseFile);
    expect(problems.at(-1)).toContain(FILES.rootPackageJson);
  });

  it.each([
    ['not JSON', '{version: 1.0.0', 'not valid JSON'],
    ['an array', '[]', 'not a JSON object'],
    ['no version', JSON.stringify({ build: 1 }), '"version" is missing'],
    ['a blank version', JSON.stringify({ version: '  ' }), '"version" is missing'],
    ['a fractional build', JSON.stringify({ version: '1.0.0', build: 1.5 }), '"build" must be'],
    ['a negative build', JSON.stringify({ version: '1.0.0', build: -1 }), '"build" must be'],
    ['a string build', JSON.stringify({ version: '1.0.0', build: '57' }), '"build" must be'],
  ])('a malformed release.json (%s) is a problem, never a crash, and the next source answers', (_name, text, expected) => {
    const { info, problems } = loadReleaseInfo(
      {},
      reader({ [FILES.defaultReleaseFile]: text, [FILES.rootPackageJson]: JSON.stringify({ version: '1.0.0' }) }),
      FILES,
    );
    expect(info.source).toBe('package.json');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(expected);
  });

  it('a read error other than "missing" is reported', () => {
    const readFile = (file: string) => {
      if (file === FILES.defaultReleaseFile) {
        const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return enoent(file);
    };
    const { info, problems } = loadReleaseInfo({}, readFile, FILES);
    expect(info.version).toBe('unknown');
    expect(problems[0]).toContain('EACCES');
  });

  it('the default paths resolve to this checkout: runtime/release.json beside apps/, and the root package.json', () => {
    // From apps/api/src/lib: three levels up is apps/ (where an installed runtime keeps
    // release.json beside api/), four is the repository root.
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
    expect(DEFAULT_RELEASE_FILES.defaultReleaseFile).toBe(path.join(repoRoot, 'apps', 'release.json'));
    expect(DEFAULT_RELEASE_FILES.rootPackageJson).toBe(path.join(repoRoot, 'package.json'));
    // And the real root package.json carries the version this checkout reports.
    const rootVersion = JSON.parse(fs.readFileSync(DEFAULT_RELEASE_FILES.rootPackageJson, 'utf8')).version;
    expect(loadReleaseInfo({}).info.version).toBe(`${rootVersion}-dev`);
  });
});
