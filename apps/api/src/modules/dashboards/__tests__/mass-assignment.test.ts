import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';

/**
 * Mass-assignment guard for the two PUT handlers that do `data: body`.
 *
 * The mechanism is subtle enough that two separate audit findings stated it
 * WRONG (one claimed the AJV instance lacks `removeAdditional`). The truth,
 * established empirically: Fastify enables removeAdditional by DEFAULT, but it
 * only strips unknown keys when the schema declares `additionalProperties:
 * false`. Omit that, and every key the client sends flows into Prisma.
 *
 * This boots a real Fastify with THIS repo's ajv options (app.ts) rather than
 * mocking, because the whole question is what the real validator does.
 */
const ajvOptions = { customOptions: { keywords: ['example'] } };

function buildApp() {
  const app = Fastify({ ajv: ajvOptions });
  // Mirrors the dashboard PUT body schema.
  const guarded = {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 200 },
      isActive: { type: 'boolean' },
    },
    additionalProperties: false,
  };
  const unguarded = { ...guarded } as any;
  delete unguarded.additionalProperties;

  app.put('/guarded', { schema: { body: guarded } }, async (req) => ({ received: req.body }));
  app.put('/unguarded', { schema: { body: unguarded } }, async (req) => ({ received: req.body }));
  return app;
}

let app: ReturnType<typeof buildApp>;
beforeAll(async () => { app = buildApp(); await app.ready(); });
afterAll(async () => { await app.close(); });

const attack = { title: 'ok', createdBy: 'attacker', createdAt: '1990-01-01', dashboardId: 'other-uuid' };

describe('PUT body schemas — mass assignment', () => {
  it('additionalProperties:false strips every unknown key before it reaches the handler', async () => {
    const res = await app.inject({ method: 'PUT', url: '/guarded', payload: attack });
    expect(res.statusCode).toBe(200);
    // Only the declared key survives — this is what makes `data: body` safe.
    expect(res.json().received).toEqual({ title: 'ok' });
  });

  it('proves the vulnerability is real: without it, forged keys reach the handler', async () => {
    // This is the pre-fix behaviour. If this ever starts stripping, the guard
    // above is passing for the wrong reason and this test tells you.
    const res = await app.inject({ method: 'PUT', url: '/unguarded', payload: attack });
    expect(res.statusCode).toBe(200);
    expect(res.json().received).toMatchObject({ createdBy: 'attacker', dashboardId: 'other-uuid' });
  });

  it('declared keys still pass through', async () => {
    const res = await app.inject({ method: 'PUT', url: '/guarded', payload: { title: 'x', isActive: false } });
    expect(res.json().received).toEqual({ title: 'x', isActive: false });
  });

  it('declared-key validation is unaffected', async () => {
    const res = await app.inject({ method: 'PUT', url: '/guarded', payload: { title: '' } });
    expect(res.statusCode).toBe(400);
  });
});
