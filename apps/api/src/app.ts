import 'dotenv/config';
import Fastify from 'fastify';
import fs from 'node:fs';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerSwagger } from './lib/swagger.js';
import authPlugin from './plugins/auth.js';
import rbacPlugin from './plugins/rbac.js';
import superAdminRoutes from "./modules/super-admin/routes.js";
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
import helpRoutes from './modules/help/routes.js';
import systemHealthRoutes, { trackRequest } from './modules/system-health/routes.js';

// operation-tracer removed — wrote to ts_pipeline_traces which is being dropped.
// To be repurposed against admin_requests / instrument events in a
// dedicated TraceSource framework (see runbook Section 14).


import notificationDeliveryRoutes from './modules/notification-delivery/routes.js';
import userGroupRoutes from './modules/user-groups/routes.js';
import notificationRulesRoutes from './modules/notification-rules/routes.js';

import { notificationTask } from './workers/notification.worker.js';
import { passwordExpiryCheckTask } from './workers/password-expiry.worker.js';
import { sessionSweepTask } from './workers/session-sweep.worker.js';
import { telemetryPartitionTask } from './workers/telemetry-partition.worker.js';
import { startJobRunner, stopJobRunner } from '@digilog/queue';
import { AppError, prismaErrorToResponse } from './lib/errors.js';
import { dispatchNotification } from './modules/notification-delivery/notification-dispatcher.js';
import adminRequestRoutes from './modules/admin-requests/routes.js';
import floorplanRoutes from './modules/floorplans/routes.js';
import { alarmEvaluationTask } from './workers/alarm-evaluation.worker.js';
import { alarmWebhookTask } from './workers/alarm-webhook.worker.js';
import functionalLocationRoutes from './modules/functional-locations/routes.js';
import alarmRoutes from './modules/alarms/routes.js';
import alarmWebhookRoutes from './modules/alarm-webhooks/routes.js';
import reportReviewRoutes from './modules/report-reviews/routes.js';
import ingestRoutes from './modules/instruments/ingest-routes.js';
import wsIngestRoutes from './modules/instruments/listeners/ws-listener.js';
import mqttAuthRoutes from './modules/instruments/mqtt-auth-routes.js';
import instrumentProfileRoutes from './modules/instrument-profiles/routes.js';
import instrumentRoutes from './modules/instruments/routes.js';
import { startTcpListener, type TcpListenerHandle } from './modules/instruments/listeners/tcp-listener.js';
import { startMqttBridge, plaintextRemoteBrokerWarning, type MqttBridgeHandle } from './modules/instruments/listeners/mqtt-bridge.js';
import { setDownlinkPublisher } from './modules/instruments/attribute-downlink.js';
import { startRtcTicker } from './modules/instruments/listeners/rtc-sync.js';

/** The RTC 10-minute tick (2026-09-05) — alive only while the bridge is. */
let rtcTicker: { stop(): void } | null = null;
import { logger, attachLogger } from './lib/logger.js';

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
  bodyLimit: 10 * 1024 * 1024, // 10 MB for base64 image uploads
  ajv: {
    customOptions: {
      keywords: ['example'],
    },
  },
  ...(httpsOptions ? { https: httpsOptions } : {}),
});

