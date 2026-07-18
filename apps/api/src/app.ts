import 'dotenv/config';
import Fastify from 'fastify';
import fs from 'node:fs';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerSwagger } from './lib/swagger.js';
import authPlugin from './plugins/auth.js';
import rbacPlugin from './plugins/rbac.js';
import superAdminRoutes from "./modules/super-admin/routes.js";
import reportReviewRoutes from "./modules/report-reviews/routes.js";
import stageApprovalRoutes from "./modules/stage-approvals/routes.js";
import debugTraceRoutes from "./modules/debug-traces/routes.js";
import ldapRoutes from "./modules/ldap/routes.js";
import dashboardRoutes from "./modules/dashboards/routes.js";
import authRoutes from './modules/auth/routes.js';
import userRoutes from './modules/users/routes.js';
import configRoutes from './modules/config/routes.js';
import { discoverAndRegisterConfigs } from './lib/config-discovery.js';
import dynamicConfigRoutes from './modules/config/dynamic-routes.js';
import auditRoutes from './modules/audit/routes.js';
import uploadRoutes from './modules/uploads/routes.js';
import { UPLOADS_ROOT } from './lib/uploads-dir.js';
import notificationRoutes from './modules/notifications/routes.js';
import roleRoutes from './modules/roles/routes.js';
import backupRoutes from './modules/backup/routes.js';
import assetRoutes from './modules/assets/index.js';
import helpRoutes from './modules/help/routes.js';
import systemHealthRoutes, { trackRequest } from './modules/system-health/routes.js';

// operation-tracer removed — wrote to ts_pipeline_traces which is being dropped.
// To be repurposed against filter_events / pm_executions / admin_requests in a
// dedicated TraceSource framework (see runbook Section 14).


import notificationDeliveryRoutes from './modules/notification-delivery/routes.js';
import userGroupRoutes from './modules/user-groups/routes.js';
import notificationRulesRoutes from './modules/notification-rules/routes.js';

import { notificationTask } from './workers/notification.worker.js';
import { pmOverdueCheckTask } from './workers/pm-overdue.worker.js';
import { passwordExpiryCheckTask } from './workers/password-expiry.worker.js';
import { sessionSweepTask } from './workers/session-sweep.worker.js';
import { startJobRunner, stopJobRunner } from '@digilog/queue';
import { AppError } from './lib/errors.js';
import { OfflineTimeError } from './lib/offline-time-window.js';
import { dispatchNotification } from './modules/notification-delivery/notification-dispatcher.js';
import cleaningProfileRoutes from './modules/cleaning-profiles/routes.js';import checklistProfileRoutes from './modules/checklist-profiles/routes.js';import filterProfileRoutes from './modules/filter-profiles/routes.js';
import pmScheduleRoutes from './modules/pm-schedules/routes.js';import pmExecutionRoutes from './modules/pm-schedules/execution-routes.js';import filterOperationsRoutes from './modules/filter-operations/routes.js';import filterEventsRoutes from './modules/filter-operations/events-routes.js';
import replacementScheduleRoutes from './modules/replacement-schedule/routes.js';
import equipmentGroupRoutes from './modules/equipment-groups/routes.js';
import syncRoutes from './modules/sync/routes.js';
import deploymentCheckRoutes from './modules/deployment-check/routes.js';
import adminRequestRoutes from './modules/admin-requests/routes.js';
import blockChangeRoutes from './modules/block-change-requests/routes.js';
import hierarchyRoutes from './modules/hierarchy/routes.js';
// reportRoutes imported dynamically below

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// TLS cert location is env-overridable so the customer install can point it at
// C:\ProgramData\DigiLog\certs (data dir → survives upgrades; regenerating the CA
// on upgrade would re-break the tablet's trust). Defaults to the dev repo's
// certs/server.{key,crt} so local dev is unchanged. See EXE-PACKAGING-PLAN.md §13.
const defaultCertDir = path.resolve(__dirname, '../../../certs');
const tlsKeyPath  = process.env.TLS_KEY_PATH  ?? path.join(defaultCertDir, 'server.key');
const tlsCertPath = process.env.TLS_CERT_PATH ?? path.join(defaultCertDir, 'server.crt');
const httpsOptions = process.env.API_HTTPS === 'true'
  ? {
      key: fs.readFileSync(tlsKeyPath),
      cert: fs.readFileSync(tlsCertPath),
    }
  : null;

