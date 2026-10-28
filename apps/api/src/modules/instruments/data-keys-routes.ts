import { type FastifyInstance } from 'fastify';
import { DATA_KEYS_INSTRUMENTS_MAX, latestValuesRequestSchema } from '@digilog/shared';
import { prisma } from '../../lib/prisma.js';
import { buildContext } from '../../lib/build-context.js';
import { errorResponses } from '../../lib/error-schemas.js';
import { resolveVisibility, withVisibility } from './visibility.js';
import { resolveLocationIds, type FlNode } from '../functional-locations/tree.js';
import { buildKeyCatalogue, buildLatestValues } from './data-keys.js';

/**
 * WIDGET DATA KEYS (2026-10-28) — the routes a widget uses to find and read ANY
 * key an instrument has (spec docs/superpowers/specs/2026-10-28-widget-data-keys-design.md).
 *
 * A child plugin of the instruments routes (the device-certificate precedent),
 * so it lives under `/api/instruments` with no registration of its own in
 * `app.ts` or the e2e helper. Static paths, so Fastify matches them before
 * `/:id`.
 *
 * Visibility is applied to the instrument id set BEFORE anything is read: an
 * out-of-scope instrument is absent, never a 403 — the same discipline as
 * `/telemetry-history`.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const measurementProps = {
  type: 'object', nullable: true,
  properties: { code: { type: 'string' }, name: { type: 'string' }, unit: { type: 'string' } },
} as const;

/** Every field of `DataKeyInfo`, declared — Fastify strips anything it is not told about. */
const dataKeyInfoProps = {
  source: { type: 'string', enum: ['telemetry', 'attribute'] },
  key: { type: 'string' },
  label: { type: 'string' },
  numeric: { type: 'boolean' },
  instruments: { type: 'integer' },
  lastSeen: { type: 'string', nullable: true },
  measurement: measurementProps,
} as const;

/** `DataKeyJudged` — a measured key's bounds and fault flags; null for a raw key. */
const judgedProps = {
  type: 'object', nullable: true,
  properties: {
    limitMin: { type: 'number', nullable: true },
    limitMax: { type: 'number', nullable: true },
    limitMinText: { type: 'string', nullable: true },
    limitMaxText: { type: 'string', nullable: true },
    sensorError: { type: 'boolean' },
    rangeError: { type: 'boolean' },
  },
} as const;

/** `LatestKeyValue`. `value` is any stored JSON, so it carries no type at all. */
const latestKeyValueProps = {
  source: { type: 'string', enum: ['telemetry', 'attribute'] },
  key: { type: 'string' },
  value: { nullable: true },
  ts: { type: 'string', nullable: true },
  unit: { type: 'string', nullable: true },
  decimals: { type: 'integer', nullable: true },
  display: { type: 'string', nullable: true },
  judged: judgedProps,
} as const;

/** `LatestValuesRow`. */
const latestValuesRowProps = {
  instrumentId: { type: 'string' },
  code: { type: 'string' },
  name: { type: 'string' },
  functionalLocationName: { type: 'string', nullable: true },
  locationAttribute: { type: 'string', nullable: true },
  reporting: { type: 'boolean' },
  lastSeenAt: { type: 'string', nullable: true },
  values: { type: 'array', items: { type: 'object', properties: latestKeyValueProps } },
} as const;

