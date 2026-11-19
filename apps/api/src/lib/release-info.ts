/**
 * The release this API is running: version, CI build number, commit, build date
 * (Windows packaging plan, Phase A1 — audit 2026-11-19 N3: the application exposed
 * no version at all, so an update could not verify itself and support could not ask
 * "which version are you on?").
 *
 * Read ONCE, from the first source that answers:
 *  1. `RELEASE_INFO_PATH` — an explicit file (an override);
 *  2. `<runtime>/release.json` — both installers stage the API at
 *     `<runtime>/api/dist`, and the package build writes this file beside it. A
 *     path relative to this module rather than a new env key, because a `.deb`
 *     upgrade never adds keys to an existing env file (audit 2026-11-19 N7);
 *  3. the monorepo's root `package.json` — a checkout (development, the AWS
 *     clone): its `version` + `-dev`, so a checkout never claims to be a release;
 *  4. nothing: `unknown`.
 * A file that exists but cannot be read or is malformed is recorded in `problems`
 * (app.ts logs them at boot) and the next source is tried: a version label never
 * stops the API from starting.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRODUCT_NAME = 'T&RH Monitoring';

export type ReleaseInfoSource = 'RELEASE_INFO_PATH' | 'release.json' | 'package.json' | 'none';

export interface ReleaseInfo {
  product: string;
  /** Semantic version; `<x.y.z>-dev` from a checkout, `unknown` when nothing was found. */
  version: string;
  /** The CI run number of the build, or null (a checkout, or a local build). */
  build: number | null;
  commit: string | null;
  /** ISO date-time the package was built, or null. */
  date: string | null;
  source: ReleaseInfoSource;
}

export interface ReleaseInfoResult {
  info: ReleaseInfo;
  problems: string[];
}

export interface ReleaseInfoFiles {
  /** `<runtime>/release.json` — three levels up from `<runtime>/api/{dist,src}/lib`. */
  defaultReleaseFile: string;
  /** The monorepo root `package.json` — four levels up from `apps/api/{dist,src}/lib`. */
  rootPackageJson: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_RELEASE_FILES: ReleaseInfoFiles = {
  defaultReleaseFile: path.resolve(here, '../../../release.json'),
  rootPackageJson: path.resolve(here, '../../../../package.json'),
};

type ReadFile = (file: string) => string;
const readUtf8: ReadFile = (file) => fs.readFileSync(file, 'utf8');

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Parse a release file. Returns the problem as a string when it is not usable. */
function parseReleaseFile(text: string, source: 'RELEASE_INFO_PATH' | 'release.json'): ReleaseInfo | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return `not valid JSON (${errorText(err)})`;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'not a JSON object';
  const r = raw as Record<string, unknown>;
  if (typeof r.version !== 'string' || r.version.trim() === '') return '"version" is missing or empty';
  if (r.build !== undefined && r.build !== null && !(Number.isInteger(r.build) && (r.build as number) >= 0)) {
    return '"build" must be a non-negative integer or null';
  }
  const optionalString = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : null);
  return {
    product: optionalString(r.product) ?? PRODUCT_NAME,
    version: r.version.trim(),
    build: (r.build as number | null | undefined) ?? null,
    commit: optionalString(r.commit),
    date: optionalString(r.date),
    source,
  };
}

export function loadReleaseInfo(
  env: NodeJS.ProcessEnv = process.env,
  readFile: ReadFile = readUtf8,
  files: ReleaseInfoFiles = DEFAULT_RELEASE_FILES,
): ReleaseInfoResult {
  const problems: string[] = [];

  const explicit = env.RELEASE_INFO_PATH?.trim();
  if (explicit) {
    try {
      const parsed = parseReleaseFile(readFile(explicit), 'RELEASE_INFO_PATH');
      if (typeof parsed !== 'string') return { info: parsed, problems };
      problems.push(`RELEASE_INFO_PATH ${explicit}: ${parsed}`);
    } catch (err) {
      problems.push(`RELEASE_INFO_PATH ${explicit} could not be read: ${errorText(err)}`);
    }
  }

  try {
    const parsed = parseReleaseFile(readFile(files.defaultReleaseFile), 'release.json');
    if (typeof parsed !== 'string') return { info: parsed, problems };
    problems.push(`${files.defaultReleaseFile}: ${parsed}`);
  } catch (err) {
    // Absent in every checkout — expected, not a problem.
    if (!isMissing(err)) problems.push(`${files.defaultReleaseFile} could not be read: ${errorText(err)}`);
  }

  try {
    const pkg = JSON.parse(readFile(files.rootPackageJson)) as { version?: unknown };
    if (typeof pkg.version === 'string' && pkg.version.trim() !== '') {
      return {
        info: { product: PRODUCT_NAME, version: `${pkg.version.trim()}-dev`, build: null, commit: null, date: null, source: 'package.json' },
        problems,
      };
    }
    problems.push(`${files.rootPackageJson} has no "version"`);
  } catch (err) {
    if (!isMissing(err)) problems.push(`${files.rootPackageJson} could not be read: ${errorText(err)}`);
  }

  problems.push(
    `no release information found (looked for RELEASE_INFO_PATH, ${files.defaultReleaseFile}, ${files.rootPackageJson}); the version is reported as "unknown"`,
  );
  return {
    info: { product: PRODUCT_NAME, version: 'unknown', build: null, commit: null, date: null, source: 'none' },
    problems,
  };
}

let cached: ReleaseInfoResult | undefined;

function load(): ReleaseInfoResult {
  cached ??= loadReleaseInfo();
  return cached;
}

/** The running release, read once per process. */
export function releaseInfo(): ReleaseInfo {
  return load().info;
}

/** Why the preferred sources were not used (logged once at boot). Empty when all is well. */
export function releaseInfoProblems(): string[] {
  return load().problems;
}