// May 16 H2 fix (2026-05-20): trustProxy was unconditionally 1. When the
// API serves browsers DIRECTLY (no reverse proxy in front — the local
// Windows dev setup; some appliance deployments), the "first hop" is the
// attacker's browser, and X-Forwarded-For becomes attacker-controlled.
// Result: audit-trail IP + rate-limit keys both spoofable.
//
// Only trust the X-Forwarded-* family when explicitly behind a known
// reverse proxy (set TRUST_PROXY=1 or TRUST_PROXY=<hop-count> in env).
// Default false → req.ip uses the raw socket address, attacker can't lie.
const trustProxyEnv = process.env.TRUST_PROXY;
const trustProxy = trustProxyEnv
  ? (Number.isFinite(Number(trustProxyEnv)) ? Number(trustProxyEnv) : trustProxyEnv === 'true')
  : false;

const app = Fastify({
  logger: {
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  },
  trustProxy,
  bodyLimit: 10 * 1024 * 1024, // 10 MB for base64 image uploads in checklists
  ajv: {
    customOptions: {
      keywords: ['example'],
    },
  },
  ...(httpsOptions ? { https: httpsOptions } : {}),
});

// Block dangerous HTTP methods early — before any route or plugin (audit S-11)
app.addHook('onRequest', async (req, reply) => {
  if (req.method === 'TRACE' || req.method === 'CONNECT') {
    return reply.code(405).send({ error: 'METHOD_NOT_ALLOWED' });
  }
});

// Swagger API docs (register before routes)
await registerSwagger(app);

// Core middleware
const corsOrigins = process.env.ALLOWED_ORIGINS;
if (!corsOrigins && process.env.NODE_ENV === 'production') {
  throw new Error('FATAL: ALLOWED_ORIGINS env var must be set in production');
}
await app.register(cors, {
  origin: (corsOrigins ?? 'http://localhost:5173,http://localhost:5175,https://localhost,capacitor://localhost,http://localhost').split(','),
  credentials: true,
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-reauth-password'],
});
await app.register(helmet, {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],   // Swagger UI requires unsafe-inline
      styleSrc: ["'self'", "'unsafe-inline'"],    // Swagger UI requires unsafe-inline
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  strictTransportSecurity: {
    maxAge: 31536000,        // 1 year in seconds
    includeSubDomains: true,
    preload: true,
  },
});
// Permissions-Policy — restrict browser feature APIs (audit S-10)
app.addHook('onSend', async (_req, reply, payload) => {
  reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  return payload;
});
// 2026-07-03: raised 500 → 5000/min. A single actively-used tablet fires bursts
// of SWR fetches + per-filter /current-state primes; hitting the old 500 ceiling
// returned 429s, which the client treated as "offline" and retried — a
// self-reinforcing storm that piled up failed HTTPS requests and OOM-crashed the
// WebView. Auth routes keep their own tighter per-route limits below.
await app.register(rateLimit, { max: 5000, timeWindow: '1 minute' });
await app.register(multipart, {
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB max
    files: 1,
  },
});

// Serve uploaded files. UPLOADS_ROOT honors UPLOAD_DIR (customer install points
// it at C:\ProgramData\DigiLog\uploads) — must match the photo writer in
// modules/uploads/routes.ts or served photos 404.
await app.register(fastifyStatic, {
  root: UPLOADS_ROOT,
  prefix: '/uploads/',
  decorateReply: false,
});

// Plugins
await app.register(authPlugin);
await app.register(rbacPlugin);

// Rate limiter for error notifications (max 1 per minute)
let lastErrorNotification = 0;

