import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import { type FastifyInstance } from 'fastify';
import { buildApp } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { DEFAULT_RELEASE_FILES } from '../lib/release-info.js';

// The version a checkout reports: the root package.json's, marked -dev (lib/release-info.ts).
const ROOT_VERSION: string = JSON.parse(fs.readFileSync(DEFAULT_RELEASE_FILES.rootPackageJson, 'utf8')).version;

describe('Health endpoint', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/health returns 200 with status, database, job runner and the running release', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
    expect(body.db).toBe('connected');
    expect(body.jobRunner).toBe('starting'); // the e2e app starts no job runner
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
    // Declared in the response schema, or Fastify would drop them (lib/health-route.ts).
    expect(body.version).toBe(`${ROOT_VERSION}-dev`);
    expect(body).toHaveProperty('build', null); // null, not 0, from a checkout
    // The commit is for the authenticated System Health page only.
    expect(body).not.toHaveProperty('commit');
  });

  it('health check requires no authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
  });

  it('a database that does not answer is a 503 that still names the version', async () => {
    const spy = vi.spyOn(prisma, '$queryRaw').mockRejectedValueOnce(new Error('connection terminated'));
    try {
      const res = await app.inject({ method: 'GET', url: '/api/health' });
      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({ status: 'error', db: 'disconnected', version: `${ROOT_VERSION}-dev`, build: null });
      expect(body).not.toHaveProperty('jobRunner');
    } finally {
      spy.mockRestore();
    }
  });
});
