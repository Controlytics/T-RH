import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { registerSwagger } from '../lib/swagger.js';
import authPlugin from '../plugins/auth.js';
import rbacPlugin from '../plugins/rbac.js';
import authRoutes from '../modules/auth/routes.js';
import userRoutes from '../modules/users/routes.js';
import configRoutes from '../modules/config/routes.js';
import { discoverAndRegisterConfigs } from '../lib/config-discovery.js';
import dynamicConfigRoutes from '../modules/config/dynamic-routes.js';
import auditRoutes from '../modules/audit/routes.js';
import uploadRoutes from '../modules/uploads/routes.js';
import roleRoutes from '../modules/roles/routes.js';
import notificationRoutes from '../modules/notifications/routes.js';
import notificationDeliveryRoutes from '../modules/notification-delivery/routes.js';
import notificationRulesRoutes from '../modules/notification-rules/routes.js';
import userGroupRoutes from '../modules/user-groups/routes.js';
import backupRoutes from '../modules/backup/routes.js';
import helpRoutes from '../modules/help/routes.js';
import systemHealthRoutes from '../modules/system-health/routes.js';
import superAdminRoutes from '../modules/super-admin/routes.js';
import debugTraceRoutes from '../modules/debug-traces/routes.js';
import ldapRoutes from '../modules/ldap/routes.js';
import dashboardRoutes from '../modules/dashboards/routes.js';
import adminRequestRoutes from '../modules/admin-requests/routes.js';
import communicationProfileRoutes from '../modules/communication-profiles/routes.js';
import hierarchyRoutes from '../modules/hierarchy/routes.js';
import gatewayRoutes from '../modules/gateways/routes.js';
import instrumentRoutes from '../modules/instruments/routes.js';
import dataInjectionRoutes, { instrumentTelemetryRoutes } from '../modules/data-injection/routes.js';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/errors.js';

/** Default admin password used in tests */
export const ADMIN_PASSWORD = 'Admin@123';

/**
 * Build a Fastify instance for integration testing.
 * Uses app.inject() — no actual HTTP server is started.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false, // quiet during tests
    ajv: {
      customOptions: {
        keywords: ['example'],
      },
    },
  });

  // Swagger — mirrors app.ts ("register before routes"). Needed so
  // app.swagger() reflects the full registered route surface for
  // route-parity checking (src/e2e/route-parity.test.ts).
  await registerSwagger(app);

  await app.register(cors, { origin: true, credentials: true });
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

  // Plugins
  await app.register(authPlugin);
  await app.register(rbacPlugin);

  // Global error handler — matches production app.ts behavior
  // Must be set before routes so child contexts inherit it
  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({
        error: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      });
    }
    if (err.statusCode === 429) {
      return reply.code(429).send({ error: 'TOO_MANY_REQUESTS', message: err.message });
    }
    const status = err.statusCode ?? 500;
    return reply.code(status).send({ error: err.message || 'Internal Server Error' });
  });

  // Health check
  app.get('/api/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  // Auto-discover config module definitions (needed by dynamicConfigRoutes,
  // mirrors app.ts's `await discoverAndRegisterConfigs()` before routes).
  await discoverAndRegisterConfigs();

  // Routes — mirrors the full registration list in app.ts (minus CORS/helmet/
  // rate-limit/static hardening, which don't affect the route surface) so
  // app.swagger().paths reflects every real API route for parity checking.
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(userRoutes, { prefix: '/api/users' });
  await app.register(configRoutes, { prefix: '/api/config' });
  await app.register(dynamicConfigRoutes, { prefix: '/api/config' });
  await app.register(auditRoutes, { prefix: '/api/audit' });
  await app.register(uploadRoutes, { prefix: '/api/uploads' });
  await app.register(notificationRoutes, { prefix: '/api/notifications' });
  await app.register(roleRoutes, { prefix: '/api/roles' });
  await app.register(backupRoutes, { prefix: '/api/backup' });
  await app.register(helpRoutes, { prefix: '/api/help' });
  await app.register(systemHealthRoutes, { prefix: '/api/system-health' });
  await app.register(notificationDeliveryRoutes, { prefix: '/api/notification-settings' });
  await app.register(userGroupRoutes, { prefix: '/api/user-groups' });
  await app.register(notificationRulesRoutes, { prefix: '/api/notification-rules' });
  await app.register(superAdminRoutes, { prefix: '/api/super-admin' });
  await app.register(debugTraceRoutes, { prefix: '/api/debug/traces' });
  await app.register(ldapRoutes, { prefix: '/api/ldap' });
  await app.register(dashboardRoutes, { prefix: '/api/dashboards' });
  await app.register(adminRequestRoutes, { prefix: '/api/admin-requests' });
  await app.register(communicationProfileRoutes, { prefix: '/api/communication-profiles' });
  await app.register(hierarchyRoutes, { prefix: '/api/hierarchy' });
  await app.register(gatewayRoutes, { prefix: '/api/gateways' });
  await app.register(instrumentRoutes, { prefix: '/api/instruments' });
  // Telemetry reads mount under the SAME /api/instruments prefix.
  await app.register(instrumentTelemetryRoutes, { prefix: '/api/instruments' });
  await app.register(dataInjectionRoutes, { prefix: '/api/data-injection' });

  await app.ready();
  return app;
}

/**
 * Login as a user and return the JWT token.
 */