// Global error handler — maps AppError to HTTP responses
app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
  if (err instanceof AppError) {
    return reply.code(err.statusCode).send({
      error: err.code,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  }
  // Audit 2026-05-04 fix C2: bounded offlinePerformedAt validator. Map the
  // dedicated error class to a clean 400 with a stable error code so the
  // client knows whether to retry, re-perform the action, or contact admin.
  if (err instanceof OfflineTimeError) {
    return reply.code(400).send({
      error: err.code,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  }
  // Rate limit errors from @fastify/rate-limit
  if (err.statusCode === 429) {
    return reply.code(429).send({ error: 'TOO_MANY_REQUESTS', message: err.message });
  }
  // Body too large (e.g. base64 images in checklist submissions)
  if ((err as any).code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    const contentLength = _req.headers['content-length'];
    const sizeMB = contentLength ? (parseInt(contentLength as string) / 1024 / 1024).toFixed(1) : 'unknown';
    app.log.warn({ url: _req.url, contentLength, sizeMB }, 'Request body too large');
    return reply.code(413).send({
      error: 'BODY_TOO_LARGE',
      message: `Request body too large (${sizeMB} MB). Maximum allowed is 10 MB. Try reducing image size or quality.`,
    });
  }
  // Fastify validation errors (body/query/params schema validation)
  if ((err as any).code === 'FST_ERR_VALIDATION' || (err as any).validation) {
    return reply.code(400).send({
      error: 'VALIDATION_ERROR',
      message: err.message,
      ...(err as any).validation ? { details: (err as any).validation } : {},
    });
  }
  // Unsupported Media Type — 415 (audit API-3)
  if ((err as any).code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
    return reply.code(415).send({
      error: 'UNSUPPORTED_MEDIA_TYPE',
      message: err.message || 'Unsupported Media Type',
    });
  }
  // JSON parse errors — 400 (audit API-3)
  if (
    (err as any).code === 'FST_ERR_CTP_INVALID_JSON_BODY' ||
    (err as any).code === 'FST_ERR_CTP_EMPTY_JSON_BODY'
  ) {
    return reply.code(400).send({
      error: 'PARSE_ERROR',
      message: 'Request body is not valid JSON',
    });
  }
  // Prisma unique-constraint violation → 409 (not 500). #low-batch: the four
  // version sidecars (equipment-groups / checklist-profiles / cleaning-profiles /
  // filter-profiles) read the live version unlocked then INSERT
  // (id, versionNumber); two concurrent edits to the same record collide on the
  // unique index and the loser raises P2002. Surface it as a clean, retryable
  // conflict instead of a 500 + a spurious SYSTEM_ERROR notification. Systemic —
  // covers every current + future unique constraint.
  if ((err as any).code === 'P2002') {
    return reply.code(409).send({
      error: 'CONFLICT',
      message: 'This record was modified concurrently. Please reload and try again.',
    });
  }

  // Genuine internal errors
  app.log.error(err);
  // Dispatch SYSTEM_ERROR notification (fire-and-forget, rate-limited to 1 per minute)
  const now = Date.now();
  if (now - lastErrorNotification > 60000) {
    lastErrorNotification = now;
    dispatchNotification({
      eventType: 'SYSTEM_ERROR',
      context: {},
      variables: {
        errorType: err.constructor?.name ?? 'Error',
        errorMessage: err.message ?? 'Unknown error',
        url: _req.url ?? 'N/A',
        timestamp: new Date().toISOString(),
      },
    }).catch((dispatchErr) => {
      // Log but do not rethrow — rethrowing would re-enter the error handler
      // and cause an infinite loop (the SYSTEM_ERROR notification itself
      // failing would generate another SYSTEM_ERROR notification).
      app.log.warn(
        { dispatchErr, originalErr: err.message, url: _req.url },
        'Failed to dispatch SYSTEM_ERROR notification — original error is still returned to the caller.',
      );
    });
  }
  return reply.code(err.statusCode ?? 500).send({
    error: 'INTERNAL_ERROR',
    message: process.env.NODE_ENV === 'development' ? (err.message || 'Internal server error').substring(0, 500) : 'Internal server error',
  });
});

// Request tracking hook for system health metrics
app.addHook('onRequest', (_req, _reply, done) => {
  trackRequest();
  done();
});

// (operation-tracer onResponse/onError hooks removed — see import comment above)

// Health check
// Job-runner state, reported by /api/health. Set once at boot (below). Without
// this the runner could die at startup and the API still reported itself
// healthy, so the notification / PM-overdue / password-expiry / session sweeps
// stopped with nothing to notice it — the session sweep writes the LOGOUT audit
// rows, so its silent death is a §11 gap.
let jobRunnerStatus: 'starting' | 'running' | 'failed' = 'starting';

app.get('/api/health', {
  schema: {
    tags: ['Health'],
    summary: 'Health check',
    description: 'Returns API health status',
    security: [],
    response: {
      200: {
        type: 'object',
        properties: {
          status: { type: 'string', example: 'ok' },
          timestamp: { type: 'string', format: 'date-time' },
          // `db` was already being returned by the handler but was silently
          // dropped by fast-json-stringify because it wasn't declared here.
          db: { type: 'string', example: 'connected' },
          jobRunner: { type: 'string', example: 'running' },
        },
      },
    },
  },
}, async (_req, reply) => {
  try {
    const { prisma } = await import('./lib/prisma.js');
    await prisma.$queryRaw`SELECT 1`;
    // Deliberately still 200 when the job runner is down: the HTTP surface is
    // fine, and the tablet treats a non-2xx /api/health as "server unreachable"
    // (apps/web/src/lib/connectivity.ts probeServer) — a 503 here would flip
    // every tablet into offline mode over a background-job fault.
    return { status: 'ok', db: 'connected', jobRunner: jobRunnerStatus };
  } catch (err) {
    return reply.code(503 as any).send({ status: 'error', db: 'disconnected' });
  }
});

// Auto-discover config module definitions
await discoverAndRegisterConfigs();

// Routes
await app.register(authRoutes, { prefix: '/api/auth' });
await app.register(userRoutes, { prefix: '/api/users' });
await app.register(configRoutes, { prefix: '/api/config' });
await app.register(dynamicConfigRoutes, { prefix: '/api/config' });
await app.register(auditRoutes, { prefix: '/api/audit' });
await app.register(uploadRoutes, { prefix: '/api/uploads' });
await app.register(notificationRoutes, { prefix: '/api/notifications' });
await app.register((await import('./modules/guest/routes.js')).default, { prefix: '/api/guest' });
await app.register(roleRoutes, { prefix: '/api/roles' });
await app.register(backupRoutes, { prefix: '/api/backup' });
await app.register(assetRoutes, { prefix: '/api/assets' });

// (Data-ingestion / MQTT / transport routes were removed in Phase 7.)




await app.register(helpRoutes, { prefix: '/api/help' });
await app.register(systemHealthRoutes, { prefix: '/api/system-health' });

await app.register(notificationDeliveryRoutes, { prefix: '/api/notification-settings' });
await app.register(userGroupRoutes, { prefix: '/api/user-groups' });
await app.register(notificationRulesRoutes, { prefix: '/api/notification-rules' });

// Admin + assignment routes
await app.register(superAdminRoutes, { prefix: "/api/super-admin" });
await app.register(reportReviewRoutes, { prefix: "/api/report-reviews" });
await app.register(stageApprovalRoutes, { prefix: "/api/stage-approvals" });
await app.register(debugTraceRoutes, { prefix: "/api/debug/traces" });
await app.register(ldapRoutes, { prefix: "/api/ldap" });
await app.register(dashboardRoutes, { prefix: "/api/dashboards" });
await app.register(cleaningProfileRoutes, { prefix: '/api/filter-cleaning-profiles' });await app.register(checklistProfileRoutes, { prefix: '/api/checklist-profiles' });await app.register(filterProfileRoutes, { prefix: '/api/filter-profiles' });
await app.register(pmScheduleRoutes, { prefix: '/api/pm-schedules' });await app.register(pmExecutionRoutes, { prefix: '/api/pm-executions' });await app.register(filterOperationsRoutes, { prefix: '/api/filters' });await app.register(filterEventsRoutes, { prefix: '/api/filters' });
await app.register(equipmentGroupRoutes, { prefix: '/api/equipment-groups' });
await app.register(replacementScheduleRoutes, { prefix: '/api/replacement-schedules' });
await app.register(syncRoutes, { prefix: '/api/sync' });
await app.register(deploymentCheckRoutes, { prefix: '/api/deployment-check' });
await app.register(adminRequestRoutes, { prefix: '/api/admin-requests' });
await app.register(blockChangeRoutes, { prefix: '/api/block-change-requests' });
await app.register(hierarchyRoutes, { prefix: '/api/hierarchy' });


// ─── M1: serve the built web UI from the API (single-process bundle) ─────────
// Behind SERVE_WEB so the normal dev loop (Vite on :5175) is unaffected. When
// enabled, the API serves apps/web/dist at '/', with an SPA fallback to
// index.html for client-side (React Router) routes. This is what the packaged
// Setup.exe uses at runtime — no Vite, one `node dist/app.js` process.
// Override the build location with WEB_DIST_DIR (the installer stages it under
// the program dir). See tasks/EXE-PACKAGING-PLAN.md §5.
if (process.env.SERVE_WEB === 'true') {
  const webDir = process.env.WEB_DIST_DIR
    ? path.resolve(process.env.WEB_DIST_DIR)
    : path.resolve(__dirname, '../../web/dist');

  if (!fs.existsSync(path.join(webDir, 'index.html'))) {
    app.log.warn(
      `SERVE_WEB=true but no web build found at ${webDir} ` +
      `(run 'vite build' or set WEB_DIST_DIR). The UI will not be served.`,
    );
  } else {
    // Second @fastify/static instance — this one OWNS reply.sendFile (the
    // uploads instance above set decorateReply:false precisely so this can).
    await app.register(fastifyStatic, {
      root: webDir,
      prefix: '/',
      wildcard: false,       // serve real files; unmatched paths fall to notFound
      index: ['index.html'],
    });

    // SPA fallback: a GET that didn't match an API/docs/uploads/health route and
    // isn't a real static file returns index.html so React Router can resolve
    // the client-side path. Anything else gets a clean JSON 404 (API contract
    // preserved — unknown /api routes must NOT receive HTML).
    app.setNotFoundHandler((req, reply) => {
      const isServerRoute =
        req.url.startsWith('/api') ||
        req.url.startsWith('/uploads') ||
        req.url.startsWith('/docs') ||
        req.url.startsWith('/health');
      const wantsHtml = (req.headers.accept ?? '').includes('text/html');
      if (req.method === 'GET' && !isServerRoute && wantsHtml) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({
        error: 'NOT_FOUND',
        message: `Route ${req.method}:${req.url} not found`,
      });
    });

    app.log.info(`SERVE_WEB enabled — serving web UI from ${webDir}`);
  }
}

// Start
const port = parseInt(process.env.PORT ?? '3000', 10);
try {
  await app.listen({ port, host: '0.0.0.0' });
  const proto = httpsOptions ? 'https' : 'http';
  app.log.info(`DigiLog API running on ${proto}://localhost:${port}`);
  app.log.info(`Swagger UI: ${proto}://localhost:${port}/docs`);

  // Phase 2 — single graphile-worker Runner registers ALL task identifiers
  // and the maintenance crontab (Task 2.8). The legacy BullMQ path was
  // dropped in Task 2.10; graphile-worker is the only queue backend now.
  try {
    // crontab.txt lives at <repo>/packages/queue/crontab.txt; src/app.ts is
    // at <repo>/apps/api/src/app.ts so the relative hop is 3 dot-dots.
    // Override via MAINTENANCE_CRONTAB_PATH for non-default monorepo layouts.
    const crontabPath =
      process.env.MAINTENANCE_CRONTAB_PATH ??
      path.resolve(__dirname, '../../../packages/queue/crontab.txt');
    await startJobRunner({
      taskList: {
        
        // `notification` task handler — closes the producer/consumer gap
        // flagged in the 2026-05-12 deep review. Before this commit
        // `enqueueNotificationJob` posted to a task name with no handler
        // and jobs leaked into graphile_worker.jobs forever. See
        // apps/api/src/workers/notification.worker.ts for the mapping
        // from queue payload to `dispatchNotification` event types.
        notification: notificationTask,
        
        pm_overdue_check: pmOverdueCheckTask,
        password_expiry_check: passwordExpiryCheckTask,
        session_sweep: sessionSweepTask,
      },
      crontabPath,
    });
    jobRunnerStatus = 'running';
    app.log.info('graphile-worker job runner started');
  } catch (runnerErr) {
    // Not fatal — the HTTP surface is still usable and this is a single-process
    // local API, so exiting would take the whole app down over background jobs.
    // But it IS an error, not a warning: every scheduled job (notifications, the
    // PM-overdue sweep, password-expiry warnings, the LOGOUT-writing session
    // sweep) is dead until this is fixed. /api/health reports `jobRunner`.
    jobRunnerStatus = 'failed';
    app.log.error(
      { err: runnerErr },
      'graphile-worker job runner FAILED to start — all scheduled jobs (notifications, PM overdue, password expiry, session sweep) will not run. Server continuing.',
    );
  }
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Graceful shutdown
const shutdown = async (signal: string) => {
  app.log.info(`Received ${signal}, shutting down gracefully...`);
  const shutdownTimeout = setTimeout(() => {
    console.error('[SHUTDOWN] Timed out after 15s, forcing exit');
    process.exit(1);
  }, 15000);
  shutdownTimeout.unref();

  try {
    await stopJobRunner();

    await app.close();
    // Close queue + tsdb in their own try blocks so one failure doesn't
    // prevent the next teardown step. Each failure is logged so partial-
    // shutdown state is debuggable (CLAUDE.md "Never swallow exceptions").
    try {
      const { closeProducer } = await import('@digilog/queue');
      await closeProducer();
    } catch (qErr) {
      app.log.error({ err: qErr }, 'Shutdown: closeProducer (graphile-worker) failed');
    }
    
  } catch (err) {
    app.log.error(err as Error, 'Error during shutdown');
  }
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
