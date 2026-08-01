import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../lib/password.js';

/**
 * Task 9 — hierarchy routes.
 *
 * Provisions its own users (`hierarchy_admin` / `hierarchy_viewer`) rather
 * than the shared `admin` fixture — see apps/api/CLAUDE.md's "per-file
 * authoring tip" (concurrent suites sharing `admin` cause flaky 401s).
 */
const ADMIN_USERNAME = 'hierarchy_admin';
const ADMIN_PASSWORD = 'Hierarchy@Test1';
const VIEWER_USERNAME = 'hierarchy_viewer';
const VIEWER_PASSWORD = 'HierarchyViewer@Test1';

let app: FastifyInstance;
let token: string;

beforeAll(async () => {
  app = await buildApp();

  // Root-level slugs (e.g. 'controlyt') are unique per parent — clear any
  // leftover rows from a prior interrupted run so this file's fixtures
  // (which reuse the same company names as hierarchy.repository.test.ts)
  // don't collide.
  await prisma.$executeRawUnsafe('TRUNCATE "hierarchy_nodes" CASCADE');

  const adminHash = await hashPassword(ADMIN_PASSWORD);
  await prisma.user.upsert({
    where: { username: ADMIN_USERNAME },
    update: {
      passwordHash: adminHash,
      fullName: 'Hierarchy Test Admin',
      role: 'SUPER_ADMIN',
      status: 'ENABLED',
      forcePasswordChange: false,
      isTemporaryPassword: false,
      failedLoginAttempts: 0,
      lockedAt: null,
      lockoutUntil: null,
    },
    create: {
      username: ADMIN_USERNAME,
      passwordHash: adminHash,
      fullName: 'Hierarchy Test Admin',
      email: 'hierarchy-test-admin@example.test',
      role: 'SUPER_ADMIN',
      status: 'ENABLED',
      forcePasswordChange: false,
      isTemporaryPassword: false,
    },
  });
  token = await loginAs(app, ADMIN_USERNAME, ADMIN_PASSWORD);
});

afterAll(async () => { await app.close(); });

// `auth`/`post` must read `token` at CALL time, not at module-load time —
// `token` is only assigned inside `beforeAll`, which runs after this module
// finishes evaluating. A plain `const auth = { authorization: \`Bearer ${token}\` }`
// here would freeze in "Bearer undefined" for the whole file.
const auth = () => ({ authorization: `Bearer ${token}` });
const post = (payload: unknown) =>
  app.inject({ method: 'POST', url: '/api/hierarchy', headers: auth(), payload });

describe('hierarchy routes', () => {
  it('creates a node and writes an audit row', async () => {
    const res = await post({ parentId: null, level: 'COMPANY', name: 'Controlyt' });
    expect(res.statusCode).toBe(200);
    expect(res.json().slug).toBe('controlyt');

    const audit = await prisma.auditTrail.findFirst({
      where: { action: 'HIERARCHY_NODE_CREATED', targetId: res.json().id },
    });
    expect(audit).not.toBeNull();
    expect(audit!.userId).toBe(ADMIN_USERNAME);
  });

  it('returns the tree with materialised paths', async () => {
    const co = await post({ parentId: null, level: 'COMPANY', name: 'TreeCo' });
    await post({ parentId: co.json().id, level: 'SITE', name: 'Site One' });
    const res = await app.inject({ method: 'GET', url: '/api/hierarchy', headers: auth() });
    expect(res.statusCode).toBe(200);
    // hierarchy_nodes.path is ltree — segments are dot-separated (see
    // hierarchy.repository.ts createNode: `${parentPath}.${toLabel(slug)}`),
    // not slash-separated. The brief's test asserted 'treeco/site-one', which
    // does not match the repository's actual output; fixed to the real format.
    expect(res.json().some((n: { path: string }) => n.path === 'treeco.site-one')).toBe(true);
  });

  it('rejects a cyclic move with 400', async () => {
    const co = await post({ parentId: null, level: 'COMPANY', name: 'CycleCo' });
    const site = await post({ parentId: co.json().id, level: 'SITE', name: 'CycleSite' });
    const res = await app.inject({
      method: 'POST', url: `/api/hierarchy/${co.json().id}/move`,
      headers: auth(), payload: { newParentId: site.json().id },
    });
    expect(res.statusCode).toBe(400);
  });

  it('requires HIERARCHY_VIEW — a token without it gets 403', async () => {
    const viewerHash = await hashPassword(VIEWER_PASSWORD);
    await prisma.user.upsert({
      where: { username: VIEWER_USERNAME },
      update: {
        passwordHash: viewerHash,
        fullName: 'Hierarchy Test Viewer',
        role: 'VIEWER',
        status: 'ENABLED',
        forcePasswordChange: false,
        isTemporaryPassword: false,
        failedLoginAttempts: 0,
        lockedAt: null,
        lockoutUntil: null,
      },
      create: {
        username: VIEWER_USERNAME,
        passwordHash: viewerHash,
        fullName: 'Hierarchy Test Viewer',
        email: 'hierarchy-test-viewer@example.test',
        role: 'VIEWER',
        status: 'ENABLED',
        forcePasswordChange: false,
        isTemporaryPassword: false,
      },
    });
    const viewerToken = await loginAs(app, VIEWER_USERNAME, VIEWER_PASSWORD);
    const res = await app.inject({
      method: 'GET', url: '/api/hierarchy',
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses to delete a node that still has children', async () => {
    const co = await post({ parentId: null, level: 'COMPANY', name: 'DeleteCo' });
    await post({ parentId: co.json().id, level: 'SITE', name: 'DeleteSite' });
    const res = await app.inject({
      method: 'DELETE', url: `/api/hierarchy/${co.json().id}`, headers: auth(),
    });
    expect(res.statusCode).toBe(400);
  });

  it('renames a node, writes an audit row, and deletes it once it is a leaf again', async () => {
    const co = await post({ parentId: null, level: 'COMPANY', name: 'RenameCo' });
    const putRes = await app.inject({
      method: 'PUT', url: `/api/hierarchy/${co.json().id}`,
      headers: auth(), payload: { name: 'RenamedCo' },
    });
    expect(putRes.statusCode).toBe(200);
    const updateAudit = await prisma.auditTrail.findFirst({
      where: { action: 'HIERARCHY_NODE_UPDATED', targetId: co.json().id },
    });
    expect(updateAudit).not.toBeNull();

    const delRes = await app.inject({
      method: 'DELETE', url: `/api/hierarchy/${co.json().id}`, headers: auth(),
    });
    expect(delRes.statusCode).toBe(200);
    const deleteAudit = await prisma.auditTrail.findFirst({
      where: { action: 'HIERARCHY_NODE_DELETED', targetId: co.json().id },
    });
    expect(deleteAudit).not.toBeNull();
  });
});