// Point lib/logger.ts at Fastify's pino instance (audit M5). Until this runs —
// in graphile-worker tasks, in scripts, and during module top-level evaluation
// — `logger` writes JSON to stdout at the same configured level. After it, the
// ~40 sites that used to call console.* directly share one logger with the ~38
// that used app.log, so a single stream carries one format and honours one
// level setting.
attachLogger(app.log);

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
  // Dev fallback only — the guard above THROWS in production if
  // ALLOWED_ORIGINS is unset, so this list can never apply there.
  // 2026-08-29 (audit L2): dropped `capacitor://localhost`, a leftover of the
  // Capacitor mobile app that does not exist in this fork, and added 5176 —
  // this repo's actual web port (see the root CLAUDE.md "Key Local URLs";
  // 5175 belongs to the sibling DigiLog checkout). A developer running
  // `npx vite` without start-app.bat previously got a CORS failure whose
  // cause was two files away.
  origin: (corsOrigins ?? 'http://localhost:5173,http://localhost:5175,http://localhost:5176,https://localhost,http://localhost').split(','),
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
// WebSocket support, re-added 2026-08-06 for the device ingest upgrade endpoint
// (`/api/ingest/v1/ws`). It was stripped as dead code in 2026-07 when the last
// pub/sub consumer went; it is LOAD-BEARING again — see ws-listener.ts.
// `maxPayload` is the library's memory backstop on fragment reassembly,
// deliberately far ABOVE the listener's own 64 KB frame cap: set to the same
// value, `ws` would close the connection first and the handler's cap (which is
// what bounds the gateway batch path) would never run.
await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

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

