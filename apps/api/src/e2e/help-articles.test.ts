import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import authPlugin from '../plugins/auth.js';
import rbacPlugin from '../plugins/rbac.js';
import authRoutes from '../modules/auth/routes.js';
import helpRoutes from '../modules/help/routes.js';
import { prisma } from '../lib/prisma.js';

const ADMIN_PASSWORD = 'Admin@123';

/**
 * Build a Fastify instance with auth + help routes for integration testing.
 */
async function buildHelpApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    ajv: { customOptions: { keywords: ['example'] } },
  });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

  // Plugins
  await app.register(authPlugin);
  await app.register(rbacPlugin);

  // Routes
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(helpRoutes, { prefix: '/api/help' });

  await app.ready();
  return app;
}

/**
 * Login as a user and return the JWT token.
 */
async function loginAs(
  app: FastifyInstance,
  username = 'admin',
  password = ADMIN_PASSWORD,
): Promise<string> {
  // Ensure user can login
  await prisma.user.updateMany({
    where: { username },
    data: {
      forcePasswordChange: false,
      isTemporaryPassword: false,
      status: 'ENABLED',
      failedLoginAttempts: 0,
      lockedAt: null,
      lockoutUntil: null,
    },
  });
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

  // Retry on SESSION_CONFLICT (race with parallel tests)
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

function authGet(app: FastifyInstance, url: string, token: string) {
  return app.inject({
    method: 'GET',
    url,
    headers: { authorization: `Bearer ${token}` },
  });
}

function authPost(app: FastifyInstance, url: string, token: string, payload?: unknown) {
  return app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${token}` },
    payload: payload as Record<string, unknown>,
  });
}

function authPut(app: FastifyInstance, url: string, token: string, payload?: unknown) {
  return app.inject({
    method: 'PUT',
    url,
    headers: { authorization: `Bearer ${token}` },
    payload: payload as Record<string, unknown>,
  });
}

function authDelete(app: FastifyInstance, url: string, token: string) {
  return app.inject({
    method: 'DELETE',
    url,
    headers: { authorization: `Bearer ${token}` },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const SUFFIX = Date.now().toString(36);

describe('Help Articles E2E', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let createdArticleId: string;
  const uniqueKey = `test-article-${SUFFIX}`;

  beforeAll(async () => {
    app = await buildHelpApp();
    adminToken = await loginAs(app);
  });

  afterAll(async () => {
    await app.close();
  });

  // 1. GET /api/help - returns array of articles
  describe('GET /api/help', () => {
    it('returns an array of articles', async () => {
      const res = await authGet(app, '/api/help', adminToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Array.isArray(body)).toBe(true);
    });
  });

  // 6. POST /api/help - creates article (need this before filter/search tests)
  describe('POST /api/help', () => {
    it('creates a help article', async () => {
      const res = await authPost(app, '/api/help', adminToken, {
        key: uniqueKey,
        title: 'Test Article for Password Policy',
        content: 'This article explains password requirements and policies.',
        category: 'Getting Started',
        sortOrder: 10,
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.id).toBeTruthy();
      expect(body.key).toBe(uniqueKey);
      expect(body.title).toBe('Test Article for Password Policy');
      expect(body.category).toBe('Getting Started');
      expect(body.currentVersion).toBe(1);
      expect(body.isActive).toBe(true);
      createdArticleId = body.id;
    });

    // 7. POST /api/help - duplicate key returns 409
    it('returns 409 for duplicate key', async () => {
      const res = await authPost(app, '/api/help', adminToken, {
        key: uniqueKey,
        title: 'Duplicate Key Article',
        content: 'Should fail.',
        category: 'Testing',
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.error).toContain('already exists');
    });
  });

  // 2. GET /api/help?category=Getting+Started - filters by category
  describe('GET /api/help?category', () => {
    it('filters articles by category', async () => {
      const res = await authGet(app, '/api/help?category=Getting+Started', adminToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Array.isArray(body)).toBe(true);
      // Every returned article should belong to the requested category
      for (const article of body) {
        expect(article.category).toBe('Getting Started');
      }
      // The article we created should be present
      const found = body.find((a: any) => a.key === uniqueKey);
      expect(found).toBeTruthy();
    });
  });

  // 3. GET /api/help?search=password - searches in title/content
  describe('GET /api/help?search', () => {
    it('searches articles by title or content', async () => {
      const res = await authGet(app, '/api/help?search=password', adminToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Array.isArray(body)).toBe(true);
      // Our article mentions "password" in both title and content
      const found = body.find((a: any) => a.key === uniqueKey);
      expect(found).toBeTruthy();
    });
  });

  // 4. GET /api/help/:key - returns article with content
  describe('GET /api/help/:key', () => {
    it('returns article by key with content', async () => {
      const res = await authGet(app, `/api/help/${uniqueKey}`, adminToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.key).toBe(uniqueKey);
      expect(body.title).toBe('Test Article for Password Policy');
      expect(body.content).toContain('password');
      expect(body.currentVersion).toBe(1);
    });

    // 5. GET /api/help/nonexistent-key - returns 404
    it('returns 404 for nonexistent key', async () => {
      const res = await authGet(app, '/api/help/nonexistent-key-xyz-999', adminToken);
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toContain('not found');
    });
  });

  // 8. PUT /api/help/:id - updates article, increments version
  describe('PUT /api/help/:id', () => {
    it('updates article and increments version', async () => {
      expect(createdArticleId).toBeTruthy();
      const res = await authPut(app, `/api/help/${createdArticleId}`, adminToken, {
        title: 'Updated Test Article',
        content: 'Updated content with new password guidelines.',
        changeNotes: 'Updated title and content',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.title).toBe('Updated Test Article');
      expect(body.content).toContain('Updated content');
      expect(body.currentVersion).toBe(2);
    });
  });

  // 9. GET /api/help/:id/versions - returns version history
  describe('GET /api/help/:id/versions', () => {
    it('returns version history for the article', async () => {
      expect(createdArticleId).toBeTruthy();
      const res = await authGet(app, `/api/help/${createdArticleId}/versions`, adminToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(2);

      // Versions should be ordered descending (newest first)
      expect(body[0].version).toBeGreaterThan(body[1].version);

      // Latest version
      expect(body[0].version).toBe(2);
      expect(body[0].changedBy).toBe('admin');
      expect(body[0].changeNotes).toBe('Updated title and content');

      // Initial version
      const initial = body.find((v: any) => v.version === 1);
      expect(initial).toBeTruthy();
      expect(initial.changeNotes).toBe('Initial version');
    });
  });

  // 10. DELETE /api/help/:id - soft deletes (isActive=false)
  describe('DELETE /api/help/:id', () => {
    it('soft deletes the article', async () => {
      expect(createdArticleId).toBeTruthy();
      const res = await authDelete(app, `/api/help/${createdArticleId}`, adminToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.deleted).toBe(true);
    });
  });

  // 11. GET /api/help/:key after delete - returns 404 (inactive)
  describe('GET /api/help/:key after delete', () => {
    it('returns 404 for soft-deleted article', async () => {
      const res = await authGet(app, `/api/help/${uniqueKey}`, adminToken);
      expect(res.statusCode).toBe(404);
    });
  });

  // 12. POST /api/help without auth - returns 401
  describe('Unauthenticated access', () => {
    it('POST /api/help without auth returns 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/help',
        payload: {
          key: `no-auth-${SUFFIX}`,
          title: 'No Auth Article',
          content: 'Should not be created.',
          category: 'Testing',
        },
      });

      expect(res.statusCode).toBe(401);
    });
  });
});
