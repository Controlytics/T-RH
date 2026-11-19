/**
 * `GET /api/health` — the unauthenticated liveness probe of the deploy script, both
 * installers, the update and the health-check tool (its PUBLIC_PATHS entry is
 * required). Registered by app.ts AND by the e2e test helper, so the tests exercise
 * this route rather than a stand-in (until 2026-11-19 the helper defined its own
 * `{status, timestamp}` route and nothing tested this one).
 *
 * Reports the running release's `version` and `build` (Windows packaging plan, Phase
 * A1): an update verifies itself by reading them after it restarts the API, without a
 * login. This makes the version visible to anyone who can reach the port — accepted
 * for that reason (design 2026-11-19 §1); the commit stays on the authenticated
 * System Health page.
 */
import type { FastifyInstance } from 'fastify';
import { prisma } from './prisma.js';
import { releaseInfo } from './release-info.js';

export type JobRunnerStatus = 'starting' | 'running' | 'failed';

export interface HealthRouteOptions {
  /** Read on every request; app.ts sets it as the job runner starts and fails. */
  jobRunnerStatus: () => JobRunnerStatus;
}

const releaseProps = {
  version: { type: 'string', example: '1.0.0' },
  // A null build (a checkout, a local build) must stay null on the wire: a plain
  // `integer` would serialise it as 0. `nullable` (not a type array) is what an
  // OpenAPI 3.0 document — lib/swagger.ts emits 3.0.3 — can express.
  build: { type: 'integer', nullable: true, example: 57 },
} as const;

export function registerHealthRoute(app: FastifyInstance, opts: HealthRouteOptions): void {
  app.get('/api/health', {
    // The reserved database pool (performance audit 2026-11-17, P-04): the deploy and
    // installer probe must answer while heavy reads hold every general connection.
    config: { dbPool: 'critical' },
    schema: {
      tags: ['Health'],
      summary: 'Health check',
      description: 'API, database and job-runner status, and the running release (version, build).',
      security: [],
      response: {
        // Fastify drops any field not declared here — every field the handler returns is.
        200: {
          type: 'object',
          properties: {
            status: { type: 'string', example: 'ok' },
            timestamp: { type: 'string', format: 'date-time' },
            ...releaseProps,
            db: { type: 'string', example: 'connected' },
            jobRunner: { type: 'string', enum: ['starting', 'running', 'failed'], example: 'running' },
          },
        },
        503: {
          type: 'object',
          properties: {
            status: { type: 'string', example: 'error' },
            timestamp: { type: 'string', format: 'date-time' },
            ...releaseProps,
            db: { type: 'string', example: 'disconnected' },
          },
        },
      },
    },
  }, async (req, reply) => {
    const { version, build } = releaseInfo();
    const timestamp = new Date().toISOString();
    try {
      await prisma.$queryRaw`SELECT 1`;
      // Deliberately still 200 when the job runner is down: the HTTP surface is fine,
      // and every probe that cares (installers, update, health check) reads `jobRunner`.
      return { status: 'ok', timestamp, version, build, db: 'connected', jobRunner: opts.jobRunnerStatus() };
    } catch (err) {
      req.log.warn({ err }, 'health check: the database did not answer');
      return reply.code(503).send({ status: 'error', timestamp, version, build, db: 'disconnected' });
    }
  });
}