export async function loginAs(
  app: FastifyInstance,
  username = 'admin',
  password = ADMIN_PASSWORD,
): Promise<string> {
  // Ensure user can login: clear forcePasswordChange and terminate ALL sessions
  const user = await prisma.user.findUnique({ where: { username } });
  if (user) {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        forcePasswordChange: false,
        isTemporaryPassword: false,
        status: 'ENABLED',
        failedLoginAttempts: 0,
        lockedAt: null,
        lockoutUntil: null,
      },
    });
  }

  // Terminate ALL active sessions for this user (handles parallel test processes)
  await prisma.session.updateMany({
    where: { user: { username }, isActive: true },
    data: { isActive: false, terminationReason: 'test_cleanup' },
  });

  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });

  const body = JSON.parse(res.body);

  // Retry once if SESSION_CONFLICT (race condition with parallel tests)
  if (body.error === 'SESSION_CONFLICT') {
    await prisma.session.updateMany({
      where: { user: { username }, isActive: true },
      data: { isActive: false, terminationReason: 'test_cleanup' },
    });
    const retry = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username, password },
    });
    const retryBody = JSON.parse(retry.body);
    if (!retryBody.token) {
      throw new Error(`Login failed for ${username} (retry): ${retry.body}`);
    }
    return retryBody.token;
  }

  if (!body.token) {
    throw new Error(`Login failed for ${username}: ${res.body}`);
  }
  return body.token;
}

/**
 * Obtain an offline-replay grant token. Used by suites that need to replay
 * via the new HMAC-token mechanism (audit 2026-05-04 fix C1) — replaces the
 * previous bare `x-offline-replay: true` header bypass.
 */
export async function obtainOfflineGrant(
  app: FastifyInstance,
  token: string,
  password = ADMIN_PASSWORD,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/offline-grant',
    headers: { authorization: `Bearer ${token}` },
    payload: { _currentPassword: password },
  });
  if (res.statusCode !== 200) {
    throw new Error(`Failed to obtain offline-replay grant: ${res.statusCode} ${res.body}`);
  }
  return JSON.parse(res.body).token;
}

/**
 * Make an authenticated GET request.
 */
export async function authGet(app: FastifyInstance, url: string, token: string) {
  return app.inject({
    method: 'GET',
    url,
    headers: { authorization: `Bearer ${token}` },
  });
}

/**
 * Make an authenticated POST request with optional reauth password.
 */
export async function authPost(
  app: FastifyInstance,
  url: string,
  token: string,
  payload?: unknown,
  reauthPassword?: string,
) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (reauthPassword) {
    headers['x-reauth-password'] = reauthPassword;
  }
  return app.inject({
    method: 'POST',
    url,
    headers,
    payload: payload as Record<string, unknown>,
  });
}

/**
 * Make an authenticated PUT request with optional reauth password.
 */
export async function authPut(
  app: FastifyInstance,
  url: string,
  token: string,
  payload?: unknown,
  reauthPassword?: string,
) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (reauthPassword) {
    headers['x-reauth-password'] = reauthPassword;
  }
  return app.inject({
    method: 'PUT',
    url,
    headers,
    payload: payload as Record<string, unknown>,
  });
}

/**
 * Make an authenticated DELETE request with optional reauth password.
 */
export async function authDelete(
  app: FastifyInstance,
  url: string,
  token: string,
  reauthPassword?: string,
  payload?: unknown,
) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (reauthPassword) {
    headers['x-reauth-password'] = reauthPassword;
  }
  return app.inject({
    method: 'DELETE',
    url,
    headers,
    // Some DELETE routes carry a body (e.g. audit delete requires a `reason`).
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}
