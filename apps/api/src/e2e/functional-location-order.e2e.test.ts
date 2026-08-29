import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs, authGet, ADMIN_PASSWORD } from './test-helper.js';
import { prisma } from '../lib/prisma.js';

/**
 * Manual display order for functional locations.
 *
 * The behaviour that matters is not "the numbers get written" — it is that
 * ordering stays SAFE against the data that already exists. Every row defaults
 * to sortOrder 0, so an installation that never arranges anything must keep
 * the exact alphabetical list it had before the column existed. That is the
 * first test here and the reason the name tiebreak is not optional.
 */
describe('functional-location manual order', () => {
  let app: FastifyInstance;
  let token: string;
  const created: string[] = [];

  const put = (url: string, body: unknown, reauth = true) =>
    app.inject({
      method: 'PUT',
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(reauth ? { 'x-reauth-password': ADMIN_PASSWORD } : {}),
      },
      payload: body as object,
    });

  async function makeBlock(name: string) {
    const row = await prisma.functionalLocation.create({ data: { name, type: 'BLOCK' } });
    created.push(row.id);
    return row;
  }

  beforeAll(async () => {
    app = await buildApp();
    token = await loginAs(app);
  });

  afterAll(async () => {
    await prisma.functionalLocation.deleteMany({ where: { id: { in: created } } });
    await app.close();
  });

  beforeEach(async () => {
    // Each test owns its own blocks; the fixture database has others.
    await prisma.functionalLocation.deleteMany({ where: { id: { in: created } } });
    created.length = 0;
  });

  describe('the default is a no-op', () => {
    it('new locations start at sortOrder 0', async () => {
      const b = await makeBlock(`ZZ Order A ${Date.now()}`);
      const row = await prisma.functionalLocation.findUnique({ where: { id: b.id } });
      expect(row?.sortOrder).toBe(0);
    });

    // The whole safety argument: unarranged rows tie at 0 and fall back to name.
    it('unarranged blocks still list alphabetically', async () => {
      const stamp = Date.now();
      await makeBlock(`ZZOrd ${stamp} Charlie`);
      await makeBlock(`ZZOrd ${stamp} Alpha`);
      await makeBlock(`ZZOrd ${stamp} Bravo`);

      const res = await authGet(app, '/api/functional-locations', token);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const list = Array.isArray(body) ? body : body.data ?? [];
      const mine = list
        .filter((n: any) => String(n.name).startsWith(`ZZOrd ${stamp}`))
        .map((n: any) => n.name);
      expect(mine).toEqual([
        `ZZOrd ${stamp} Alpha`,
        `ZZOrd ${stamp} Bravo`,
        `ZZOrd ${stamp} Charlie`,
      ]);
    });
  });

  describe('routing', () => {
    // `PUT /:id` is also registered. Fastify's radix router prefers a static
    // segment over a parametric one regardless of registration order — but that
    // is exactly the kind of assumption worth pinning, because if it were wrong
    // this endpoint would silently become "update the location named 'order'".
    it('PUT /order reaches the reorder handler, not PUT /:id', async () => {
      const res = await put('/api/functional-locations/order', { ids: [] });
      // 400 from the schema (minItems) proves the reorder route matched; the
      // /:id handler would have answered 404 for a location called "order".
      expect(res.statusCode).toBe(400);
    });
  });

  describe('reordering', () => {
    async function threeBlocks() {
      const stamp = Date.now();
      const a = await makeBlock(`ZZSet ${stamp} Alpha`);
      const b = await makeBlock(`ZZSet ${stamp} Bravo`);
      const c = await makeBlock(`ZZSet ${stamp} Charlie`);
      return { a, b, c, stamp };
    }

    /** Every block in the database, in the order the API reports. */
    async function order(): Promise<string[]> {
      const res = await authGet(app, '/api/functional-locations', token);
      const body = JSON.parse(res.body);
      const list = Array.isArray(body) ? body : body.data ?? [];
      return list.map((n: any) => n.name);
    }

    it('applies the requested order', async () => {
      const { a, b, c, stamp } = await threeBlocks();
      const all = await prisma.functionalLocation.findMany({
        where: { parentId: null }, select: { id: true },
      });
      const others = all.map((r) => r.id).filter((id) => ![a.id, b.id, c.id].includes(id));

      const res = await put('/api/functional-locations/order', {
        ids: [...others, c.id, a.id, b.id],
      });
      expect(res.statusCode).toBe(200);

      const names = (await order()).filter((n) => n.startsWith(`ZZSet ${stamp}`));
      expect(names).toEqual([
        `ZZSet ${stamp} Charlie`,
        `ZZSet ${stamp} Alpha`,
        `ZZSet ${stamp} Bravo`,
      ]);
    });

    it('numbers from 1, keeping 0 reserved for "never arranged"', async () => {
      const { a, b, c } = await threeBlocks();
      const all = await prisma.functionalLocation.findMany({
        where: { parentId: null }, select: { id: true },
      });
      const others = all.map((r) => r.id).filter((id) => ![a.id, b.id, c.id].includes(id));
      await put('/api/functional-locations/order', { ids: [...others, a.id, b.id, c.id] });

      const rows = await prisma.functionalLocation.findMany({
        where: { id: { in: [a.id, b.id, c.id] } }, select: { sortOrder: true },
      });
      for (const r of rows) expect(r.sortOrder).toBeGreaterThan(0);
    });

    it('rejects a partial sibling set', async () => {
      const { a, b } = await threeBlocks();
      const res = await put('/api/functional-locations/order', { ids: [a.id, b.id] });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toMatch(/complete set of siblings/i);
    });

    it('rejects a duplicated id', async () => {
      const { a } = await threeBlocks();
      const res = await put('/api/functional-locations/order', { ids: [a.id, a.id] });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toMatch(/more than once/i);
    });

    it('404s on an unknown id', async () => {
      const res = await put('/api/functional-locations/order', {
        ids: ['00000000-0000-4000-8000-000000000000'],
      });
      expect(res.statusCode).toBe(404);
    });

    it('rejects an empty list', async () => {
      const res = await put('/api/functional-locations/order', { ids: [] });
      expect(res.statusCode).toBe(400);
    });

    // additionalProperties:false makes AJV STRIP the unknown key, not reject the
    // request — Fastify runs with removeAdditional. So `evil` never reaches the
    // handler (which is the protection that matters: it cannot be written), and
    // the request then fails on the bogus id like any other. Asserting a 400
    // here would have been asserting behaviour this stack does not have.
    it('strips unknown body keys rather than writing them', async () => {
      const res = await put('/api/functional-locations/order', { ids: ['x'], evil: 1 });
      expect(res.statusCode).toBe(404);
      expect(res.statusCode).not.toBe(500);
    });
  });

  describe('areas — the same endpoint, one level down', () => {
    // Areas are siblings of one another WITHIN a Block, so the same endpoint
    // orders them. This is the case that proves the parent check is doing real
    // work rather than only ever seeing the root set.
    it('orders the areas of one block', async () => {
      const stamp = Date.now();
      const block = await makeBlock(`ZZAr ${stamp} Block`);
      const mk = async (name: string) => {
        const row = await prisma.functionalLocation.create({
          data: { name, type: 'AREA', parentId: block.id },
        });
        created.push(row.id);
        return row;
      };
      const a = await mk('Alpha');
      const b = await mk('Bravo');
      const c = await mk('Charlie');

      const res = await put('/api/functional-locations/order', { ids: [c.id, a.id, b.id] });
      expect(res.statusCode).toBe(200);

      const tree = await authGet(app, '/api/functional-locations', token);
      const body = JSON.parse(tree.body);
      const list = Array.isArray(body) ? body : body.data ?? [];
      const mine = list.find((n: any) => n.id === block.id);
      expect(mine.children.map((x: any) => x.name)).toEqual(['Charlie', 'Alpha', 'Bravo']);
    });

    // Mixing levels would let a caller interleave a Block with another Block's
    // Areas, producing an order the tree cannot render.
    it('refuses to mix a block and an area in one request', async () => {
      const stamp = Date.now();
      const block = await makeBlock(`ZZMix ${stamp} Block`);
      const area = await prisma.functionalLocation.create({
        data: { name: 'Solo', type: 'AREA', parentId: block.id },
      });
      created.push(area.id);

      const res = await put('/api/functional-locations/order', { ids: [block.id, area.id] });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toMatch(/same parent/i);
    });
  });

  describe('governance', () => {
    it('requires authentication', async () => {
      const res = await app.inject({
        method: 'PUT', url: '/api/functional-locations/order', payload: { ids: ['x'] },
      });
      expect(res.statusCode).toBe(401);
    });

    // Reordering is a §11 record change like any other edit to these rows.
    it('writes an audit row naming the resulting order', async () => {
      const stamp = Date.now();
      const a = await makeBlock(`ZZAud ${stamp} Alpha`);
      const b = await makeBlock(`ZZAud ${stamp} Bravo`);
      const all = await prisma.functionalLocation.findMany({
        where: { parentId: null }, select: { id: true },
      });
      const others = all.map((r) => r.id).filter((id) => ![a.id, b.id].includes(id));

      await put('/api/functional-locations/order', { ids: [...others, b.id, a.id] });

      const row = await prisma.auditTrail.findFirst({
        where: { action: 'FUNCTIONAL_LOCATION_UPDATED', targetId: 'root' },
        orderBy: { timestamp: 'desc' },
      });
      expect(row).not.toBeNull();
      const after = (row!.afterValue as any).order as string[];
      // Names, not ids — a list of uuids cannot answer "what order did they
      // choose?" a year later.
      expect(after).toContain(`ZZAud ${stamp} Bravo`);
      expect(after.indexOf(`ZZAud ${stamp} Bravo`))
        .toBeLessThan(after.indexOf(`ZZAud ${stamp} Alpha`));
      expect(row!.signatureMeaning).toMatch(/Display order/i);
    });
  });
});
