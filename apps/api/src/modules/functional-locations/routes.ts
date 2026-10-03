import { type FastifyInstance } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
import { buildContext } from '../../lib/build-context.js';
import { enforceReauth } from '../../lib/reauth-check.js';
import { errorResponses } from '../../lib/error-schemas.js';
import { sanitizeStrings } from '../../lib/sanitize.js';
import { validateFlDraft, type FlType } from './validation.js';
import { buildTree, locationPath, resolveLocationIds, type FlNode, type LocationCount } from './tree.js';
import { isInstrumentReporting } from '@digilog/shared';
import { loadActiveWindowMinutes } from '../instruments/telemetry-overview.js';
import { resolveVisibility, withVisibility, type ScopeWhere } from '../instruments/visibility.js';

/**
 * Functional Locations — the authoritative Block > Area grouping of instruments.
 *
 * Reads gate on FUNCTIONAL_LOCATION_READ; writes on the matching CREATE / UPDATE /
 * DELETE permission WITH re-authentication, and every write is audited. Grouping
 * decides which instruments an operator is shown, so "who moved this instrument,
 * out of what, into what" has to be answerable.
 *
 * Design: docs/superpowers/specs/2026-08-13-functional-locations-design.md
 */

/**
 * Exempt from HTML stripping, mirroring floorplans/routes.ts. `sanitizeStrings`
 * strips anything tag-shaped — right for prose, wrong for an operator-chosen
 * identifier like `Module-E` that must round-trip byte-identical.
 */
const IDENTITY_FIELDS = ['name'];

const flProps = {
  id: { type: 'string' },
  name: { type: 'string' },
  type: { type: 'string' },
  parentId: { type: 'string', nullable: true },
  ownCount: { type: 'integer' },
  totalCount: { type: 'integer' },
  /** Of totalCount, how many are active. Inactive is derived at display time. */
  activeCount: { type: 'integer' },
} as const;

/** Recursive shape is declared one level deep, which is all the depth cap allows. */
const flTreeProps = {
  ...flProps,
  children: { type: 'array', items: { type: 'object', properties: flProps } },
} as const;

/**
 * A signature meaning that lists `names` as far as the audit column allows
 * (`signature_meaning VARCHAR(255)`), then counts the rest — the row's
 * `afterValue` carries them all.
 */
export function boundedMeaning(prefix: string, names: string[], max = 255): string {
  const listed: string[] = [];
  for (const [i, name] of names.entries()) {
    const rest = names.length - i - 1;
    const tail = rest > 0 ? ` … and ${rest} more` : '';
    const candidate = prefix + [...listed, name].join(', ') + tail;
    if (candidate.length > max) break;
    listed.push(name);
  }
  const rest = names.length - listed.length;
  const out = prefix + listed.join(', ') + (rest > 0 ? (listed.length ? ` … and ${rest} more` : `${rest} location(s)`) : '');
  return out.length <= max ? out : out.slice(0, max - 1) + '…';
}

async function loadNodes(): Promise<FlNode[]> {
  const rows = await prisma.functionalLocation.findMany({
    select: { id: true, name: true, type: true, parentId: true, sortOrder: true },
  });
  return rows.map((r) => ({ ...r, type: r.type as FlType }));
}

/** location id → instruments linked DIRECTLY to it. */
/**
 * Instruments per location, NARROWED to what the caller may see.
 *
 * `visibility` is the caller's resolved instrument scope, or undefined when
 * unrestricted. Without it the dashboard's Block cards announced "CWH Block: 100"
 * to a user scoped to four instruments — a count is a disclosure, and this one
 * both misdescribed what they had and revealed the size of the estate they were
 * excluded from. Same defect as an unscoped list, expressed as a number.
 *
 * The tree's SHAPE is deliberately not filtered: every Block and Area is still
 * returned, showing 0. A location is a place, not an instrument, and hiding
 * locations would make the plant's structure change depending on who is looking —
 * including for the admin picking locations to grant.
 */