// Rate limiter for error notifications (max 1 per minute).
//
// ⚠ SINGLE-INSTANCE STATE (audit L4). This counter, and the alarm-webhook
// cooldown map in modules/alarm-webhooks/, are module-level variables. They are
// correct for the ONE api process this system is deployed as (a Windows service
// per host, see docs/deployment-methods/build-sheet.md) and silently wrong the
// moment a second instance runs: N instances means N error notifications per
// minute, and N buzzer fires per cooldown window.
//
// This is a deliberate accepted constraint, not an oversight. Moving it to
// Postgres would be straightforward — an advisory lock or a
// `last_fired_at` row — and is the FIRST thing to do if horizontal scaling is
// ever wanted. Written here rather than in a design doc because this is the
// line someone will be looking at when they wonder why the alerts doubled.
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
  // Rate limit errors from @fastify/rate-limit
  if (err.statusCode === 429) {
    return reply.code(429).send({ error: 'TOO_MANY_REQUESTS', message: err.message });
  }
  // Body too large (e.g. base64 image uploads)
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
  // Prisma client errors we translate rather than 500 — P2002 (unique
  // collision → retryable 409) and P2023 (malformed identifier → 400).
  // Systemic: covers every current and future constraint / uuid column.
  // Shared with src/e2e/test-helper.ts so the harness and the real server
  // cannot drift on what a given Prisma failure looks like to a client.
  const prismaMapped = prismaErrorToResponse(err);
  if (prismaMapped) {
    return reply.code(prismaMapped.status).send(prismaMapped.body);
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
await app.register(roleRoutes, { prefix: '/api/roles' });
await app.register(backupRoutes, { prefix: '/api/backup' });

// (Data-ingestion / MQTT / transport routes were removed in Phase 7.)




await app.register(helpRoutes, { prefix: '/api/help' });
await app.register(systemHealthRoutes, { prefix: '/api/system-health' });

await app.register(notificationDeliveryRoutes, { prefix: '/api/notification-settings' });
await app.register(userGroupRoutes, { prefix: '/api/user-groups' });
await app.register(notificationRulesRoutes, { prefix: '/api/notification-rules' });

// Admin + assignment routes
await app.register(superAdminRoutes, { prefix: "/api/super-admin" });
await app.register(debugTraceRoutes, { prefix: "/api/debug/traces" });
await app.register(ldapRoutes, { prefix: "/api/ldap" });
await app.register(dashboardRoutes, { prefix: "/api/dashboards" });
await app.register(adminRequestRoutes, { prefix: '/api/admin-requests' });
// Floorplans + rooms. NOT under /api/dashboards — that prefix is the widget
// dashboard module, and a second unrelated dashboard route tree there would be
// a trap for the next reader.
await app.register(floorplanRoutes, { prefix: '/api/floorplans' });
await app.register(functionalLocationRoutes, { prefix: '/api/functional-locations' });
await app.register(alarmRoutes, { prefix: '/api/alarms' });
await app.register(alarmWebhookRoutes, { prefix: '/api/alarm-webhooks' });
// Report review workflow (2026-09-07): every PDF download is a request.
await app.register(reportReviewRoutes, { prefix: '/api/report-reviews' });
await app.register(ingestRoutes, { prefix: '/api/ingest/v1' });
// Same device-token credential, over a WebSocket upgrade instead of a POST.
// Also on the auth-hook allowlist (plugins/auth.ts) — the upgrade request runs
// through the onRequest hook like any other GET.
await app.register(wsIngestRoutes, { prefix: '/api/ingest/v1' });
// The hook EMQX calls at MQTT CONNECT. Same device token, presented as the MQTT
// username; also on the auth-hook allowlist, since the caller is the broker and
// has no user JWT. See mqtt-auth-routes.ts for the clientid<->token binding it
// enforces, which is what makes the broker's topic ACL meaningful.
await app.register(mqttAuthRoutes, { prefix: '/api/ingest/v1' });
// Operator-facing registry. Unlike /api/ingest/v1 above, this one is behind the
// global auth hook and permission-gated — it is NOT on the public allowlist.
await app.register(instrumentProfileRoutes, { prefix: '/api/instrument-profiles' });
await app.register(instrumentRoutes, { prefix: '/api/instruments' });


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

        password_expiry_check: passwordExpiryCheckTask,
        session_sweep: sessionSweepTask,

        // Telemetry partition maintenance. NOT housekeeping: an insert whose
        // `ts` falls outside every partition of instrument_telemetry_history is
        // REJECTED by Postgres, so without a future partition device ingestion
        // stops dead at 00:00 on the 1st. Runs ahead by several months so one
        // missed run cannot cause that.
        telemetry_partition_maintenance: telemetryPartitionTask,

        // Alarm evaluation — every minute. Raises and clears alarms from the
        // configurable rules. Registered HERE and in packages/queue/crontab.txt
        // together: that file warns that an identifier with no handler is enqueued
        // and never completed, which once left 51,798 orphan jobs.
        alarm_evaluation: alarmEvaluationTask,

        // Alarm webhook annunciator — event-driven, NOT cron. Enqueued by the alarm
        // evaluator and the acknowledge route. Retry is bounded inside the task, so
        // this is enqueued with maxAttempts: 1: a buzzer that sounds twenty minutes
        // late announces a condition that no longer exists.
        alarm_webhook: alarmWebhookTask,
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

// ─── Raw-TCP ingest listener ─────────────────────────────────────────────────
// Opt-in ONLY. A telemetry port silently opening on an operator's machine
// because they upgraded is a surprise, so an unset INGEST_TCP_PORT means no
// listener at all — the gate lives here rather than inside startTcpListener so
// tests can bind an ephemeral port without touching process.env.
let tcpListener: TcpListenerHandle | null = null;
const tcpPortEnv = process.env.INGEST_TCP_PORT;
if (tcpPortEnv) {
  const tcpPort = Number(tcpPortEnv);
  if (!Number.isInteger(tcpPort) || tcpPort < 1 || tcpPort > 65535) {
    app.log.error(`INGEST_TCP_PORT="${tcpPortEnv}" is not a valid port — TCP ingest not started.`);
  } else {
    try {
      tcpListener = await startTcpListener(tcpPort, {
        log: (msg, meta) => app.log.warn(meta ?? {}, msg),
      });
      app.log.info(`TCP ingest listener on tcp://0.0.0.0:${tcpListener.port}`);
    } catch (tcpErr) {
      // Not fatal: the HTTP ingest surface is unaffected, and killing the whole
      // API over a busy port would be a worse outage than the one it reports.
      app.log.error({ err: tcpErr }, 'TCP ingest listener FAILED to start — devices on that transport cannot report.');
    }
  }
}

// ─── MQTT ingest bridge ──────────────────────────────────────────────────────
// Opt-in ONLY, exactly like the TCP port above: an unset MQTT_BROKER_URL means
// no outbound connection is attempted at all. The broker must be configured
// with the device auth hook AND the per-clientid topic ACL described in
// mqtt-bridge.ts — without the ACL, any valid device token can publish any
// instrument's telemetry.
let mqttBridge: MqttBridgeHandle | null = null;
const mqttBrokerUrl = process.env.MQTT_BROKER_URL;
if (mqttBrokerUrl) {
  // The bridge's subscription hop is plaintext by design ON LOOPBACK ONLY —
  // it carries the bridge's own broker credential, never a device token. Off
  // loopback that reasoning collapses, and it used to collapse silently.
  // WARN, never refuse: a LAN broker on purpose is legitimate, and blocking
  // boot over a config preference would be the wrong trade.
  const brokerHopWarning = plaintextRemoteBrokerWarning(mqttBrokerUrl);
  if (brokerHopWarning) {
    app.log.warn(`[ingest:mqtt] INSECURE BROKER HOP — ${brokerHopWarning}`);
  }
  try {
    mqttBridge = await startMqttBridge(mqttBrokerUrl, {
      log: (msg, meta) => app.log.warn(meta ?? {}, `[ingest:mqtt] ${msg}`),
      clientOptions: {
        ...(process.env.MQTT_USERNAME ? { username: process.env.MQTT_USERNAME } : {}),
        ...(process.env.MQTT_PASSWORD ? { password: process.env.MQTT_PASSWORD } : {}),
      },
    });
    // DOWNLINK: attribute changes go out on this same connection. Installed
    // only once the bridge exists, so an install with no broker keeps the
    // publisher null and attribute edits behave exactly as they did before the
    // downlink path was added.
    const bridge = mqttBridge;
    setDownlinkPublisher((topic, payload, publishOpts) => bridge.publish(topic, payload, publishOpts));
    // RTC sync (2026-09-05): the UTC time on `digilog/rtc/time` every 10
    // minutes, on the boundary, asked or not — through the same publisher. Started here,
    // after the publisher exists, and stopped before the bridge closes.
    rtcTicker = startRtcTicker();
    app.log.info(`MQTT ingest bridge connecting to ${mqttBrokerUrl}`);
  } catch (mqttErr) {
    // Not fatal: the other ingest surfaces are unaffected, and the bridge
    // retries in the background anyway.
    app.log.error({ err: mqttErr }, 'MQTT ingest bridge FAILED to start — devices on that transport cannot report.');
  }
}

// Graceful shutdown
const shutdown = async (signal: string) => {
  app.log.info(`Received ${signal}, shutting down gracefully...`);
  const shutdownTimeout = setTimeout(() => {
    logger.error('[SHUTDOWN] Timed out after 15s, forcing exit');
    process.exit(1);
  }, 15000);
  shutdownTimeout.unref();

  try {
    await stopJobRunner();

    // Before app.close(): net.Server.close() only stops ACCEPTING, so the
    // listener destroys its open sockets itself — a long-lived telemetry
    // connection would otherwise keep the process alive to the 15s force-exit.
    if (tcpListener) {
      try {
        await tcpListener.close();
      } catch (tcpErr) {
        app.log.error({ err: tcpErr }, 'Shutdown: TCP ingest listener close failed');
      }
    }

    // Same reason: an open MQTT socket with a reconnect timer keeps the process
    // alive to the 15s force-exit.
    if (mqttBridge) {
      // Before the close: a publisher pointing at a torn-down bridge would make
      // every subsequent attribute write wait out the downlink timeout.
      rtcTicker?.stop();
      setDownlinkPublisher(null);
      try {
        await mqttBridge.close();
      } catch (mqttErr) {
        app.log.error({ err: mqttErr }, 'Shutdown: MQTT ingest bridge close failed');
      }
    }

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