export default async function dataKeysRoutes(app: FastifyInstance) {
  // GET /api/instruments/data-keys — every key a set of instruments has sent
  // (telemetry) or carries (attributes). A key appears the moment its first
  // reading is stored; there is nothing to configure.
  app.get('/data-keys', {
    preHandler: [app.requirePermission('INSTRUMENT_READ')],
    schema: {
      tags: ['Instruments'],
      summary: 'Every telemetry and attribute key a set of instruments has',
      description: 'Exactly one selector: `instrumentIds` (comma list, at most 200), `functionalLocationId` (a Block includes its Areas) or `profileId`. Out-of-scope instruments are absent.',
      querystring: {
        type: 'object',
        properties: {
          instrumentIds: { type: 'string' },
          functionalLocationId: { type: 'string', format: 'uuid' },
          profileId: { type: 'string', format: 'uuid' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: { data: { type: 'array', items: { type: 'object', properties: dataKeyInfoProps } } },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const q = req.query as { instrumentIds?: string; functionalLocationId?: string; profileId?: string };
    const given = [q.instrumentIds, q.functionalLocationId, q.profileId].filter((v) => v !== undefined && v !== '');
    if (given.length !== 1) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: 'Give exactly one of instrumentIds, functionalLocationId or profileId.',
      });
    }

    let selector: object;
    if (q.instrumentIds) {
      const asked = [...new Set(q.instrumentIds.split(',').map((x) => x.trim()).filter(Boolean))];
      const bad = asked.find((x) => !UUID_RE.test(x));
      if (bad) {
        return reply.code(400).send({ error: 'VALIDATION_ERROR', message: `Not an instrument id: ${bad.slice(0, 80)}` });
      }
      if (asked.length > DATA_KEYS_INSTRUMENTS_MAX) {
        return reply.code(400).send({
          error: 'VALIDATION_ERROR', message: `At most ${DATA_KEYS_INSTRUMENTS_MAX} instruments per request.`,
        });
      }
      selector = { id: { in: asked } };
    } else if (q.functionalLocationId) {
      // `resolveLocationIds`, never a bare equality: a Block's instruments are
      // its own plus every Area beneath it — the server's expansion, which the
      // browser must never re-derive.
      const nodes = await prisma.functionalLocation.findMany({
        select: { id: true, name: true, type: true, parentId: true },
      });
      selector = { functionalLocationId: { in: resolveLocationIds(q.functionalLocationId, nodes as FlNode[]) } };
    } else {
      selector = { profileId: q.profileId };
    }

    const { where: visibility } = await resolveVisibility(buildContext(req));
    // No `take`: a Block or a profile is catalogued WHOLE. A cap here would
    // silently drop the keys of every instrument past it — the catalogue reads
    // one latest row per key, so its cost is bounded by keys, not instruments.
    // The 200 limit bounds only an explicit id list (a URL).
    const instruments = await prisma.instrument.findMany({
      where: withVisibility(selector, visibility) as never,
      select: { id: true, profileId: true },
    });
    const data = await buildKeyCatalogue({ instruments, isSuperAdmin: req.user?.role === 'SUPER_ADMIN' });
    return { data };
  });

  // POST /api/instruments/latest-values — what each named key currently reads on
  // each named instrument. POST only because an id list does not fit a URL; it
  // reads, and writes no audit row.
  app.post('/latest-values', {
    preHandler: [app.requirePermission('INSTRUMENT_READ')],
    schema: {
      tags: ['Instruments'],
      summary: 'Latest value of any telemetry or attribute key, for a set of instruments',
      description: 'A measured key carries the server\'s unit, precision, bounds and fault flags; a raw key carries none (`decimals: null` = print as received). Out-of-scope instruments are absent.',
      body: {
        type: 'object',
        required: ['instrumentIds', 'keys'],
        properties: {
          instrumentIds: { type: 'array', items: { type: 'string' } },
          keys: {
            type: 'array',
            items: { type: 'object', properties: { source: { type: 'string' }, key: { type: 'string' } } },
          },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: { data: { type: 'array', items: { type: 'object', properties: latestValuesRowProps } } },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    // The shared zod schema is the ONE definition of a valid request (caps,
    // uuid ids, known sources); the JSON schema above only shapes the docs.
    const parsed = latestValuesRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message ?? 'Invalid request.' });
    }
    const { where: visibility } = await resolveVisibility(buildContext(req));
    const data = await buildLatestValues({
      instrumentIds: [...new Set(parsed.data.instrumentIds)],
      keys: parsed.data.keys,
      isSuperAdmin: req.user?.role === 'SUPER_ADMIN',
      visibilityWhere: visibility,
    });
    return { data };
  });
}