/**
 * Instruments per location, split into total and ACTIVE.
 *
 * ACTIVE MEANS REPORTING, NOT ENABLED.
 *
 * The first cut of this counted `Instrument.isActive`, which is the
 * enable/disable flag an administrator sets. Every instrument on this
 * installation is enabled, so every card read "101 active · 0 inactive" while
 * nothing had reported for two days — a number that was technically true of
 * the column and useless, arguably worse than useless, to anyone reading the
 * dashboard to see whether the plant was alive.
 *
 * The product already defines Active, in Configuration → Instrument Activity:
 * "Active means it is sending telemetry ... reads Active while it has reported
 * within this many minutes, and Inactive after. Instruments that declare an
 * expected interval are judged against that instead." `isInstrumentReporting`
 * in @digilog/shared is the ONE implementation of that rule, and
 * telemetry-overview.ts already uses it, so the dashboard cards and the
 * instrument list cannot disagree about who is reporting.
 *
 * Evaluated in JS rather than SQL because the rule is per-instrument: an
 * instrument with its own `expectedIntervalSec` is judged against that
 * contract, not against the site fallback, so there is no single interval a
 * WHERE clause could compare against.
 */
async function loadOwnCounts(visibility?: ScopeWhere): Promise<Map<string, LocationCount>> {
  const [rows, activeWindowMinutes] = await Promise.all([
    prisma.instrument.findMany({
      where: withVisibility({ functionalLocationId: { not: null } }, visibility) as never,
      select: {
        functionalLocationId: true,
        lastSeenAt: true,
        expectedIntervalSec: true,
      },
    }),
    loadActiveWindowMinutes(),
  ]);

  // One `now` for the whole pass. Calling new Date() per instrument would let
  // the window move mid-count, so two instruments seen at the same instant
  // could land on opposite sides of it.
  const now = new Date();
  const counts = new Map<string, LocationCount>();
  for (const r of rows) {
    const id = r.functionalLocationId as string;
    const cur = counts.get(id) ?? { total: 0, active: 0 };
    cur.total += 1;
    if (isInstrumentReporting(r.lastSeenAt, r.expectedIntervalSec, activeWindowMinutes, now)) {
      cur.active += 1;
    }
    counts.set(id, cur);
  }
  return counts;
}

