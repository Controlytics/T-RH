import { describe, it, expect, vi } from 'vitest';

/**
 * Phase 8.4b — Sync route registration shape.
 *
 * Asserts the route is registered at GET /since with explicit response
 * properties (so Fastify won't strip empty arrays) and no `requirePermission`
 * decorator (auth comes from the global onRequest hook in plugins/auth.ts).
 *
 * Pattern: stub Fastify-like recorder. Same approach used elsewhere where
 * spinning up the full server is overkill for a schema check.
 */

vi.mock('../../../lib/prisma.js', () => ({ prisma: {} }));

import syncRoutes from '../routes.js';

interface RouteCall {
  method: string;
  url: string;
  options: any;
}

function makeRecorder() {
  const calls: RouteCall[] = [];
  // Records the perms each gate was built with, so a test can assert the gate
  // rather than just its presence.
  const gates: string[][] = [];
  const app: any = {
    requireAnyPermission: (...perms: string[]) => { gates.push(perms); return `gate:${perms.join('|')}`; },
    get: (url: string, options: any) => calls.push({ method: 'get', url, options }),
    post: (url: string, options: any) => calls.push({ method: 'post', url, options }),
  };
  return { app, calls, gates };
}

describe('sync routes — registration', () => {
  it('1. registers a single GET /since with explicit response schema', async () => {
    const { app, calls } = makeRecorder();
    await syncRoutes(app);
    expect(calls).toHaveLength(1);
    const [c] = calls;
    expect(c.method).toBe('get');
    expect(c.url).toBe('/since');
    // Schema declares all 6 entity arrays + serverTimestamp + hasMore as
    // required. Required array can't be left out by Fastify on serialization.
    const required = c.options.schema.response[200].required;
    expect(required).toEqual(expect.arrayContaining([
      'filterCleaningProfiles',
      'filterProfiles',
      'equipmentGroups',
      'checklistProfiles',
      'assetTemplates',
      'filters',
      'serverTimestamp',
      'hasMore',
    ]));
  });

  /**
   * This test previously asserted `preHandler` was UNDEFINED, reasoning that
   * "auth comes from the global onRequest hook" — which conflated
   * authentication with authorization and locked the gap in. The hook proves
   * WHO you are; it never checked whether you may read the whole plant model.
   * A zero-permission account could hydrate every filter, template, checklist
   * profile, pipeline and equipment group.
   */
  it('2. is gated on ASSET_VIEW or FILTER_OPERATE — authentication is not authorization', async () => {
    const { app, calls, gates } = makeRecorder();
    await syncRoutes(app);
    const [c] = calls;
    expect(c.options.preHandler).toBeDefined();
    // Mirrors the endpoints this route duplicates: hierarchy reads (ASSET_VIEW)
    // and checklist-profile reads (which accept FILTER_OPERATE so operating
    // roles can sync — see the 2026-07-10 tablet fix). All 8 active roles hold
    // ASSET_VIEW, so nothing that syncs today is locked out.
    expect(gates).toEqual([['ASSET_VIEW', 'FILTER_OPERATE']]);
  });

  it('3. querystring schema accepts all 6 cursor params', async () => {
    const { app, calls } = makeRecorder();
    await syncRoutes(app);
    const [c] = calls;
    const props = c.options.schema.querystring.properties;
    expect(props).toEqual(expect.objectContaining({
      profileVersion: expect.any(Object),
      filterProfileVersion: expect.any(Object),
      equipmentGroupVersion: expect.any(Object),
      checklistVersion: expect.any(Object),
      assetTemplateVersion: expect.any(Object),
      filterUpdatedSince: expect.any(Object),
    }));
    // version cursors are integers >= 0
    expect(props.profileVersion.type).toBe('integer');
    expect(props.profileVersion.minimum).toBe(0);
  });
});