export default async function functionalLocationRoutes(app: FastifyInstance) {
  // GET / — the whole tree with counts.
  app.get('/', {
    preHandler: [app.requirePermission('FUNCTIONAL_LOCATION_READ')],
    schema: {
      tags: ['Functional Locations'],
      summary: 'The Block > Area tree with instrument counts',
      response: {
        200: {
          type: 'object',
          properties: { data: { type: 'array', items: { type: 'object', properties: flTreeProps } } },
        },
        ...errorResponses,
      },
    },
  }, async (req) => {
    const { where: visibility } = await resolveVisibility(buildContext(req));
    const [nodes, counts] = await Promise.all([loadNodes(), loadOwnCounts(visibility)]);
    return { data: buildTree(nodes, counts) };
  });

  // GET /linkable-instruments — EVERY instrument with its current location.
  //
  // Not unlinked-only: moving an instrument between locations is allowed and is
  // the documented behaviour, so an unlinked-only endpoint would make moving
  // impossible from the picker. The path is precomputed here rather than in the
  // browser so the two never disagree about how a location is named.
  app.get('/linkable-instruments', {
    preHandler: [app.requirePermission('FUNCTIONAL_LOCATION_READ')],
    schema: {
      tags: ['Functional Locations'],
      summary: 'Every instrument with its current functional location',
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  code: { type: 'string' },
                  name: { type: 'string' },
                  functionalLocationId: { type: 'string', nullable: true },
                  functionalLocationPath: { type: 'string', nullable: true },
                },
              },
            },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req) => {
    // Scoped (audit 2026-10-03, API-8): this picker listed EVERY instrument
    // with its location path to any FUNCTIONAL_LOCATION_READ holder.
    const { where: visibility } = await resolveVisibility(buildContext(req));
    const [nodes, rows] = await Promise.all([
      loadNodes(),
      prisma.instrument.findMany({
        where: withVisibility({}, visibility) as never,
        select: { id: true, code: true, name: true, functionalLocationId: true },
        orderBy: { code: 'asc' },
      }),
    ]);
    return {
      data: rows.map((r) => ({
        ...r,
        functionalLocationPath: locationPath(r.functionalLocationId, nodes),
      })),
    };
  });

  // GET /:id — one location, its children, and the instruments in its SCOPE.
  app.get('/:id', {
    preHandler: [app.requirePermission('FUNCTIONAL_LOCATION_READ')],
    schema: {
      tags: ['Functional Locations'],
      summary: 'One functional location with its children and instruments',
      params: { type: 'object', properties: { id: { type: 'string' } } },
      response: {
        200: {
          type: 'object',
          properties: {
            ...flProps,
            children: { type: 'array', items: { type: 'object', properties: flProps } },
            instruments: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  code: { type: 'string' },
                  name: { type: 'string' },
                  functionalLocationId: { type: 'string', nullable: true },
                },
              },
            },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    // Scoped like the list (audit 2026-10-03, API-8): the detail route called
    // `loadOwnCounts()` with no visibility and listed the location's instruments
    // unscoped — the "CWH Block: 100" disclosure the list route closed, one
    // click deeper.
    const { where: visibility } = await resolveVisibility(buildContext(req));
    const [nodes, counts] = await Promise.all([loadNodes(), loadOwnCounts(visibility)]);
    const self = nodes.find((n) => n.id === id);
    if (!self) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Functional location not found.' });

    // resolveLocationIds, NOT `functionalLocationId: id` — a Block's instruments
    // are its own PLUS all its Areas'. Querying the id directly is the bug this
    // helper exists to prevent.
    const scope = resolveLocationIds(id, nodes);
    const instruments = await prisma.instrument.findMany({
      where: withVisibility({ functionalLocationId: { in: scope } }, visibility) as never,
      select: { id: true, code: true, name: true, functionalLocationId: true },
      orderBy: { code: 'asc' },
    });

    const children = nodes
      .filter((n) => n.parentId === id)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => {
        const cc = counts.get(c.id);
        return {
          ...c,
          ownCount: cc?.total ?? 0,
          totalCount: cc?.total ?? 0,
          activeCount: cc?.active ?? 0,
        };
      });

    const own = counts.get(id);
    const ownCount = own?.total ?? 0;
    return {
      ...self,
      ownCount,
      totalCount: ownCount + children.reduce((sum, c) => sum + c.totalCount, 0),
      activeCount: (own?.active ?? 0) + children.reduce((sum, c) => sum + c.activeCount, 0),
      children,
      instruments,
    };
  });

  // POST / — create.
  app.post('/', {
    preHandler: [app.requirePermission('FUNCTIONAL_LOCATION_CREATE')],
    schema: {
      tags: ['Functional Locations'],
      summary: 'Create a functional location',
      response: { 201: { type: 'object', properties: flProps }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('CREATE_FUNCTIONAL_LOCATION', req, reply);
    if (!ok) return;

    const ctx = buildContext(req);
    const body = sanitizeStrings((req.body ?? {}) as Record<string, unknown>, IDENTITY_FIELDS);
    const draft = {
      name: String(body.name ?? ''),
      type: (body.type === 'AREA' ? 'AREA' : 'BLOCK') as FlType,
      parentId: (body.parentId as string | null) ?? null,
    };

    const nodes = await loadNodes();
    const parent = draft.parentId ? nodes.find((n) => n.id === draft.parentId) ?? null : null;
    const siblings = nodes.filter((n) => (n.parentId ?? null) === draft.parentId).map((n) => n.name);

    const err = validateFlDraft(draft, parent, siblings);
    if (err) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: err.message, field: err.field });

    // The row and its audit record land together or not at all (audit
    // 2026-10-03, API-4): until then the create committed first and a failed
    // audit insert left a location with no FUNCTIONAL_LOCATION_CREATED row.
    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.functionalLocation.create({
        data: {
          name: draft.name.trim(),
          type: draft.type,
          parentId: draft.parentId,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        },
      });
      const path = locationPath(row.id, [...nodes, { ...row, type: row.type as FlType }]);
      await auditLog({
        userId: ctx.userId, userRole: ctx.userRole,
        action: 'FUNCTIONAL_LOCATION_CREATED',
        targetType: 'functional_location', targetId: row.id,
        afterValue: { location: path, name: row.name, type: row.type, parentId: row.parentId },
        signatureMeaning: `Functional location "${path}" created`,
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
      return row;
    });
    return reply.code(201).send({ ...created, ownCount: 0, totalCount: 0 });
  });

  // PUT /:id — rename / re-parent.
  // REGISTERED BEFORE `/:id` ON PURPOSE.
  //
  // Not a style choice: with `/:id` first, `PUT /api/functional-locations/order`
  // was matched as "update the location whose id is 'order'" and answered 404.
  // That was verified, not assumed - the first version of this route sat at the
  // bottom of the file and its own test caught it. The same rule is written at
  // the `/:id` route in modules/debug-traces/routes.ts for the same reason.
  // PUT /order — set the manual display order of a set of SIBLINGS.
  //
  // Reuses FUNCTIONAL_LOCATION_UPDATE and the UPDATE_FUNCTIONAL_LOCATION reauth
  // action rather than inventing a permission: this changes a property of
  // locations the caller can already rename, and a separate permission for
  // "may reorder but not rename" is a distinction no operator asked for.
  //
  // Takes the WHOLE sibling set, not a single move. A "move item up" endpoint
  // has to renumber its neighbour too, so two concurrent moves interleave into
  // an order neither operator chose. Sending the full list makes the request
  // the operator's intended arrangement, and the last writer wins visibly
  // rather than silently merging.
  app.put('/order', {
    preHandler: [app.requirePermission('FUNCTIONAL_LOCATION_UPDATE')],
    schema: {
      tags: ['Functional Locations'],
      summary: 'Set the display order of sibling functional locations',
      description:
        'Assigns sort_order 1..N to the supplied ids, in the order given. All ids '
        + 'must be siblings (same parent). Blocks are siblings of each other; an '
        + "Area's siblings are the other Areas of its Block.",
      body: {
        type: 'object',
        required: ['ids'],
        properties: {
          ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
        },
        additionalProperties: false,
      },
      response: {
        200: {
          type: 'object',
          properties: {
            updated: { type: 'integer' },
            order: { type: 'array', items: { type: 'string' } },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_FUNCTIONAL_LOCATION', req, reply);
    if (!ok) return;

    const { ids } = req.body as { ids: string[] };
    const ctx = buildContext(req);

    if (new Set(ids).size !== ids.length) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: 'The same location appears more than once in the requested order.',
      });
    }

    const rows = await prisma.functionalLocation.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, parentId: true, sortOrder: true },
    });
    if (rows.length !== ids.length) {
      return reply.code(404).send({
        error: 'NOT_FOUND',
        message: 'One or more of the supplied locations does not exist.',
      });
    }

    // All one parent. Mixing levels would let a caller interleave a Block with
    // another Block's Areas, producing an order the tree cannot render.
    const parents = new Set(rows.map((r) => r.parentId ?? '@root'));
    if (parents.size > 1) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: 'All locations in one reorder must share the same parent.',
      });
    }

    // The full sibling set must be present, or the omitted ones keep stale
    // numbers and jump somewhere nobody asked for the next time the list renders.
    const parentId = rows[0].parentId ?? null;
    const siblingCount = await prisma.functionalLocation.count({ where: { parentId } });
    if (siblingCount !== ids.length) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message:
          `Send the complete set of siblings: ${siblingCount} exist, ${ids.length} supplied.`,
      });
    }

    const before = [...rows]
      .sort((a, b) => (a.sortOrder - b.sortOrder) || a.name.localeCompare(b.name))
      .map((r) => r.name);
    const nameById = new Map(rows.map((r) => [r.id, r.name]));
    const after = ids.map((id) => nameById.get(id) ?? id);

    // 1-based: 0 is the "never arranged" default, and keeping it distinct means
    // an arranged set can never be confused with an untouched one.
    await prisma.$transaction(
      ids.map((id, i) =>
        prisma.functionalLocation.update({
          where: { id },
          data: { sortOrder: i + 1, updatedBy: ctx.userId },
        }),
      ),
    );

    const nodes = await loadNodes();
    const path = parentId ? locationPath(parentId, nodes) : null;
    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'FUNCTIONAL_LOCATION_UPDATED',
      targetType: 'functional_location',
      targetId: parentId ?? 'root',
      // Names, not ids. Someone reading this row a year from now is asking
      // "what order did they choose?", and a list of uuids cannot answer it.
      beforeValue: { scope: path ?? 'Blocks', order: before },
      afterValue: { scope: path ?? 'Blocks', order: after },
      // `signature_meaning` is VARCHAR(255) and the insert is raw, so a
      // meaning longer than that is a 500, not a truncation — found 2026-10-03
      // when the test database's leftover blocks pushed this one past it. The
      // full order is in `afterValue`; the meaning names what fits and counts
      // the rest.
      signatureMeaning: boundedMeaning(
        `Display order of ${ids.length} functional location(s) under "${path ?? 'Blocks'}" changed to: `, after,
      ),
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });

    return { updated: ids.length, order: ids };
  });

  app.put('/:id', {
    preHandler: [app.requirePermission('FUNCTIONAL_LOCATION_UPDATE')],
    schema: {
      tags: ['Functional Locations'],
      summary: 'Rename or re-parent a functional location',
      params: { type: 'object', properties: { id: { type: 'string' } } },
      response: { 200: { type: 'object', properties: flProps }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_FUNCTIONAL_LOCATION', req, reply);
    if (!ok) return;

    const { id } = req.params as { id: string };
    const ctx = buildContext(req);
    const body = sanitizeStrings((req.body ?? {}) as Record<string, unknown>, IDENTITY_FIELDS);

    const nodes = await loadNodes();
    const current = nodes.find((n) => n.id === id);
    if (!current) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Functional location not found.' });

    const draft = {
      name: body.name === undefined ? current.name : String(body.name),
      type: (body.type === undefined ? current.type : body.type === 'AREA' ? 'AREA' : 'BLOCK') as FlType,
      parentId: body.parentId === undefined ? current.parentId : ((body.parentId as string | null) ?? null),
    };
    const parent = draft.parentId ? nodes.find((n) => n.id === draft.parentId) ?? null : null;
    // SELF EXCLUDED from siblingNames. The validator cannot know its own current
    // name, so without this a rename that keeps the same name is rejected.
    const siblings = nodes
      .filter((n) => (n.parentId ?? null) === draft.parentId && n.id !== id)
      .map((n) => n.name);

    const err = validateFlDraft(draft, parent, siblings, id);
    if (err) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: err.message, field: err.field });

    // Demoting a BLOCK that still has Areas would orphan them.
    if (current.type === 'BLOCK' && draft.type === 'AREA') {
      const kids = nodes.filter((n) => n.parentId === id).length;
      if (kids > 0) {
        return reply.code(409).send({
          error: 'HAS_CHILDREN',
          message: `"${current.name}" has ${kids} area(s) and cannot become an Area itself. Move or delete them first.`,
        });
      }
    }

    const before = locationPath(id, nodes);
    // Mutation and audit row in ONE transaction (audit 2026-10-03, API-4).
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.functionalLocation.update({
        where: { id },
        data: { name: draft.name.trim(), type: draft.type, parentId: draft.parentId, updatedBy: ctx.userId },
      });
      // The path after the change, from the nodes already loaded with this
      // row's new name / parent substituted — no second read inside the tx.
      const after = locationPath(id, nodes.map((n) => (n.id === id
        ? { ...n, name: row.name, type: row.type as FlType, parentId: row.parentId }
        : n)));
      await auditLog({
        userId: ctx.userId, userRole: ctx.userRole,
        action: 'FUNCTIONAL_LOCATION_UPDATED',
        targetType: 'functional_location', targetId: id,
        beforeValue: { location: before, name: current.name, type: current.type, parentId: current.parentId },
        afterValue: { location: after, name: row.name, type: row.type, parentId: row.parentId },
        signatureMeaning: `Functional location "${before}" updated`,
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
      return row;
    });
    // `loadOwnCounts` returns {total, active} per id; the response declares
    // integers (audit 2026-10-03, API-3 — the object made the serializer throw
    // AFTER the rename and its audit row had committed, so every rename of a
    // location holding an instrument read as "could not save").
    const counts = await loadOwnCounts();
    const c = counts.get(id);
    return { ...updated, ownCount: c?.total ?? 0, totalCount: c?.total ?? 0, activeCount: c?.active ?? 0 };
  });

  // DELETE /:id — refused while it holds anything, UNLESS a SUPER_ADMIN asks
  // for `?cascade=true` (2026-10-03, operator: "add delete option for
  // functional locations for super admin"). Then the Block's Areas go with it
  // and every instrument in any of them is UNLINKED — set to no location, never
  // deleted: an instrument is a registered device with its readings and alarms,
  // and a grouping being removed is no reason to lose any of that. Each
  // location deleted gets its own audit row naming the instruments it released.
  //
  // Only a super admin, and only when asked explicitly: a role holding
  // FUNCTIONAL_LOCATION_DELETE still gets the 409 for a non-empty location, so
  // nobody deletes a hundred instruments' grouping by mistaking the button.
  // What a cascade does NOT touch, stated once: a role or user whose instrument
  // scope named the location keeps the stale id (the location branch then
  // grants nothing; the instruments are reachable again when re-linked or named
  // outright), and an alarm webhook target scoped to it likewise.
  app.delete('/:id', {
    preHandler: [app.requirePermission('FUNCTIONAL_LOCATION_DELETE')],
    schema: {
      tags: ['Functional Locations'],
      summary: 'Delete a functional location (a SUPER_ADMIN may delete one that holds areas and instruments with ?cascade=true)',
      params: { type: 'object', properties: { id: { type: 'string' } } },
      querystring: { type: 'object', properties: { cascade: { type: 'boolean' } } },
      response: { 204: { type: 'null' }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('DELETE_FUNCTIONAL_LOCATION', req, reply);
    if (!ok) return;

    const { id } = req.params as { id: string };
    const cascade = (req.query as { cascade?: boolean }).cascade === true;
    const ctx = buildContext(req);
    const nodes = await loadNodes();
    const current = nodes.find((n) => n.id === id);
    if (!current) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Functional location not found.' });

    // Everything under it: its Areas (the tree is BLOCK > AREA, so these are
    // all the descendants) and the instruments linked to it or to them.
    const ids = resolveLocationIds(id, nodes);
    const areas = nodes.filter((n) => n.parentId === id);
    const linked = await prisma.instrument.findMany({
      where: { functionalLocationId: { in: ids } },
      select: { id: true, code: true, functionalLocationId: true },
      orderBy: { code: 'asc' },
    });

    // The FK is RESTRICT, so the database would refuse this anyway — but a
    // constraint error is not something an operator can act on. These 409s name
    // the counts so they know what to move.
    if (areas.length > 0 || linked.length > 0) {
      const parts = [
        linked.length > 0 ? `${linked.length} instrument(s)` : null,
        areas.length > 0 ? `${areas.length} area(s)` : null,
      ].filter(Boolean).join(' and ');
      if (!cascade) {
        return reply.code(409).send({
          error: 'NOT_EMPTY',
          message: `"${current.name}" still holds ${parts}. Move or unlink them before deleting it${ctx.userRole === 'SUPER_ADMIN' ? ', or delete it with everything in it' : ''}.`,
        });
      }
      if (ctx.userRole !== 'SUPER_ADMIN') {
        return reply.code(403).send({
          error: 'SUPER_ADMIN_ONLY',
          message: `Only a super admin can delete "${current.name}" while it holds ${parts}.`,
        });
      }
    }

    const path = locationPath(id, nodes);
    await prisma.$transaction(async (tx) => {
      // Instruments first, released from every location about to go.
      if (linked.length > 0) {
        await tx.instrument.updateMany({ where: { id: { in: linked.map((i) => i.id) } }, data: { functionalLocationId: null } });
      }
      // Areas before their Block (the parent FK is RESTRICT), one audit row each.
      for (const area of areas) {
        await tx.functionalLocation.delete({ where: { id: area.id } });
        await auditLog({
          userId: ctx.userId, userRole: ctx.userRole,
          action: 'FUNCTIONAL_LOCATION_DELETED',
          targetType: 'functional_location', targetId: area.id,
          beforeValue: {
            location: locationPath(area.id, nodes), name: area.name, type: area.type, parentId: area.parentId,
            instrumentsUnlinked: linked.filter((i) => i.functionalLocationId === area.id).map((i) => i.code),
          },
          signatureMeaning: `Functional location "${locationPath(area.id, nodes)}" deleted with its block "${current.name}"`,
          ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
        }, tx);
      }
      await tx.functionalLocation.delete({ where: { id } });
      await auditLog({
        userId: ctx.userId, userRole: ctx.userRole,
        action: 'FUNCTIONAL_LOCATION_DELETED',
        targetType: 'functional_location', targetId: id,
        beforeValue: {
          location: path, name: current.name, type: current.type, parentId: current.parentId,
          ...(cascade ? {
            areasDeleted: areas.map((a) => a.name),
            instrumentsUnlinked: linked.filter((i) => i.functionalLocationId === id).map((i) => i.code),
            instrumentsUnlinkedInAreas: linked.filter((i) => i.functionalLocationId !== id).map((i) => i.code),
          } : {}),
        },
        signatureMeaning: cascade && (areas.length > 0 || linked.length > 0)
          ? `Functional location "${path}" deleted with ${areas.length} area(s); ${linked.length} instrument(s) unlinked`
          : `Functional location "${path}" deleted`,
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
    });
    return reply.code(204).send();
  });

  // PUT /:id/instruments — set membership wholesale.
  //
  // Mirrors PUT /api/floorplans/:id/rooms/:roomId/instruments so there is one way
  // to do this in the codebase. Linking an instrument that already belongs
  // elsewhere MOVES it; that is the documented behaviour, and the audit row
  // records both sides so the move is attributable.
  app.put('/:id/instruments', {
    preHandler: [app.requirePermission('FUNCTIONAL_LOCATION_UPDATE')],
    schema: {
      tags: ['Functional Locations'],
      summary: 'Set which instruments belong to this functional location',
      params: { type: 'object', properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        properties: { instrumentIds: { type: 'array', items: { type: 'string' } } },
        required: ['instrumentIds'],
      },
      response: {
        200: {
          type: 'object',
          properties: { linked: { type: 'integer' }, unlinked: { type: 'integer' }, moved: { type: 'integer' } },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_FUNCTIONAL_LOCATION', req, reply);
    if (!ok) return;

    const { id } = req.params as { id: string };
    const { instrumentIds } = req.body as { instrumentIds: string[] };
    const ctx = buildContext(req);

    const nodes = await loadNodes();
    const current = nodes.find((n) => n.id === id);
    if (!current) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Functional location not found.' });

    const wanted = [...new Set(instrumentIds)];
    const existing = await prisma.instrument.findMany({
      where: { OR: [{ functionalLocationId: id }, { id: { in: wanted } }] },
      select: { id: true, code: true, functionalLocationId: true },
    });

    const toLink = existing.filter((i) => wanted.includes(i.id) && i.functionalLocationId !== id);
    const toUnlink = existing.filter((i) => i.functionalLocationId === id && !wanted.includes(i.id));
    const moved = toLink.filter((i) => i.functionalLocationId !== null);

    const path = locationPath(id, nodes);
    // Links and their audit row in ONE transaction (audit 2026-10-03, API-4).
    await prisma.$transaction(async (tx) => {
      if (toLink.length) {
        await tx.instrument.updateMany({ where: { id: { in: toLink.map((i) => i.id) } }, data: { functionalLocationId: id } });
      }
      if (toUnlink.length) {
        await tx.instrument.updateMany({ where: { id: { in: toUnlink.map((i) => i.id) } }, data: { functionalLocationId: null } });
      }
      await auditLog({
        userId: ctx.userId, userRole: ctx.userRole,
        action: 'FUNCTIONAL_LOCATION_INSTRUMENTS_CHANGED',
        targetType: 'functional_location', targetId: id,
        beforeValue: {
          location: path,
          linked: existing.filter((i) => i.functionalLocationId === id).map((i) => i.code),
        },
        afterValue: {
          location: path,
          linked: wanted.map((w) => existing.find((i) => i.id === w)?.code ?? w),
          movedFromElsewhere: moved.map((i) => i.code),
        },
        signatureMeaning: `Instruments linked to functional location "${path}" changed`,
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
    });

    return { linked: toLink.length, unlinked: toUnlink.length, moved: moved.length };
  });
}
