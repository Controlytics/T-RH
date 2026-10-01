import { type FastifyInstance, type FastifyReply } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { auditLog } from '../../lib/audit.js';
import { buildContext } from '../../lib/build-context.js';
import { enforceReauth } from '../../lib/reauth-check.js';
import { errorResponses } from '../../lib/error-schemas.js';
import { sanitizeStrings } from '../../lib/sanitize.js';
import { validateRoomPayload, roomGeometry, validateLinkPayload, floorplanSchema, floorplanUpdateSchema, type RoomDoor, type LinkInput } from './validation.js';
import { sharedEdges, rectanglePoints, type Point, type Polygon } from '@digilog/shared';
import { getRoomHistory, HISTORY_WINDOWS, type HistoryWindow } from './room-history.js';
import { resolveVisibility } from '../instruments/visibility.js';

/**
 * Floorplans, their rooms, and which instruments sit in each.
 *
 * Reads gate on CONFIG_READ, writes on CONFIG_UPDATE with re-authentication.
 * EVERY WRITE IS AUDITED: a room holds the environmental specification for a
 * space, so "who changed this limit, from what, to what" must be answerable.
 * This is the opposite of telemetry itself, which stays deliberately unaudited
 * as process data — do not add auditLog() to telemetry.repository.ts.
 *
 * Design: docs/superpowers/specs/2026-08-11-instrument-dashboard-floorplan-design.md
 */

/**
 * Exempt from HTML stripping, mirroring instruments/routes.ts.
 *
 * `sanitizeStrings` strips anything tag-shaped and decodes entities — right for
 * prose, wrong for identifiers. A room code is drafting-office text like
 * `CWH-I/142` that must round-trip byte-identical, because it is what the
 * operator matches against the printed drawing.
 */
const IDENTITY_FIELDS = ['code', 'name', 'label'];

/**
 * `doors` is a Json column, so a SQL NULL needs Prisma.DbNull —
 * Prisma.JsonNull would store the JSON literal `null`, which reads back as a
 * value rather than an absence.
 */
function doorsForWrite(doors: RoomDoor[] | null | undefined) {
  return doors == null ? Prisma.DbNull : doors;
}

/** Readable in an audit entry. A raw JSON blob is not something an inspector can diff. */
function doorSummary(doors: unknown): string[] {
  if (!Array.isArray(doors)) return [];
  return doors.map((d) => {
    // Safe only because this module reads back doors solely through the
    // validated write path above; a hand-edited row in the DB could violate it.
    const door = d as RoomDoor;
    return `${door.kind} on ${door.wall ?? `edge ${door.edge}`} @ ${door.offset}`;
  });
}

const roomSelect = {
  id: true, code: true, label: true,
  x: true, y: true, w: true, h: true,
  tempMin: true, tempMax: true, rhMin: true, rhMax: true,
  doors: true, grade: true, meta: true, points: true,
} as const;

const roomProps = {
  id: { type: 'string' },
  code: { type: 'string' },
  label: { type: 'string', nullable: true },
  x: { type: 'number' }, y: { type: 'number' },
  w: { type: 'number' }, h: { type: 'number' },
  tempMin: { type: 'number', nullable: true },
  tempMax: { type: 'number', nullable: true },
  rhMin: { type: 'number', nullable: true },
  rhMax: { type: 'number', nullable: true },
  doors: {
    type: 'array',
    nullable: true,
    items: {
      type: 'object',
      properties: {
        wall: { type: 'string', nullable: true },
        edge: { type: 'integer', nullable: true },
        offset: { type: 'number' },
        width: { type: 'number' },
        kind: { type: 'string' },
        // Declared (2026-10-01), or Fastify strips it and every door hinges at its start.
        hinge: { type: 'string' },
      },
    },
  },
  // The polygon outline (Layout Designer, 2026-09-22). NULL = a rectangle.
  // Declared, or Fastify strips it and every polygon room draws as its box.
  points: {
    type: 'array',
    nullable: true,
    items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } },
  },
  // NULL = nobody has classified this room; renders white as before this
  // field existed. Fastify strips undeclared response properties, so this
  // entry is what actually lets the value reach the browser.
  grade: { type: 'string', nullable: true },
  // What the DRAWING says about this room: its drawn fill colour, finished
  // ceiling height and floor dimensions. NULL on every generated plan.
  // `fill` overrides the grade hue on a traced plan — see qc-layout.ts.
  meta: {
    type: 'object',
    nullable: true,
    properties: {
      fill: { type: 'string' },
      fch: { type: 'string' },
      dims: { type: 'string' },
    },
  },
} as const;

/** A link on the wire. Declared in full: Fastify strips what it does not name. */
const linkSelect = {
  id: true, fromRoomId: true, toRoomId: true, kind: true,
  fromEdge: true, offset: true, width: true, door: true, label: true,
} as const;

const linkProps = {
  id: { type: 'string' },
  fromRoomId: { type: 'string' },
  toRoomId: { type: 'string' },
  kind: { type: 'string' },
  fromEdge: { type: 'integer', nullable: true },
  offset: { type: 'number', nullable: true },
  width: { type: 'number', nullable: true },
  door: { type: 'string', nullable: true },
  label: { type: 'string', nullable: true },
} as const;

/** The outline the geometry checks run on: the polygon, else the rectangle's four corners. */
function polygonOf(room: { x: number; y: number; w: number; h: number; points: unknown }): Polygon {
  return Array.isArray(room.points) ? (room.points as unknown as Point[]) : rectanglePoints(room);
}

const planProps = {
  id: { type: 'string' },
  name: { type: 'string' },
  imagePath: { type: 'string', nullable: true },
  imageWidth: { type: 'integer' },
  imageHeight: { type: 'integer' },
  isActive: { type: 'boolean' },
  sortOrder: { type: 'integer' },
  // Everything on the plan that is not a room. NULL on a generated plan, and
  // the dashboard draws no legend when it is absent. Declared here because
  // Fastify strips undeclared response properties — the same omission has cost
  // this repo twice before.
  annotations: {
    type: 'object',
    nullable: true,
    properties: {
      equipment: { type: 'array', items: { type: 'object', properties: {
        x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } } } },
      hvac: { type: 'array', items: { type: 'object', properties: {
        x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } } } },
      water: { type: 'array', items: { type: 'object', properties: {
        x: { type: 'number' }, y: { type: 'number' } } } },
      airflow: { type: 'array', items: { type: 'object', properties: {
        y: { type: 'number' }, x0: { type: 'number' }, x1: { type: 'number' } } } },
      labels: { type: 'array', items: { type: 'object', properties: {
        x: { type: 'number' }, y: { type: 'number' }, text: { type: 'string' } } } },
      // The building's STRUCTURE (2026-10-01, QC Layout-2) — the one part of
      // the layer the dashboard draws. Declared, or Fastify strips it.
      columns: { type: 'array', items: { type: 'object', properties: {
        x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } } } },
      windows: { type: 'array', items: { type: 'object', properties: {
        x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } } } },
      walls: { type: 'array', items: { type: 'object', properties: {
        x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' } } } },
    },
  },
} as const;

export default async function floorplanRoutes(app: FastifyInstance) {
  // ───────────────────────────── Plans ─────────────────────────────

  app.get('/', {
    preHandler: [app.requirePermission('CONFIG_READ')],
    schema: {
      tags: ['Floorplans'],
      summary: 'List floorplans with their rooms',
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  ...planProps,
                  rooms: { type: 'array', items: { type: 'object', properties: roomProps } },
                  links: { type: 'array', items: { type: 'object', properties: linkProps } },
                },
              },
            },
          },
        },
        ...errorResponses,
      },
    },
  }, async () => {
    const data = await prisma.floorplan.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        rooms: { select: roomSelect, orderBy: { code: 'asc' } },
        links: { select: linkSelect, orderBy: { createdAt: 'asc' } },
      },
    });
    return { data };
  });

  app.get('/:id', {
    preHandler: [app.requirePermission('CONFIG_READ')],
    schema: {
      tags: ['Floorplans'],
      summary: 'One floorplan with its rooms and the instruments in them',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const plan = await prisma.floorplan.findUnique({
      where: { id },
      include: {
        rooms: {
          orderBy: { code: 'asc' },
          include: { instruments: { select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } } },
        },
        links: { select: linkSelect, orderBy: { createdAt: 'asc' } },
      },
    });
    if (!plan) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Floorplan not found.' });
    return plan;
  });

  app.post('/', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: {
      tags: ['Floorplans'],
      summary: 'Create a floorplan',
      response: { 201: { type: 'object', properties: planProps }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_FLOORPLAN', req, reply);
    if (!ok) return;

    const ctx = buildContext(req);
    const parsed = floorplanSchema.safeParse(
      sanitizeStrings((req.body ?? {}) as Record<string, unknown>, IDENTITY_FIELDS),
    );
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
    }

    try {
      const plan = await prisma.floorplan.create({
        data: { ...parsed.data, createdBy: ctx.userId, updatedBy: ctx.userId },
      });
      await auditLog({
        userId: ctx.userId, userRole: ctx.userRole,
        action: 'FLOORPLAN_CREATED',
        targetType: 'floorplan', targetId: plan.id,
        afterValue: {
          name: plan.name, imagePath: plan.imagePath,
          imageWidth: plan.imageWidth, imageHeight: plan.imageHeight,
          isActive: plan.isActive, sortOrder: plan.sortOrder,
        },
        signatureMeaning: `Floorplan "${plan.name}" created`,
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      });
      return reply.code(201).send(plan);
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        return reply.code(409).send({
          error: 'DUPLICATE_NAME',
          message: `A floorplan named "${parsed.data.name}" already exists.`,
        });
      }
      throw err;
    }
  });

  app.put('/:id', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: {
      tags: ['Floorplans'],
      summary: 'Update a floorplan',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      response: { 200: { type: 'object', properties: planProps }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_FLOORPLAN', req, reply);
    if (!ok) return;

    const { id } = req.params as { id: string };
    const ctx = buildContext(req);
    const before = await prisma.floorplan.findUnique({ where: { id } });
    if (!before) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Floorplan not found.' });

    const parsed = floorplanUpdateSchema.safeParse(
      sanitizeStrings((req.body ?? {}) as Record<string, unknown>, IDENTITY_FIELDS),
    );
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
    }

    try {
      const after = await prisma.floorplan.update({
        where: { id },
        data: { ...parsed.data, updatedBy: ctx.userId },
      });
      await auditLog({
        userId: ctx.userId, userRole: ctx.userRole,
        action: 'FLOORPLAN_UPDATED',
        targetType: 'floorplan', targetId: id,
        beforeValue: { name: before.name, isActive: before.isActive, sortOrder: before.sortOrder },
        afterValue: { name: after.name, isActive: after.isActive, sortOrder: after.sortOrder },
        signatureMeaning: `Floorplan "${after.name}" updated`,
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      });
      return after;
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        return reply.code(409).send({ error: 'DUPLICATE_NAME', message: 'Another floorplan already has that name.' });
      }
      throw err;
    }
  });

  app.delete('/:id', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: {
      tags: ['Floorplans'],
      summary: 'Delete a floorplan and its rooms',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      response: { 204: { type: 'null' }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_FLOORPLAN', req, reply);
    if (!ok) return;

    const { id } = req.params as { id: string };
    const ctx = buildContext(req);
    const before = await prisma.floorplan.findUnique({
      where: { id },
      include: { rooms: { select: { id: true, code: true } } },
    });
    if (!before) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Floorplan not found.' });

    // Rooms cascade. Instruments in them are UNLINKED, never deleted
    // (Instrument.roomId is ON DELETE SET NULL) — they reappear in the
    // dashboard's "not placed" tray rather than vanishing with the plan.
    await prisma.floorplan.delete({ where: { id } });
    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'FLOORPLAN_DELETED',
      targetType: 'floorplan', targetId: id,
      beforeValue: { name: before.name, rooms: before.rooms.map((r) => r.code) },
      signatureMeaning: `Floorplan "${before.name}" deleted with ${before.rooms.length} room(s)`,
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });
    return reply.code(204).send();
  });

  // ───────────────────────────── Rooms ─────────────────────────────

  app.post('/:id/rooms', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: {
      tags: ['Floorplans'],
      summary: 'Add a room to a floorplan',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      response: { 201: { type: 'object', properties: roomProps }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_FLOORPLAN_ROOM', req, reply);
    if (!ok) return;

    const { id } = req.params as { id: string };
    const ctx = buildContext(req);
    const plan = await prisma.floorplan.findUnique({ where: { id }, select: { id: true, name: true } });
    if (!plan) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Floorplan not found.' });

    const result = validateRoomPayload(
      sanitizeStrings((req.body ?? {}) as Record<string, unknown>, IDENTITY_FIELDS),
    );
    if (!result.ok) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: result.error });

    try {
      const { doors, points, ...roomData } = result.data;
      const room = await prisma.floorplanRoom.create({
        data: {
          ...roomData,
          // A polygon's box is DERIVED; the client's box is ignored.
          ...roomGeometry(result.data),
          points: points ?? Prisma.DbNull,
          doors: doorsForWrite(doors),
          floorplanId: id,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        },
      });
      await auditLog({
        userId: ctx.userId, userRole: ctx.userRole,
        action: 'FLOORPLAN_ROOM_CREATED',
        targetType: 'floorplan_room', targetId: room.id,
        afterValue: {
          floorplan: plan.name, code: room.code, label: room.label,
          geometry: { x: room.x, y: room.y, w: room.w, h: room.h, corners: Array.isArray(room.points) ? room.points.length : 4 },
          limits: { tempMin: room.tempMin, tempMax: room.tempMax, rhMin: room.rhMin, rhMax: room.rhMax },
          doors: doorSummary(room.doors),
          grade: room.grade,
        },
        signatureMeaning: `Room "${room.code}" added to floorplan "${plan.name}"`,
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      });
      return reply.code(201).send(room);
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        return reply.code(409).send({
          error: 'DUPLICATE_CODE',
          message: `This plan already has a room "${result.data.code}".`,
        });
      }
      throw err;
    }
  });

  app.put('/:id/rooms/:roomId', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: {
      tags: ['Floorplans'],
      summary: 'Update a room',
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          roomId: { type: 'string', format: 'uuid' },
        },
      },
      response: { 200: { type: 'object', properties: roomProps }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_FLOORPLAN_ROOM', req, reply);
    if (!ok) return;

    const { id, roomId } = req.params as { id: string; roomId: string };
    const ctx = buildContext(req);
    const before = await prisma.floorplanRoom.findFirst({ where: { id: roomId, floorplanId: id } });
    if (!before) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: 'Room not found on this floorplan.' });
    }

    const result = validateRoomPayload(
      sanitizeStrings((req.body ?? {}) as Record<string, unknown>, IDENTITY_FIELDS),
    );
    if (!result.ok) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: result.error });

    try {
      // An OMITTED `doors` key must leave the stored column UNCHANGED — a
      // client that doesn't know about doors yet (or simply didn't touch them)
      // must not silently wipe every door drawn on this room. Only an EXPLICIT
      // `null` or `[]` clears it, so `doors` is left out of the Prisma `data`
      // entirely when the key was never sent, rather than passed through
      // doorsForWrite (which would map that `undefined` to Prisma.DbNull).
      const { doors, points, ...roomData } = result.data;
      // The same rule for `points`: OMITTED leaves the polygon as it is and,
      // because the box of a polygon room is DERIVED, the box the client sent
      // is replaced by the stored polygon's box — a client that predates
      // polygons must not flatten a polygon room into the rectangle it drew.
      // An explicit null clears the polygon and the sent box stands.
      const storedPoints = Array.isArray(before.points) ? (before.points as unknown as Point[]) : null;
      const effectivePoints = points === undefined ? storedPoints : points;
      const after = await prisma.floorplanRoom.update({
        where: { id: roomId },
        data: {
          ...roomData,
          ...roomGeometry({ ...result.data, points: effectivePoints }),
          ...(points !== undefined ? { points: points ?? Prisma.DbNull } : {}),
          ...(doors !== undefined ? { doors: doorsForWrite(doors) } : {}),
          updatedBy: ctx.userId,
        },
      });
      // before/after carry the LIMITS explicitly: they are the quality
      // specification, and an inspector must be able to read the change without
      // diffing two opaque blobs.
      await auditLog({
        userId: ctx.userId, userRole: ctx.userRole,
        action: 'FLOORPLAN_ROOM_UPDATED',
        targetType: 'floorplan_room', targetId: roomId,
        beforeValue: {
          code: before.code, label: before.label,
          geometry: { x: before.x, y: before.y, w: before.w, h: before.h, corners: Array.isArray(before.points) ? before.points.length : 4 },
          limits: { tempMin: before.tempMin, tempMax: before.tempMax, rhMin: before.rhMin, rhMax: before.rhMax },
          doors: doorSummary(before.doors),
          grade: before.grade,
        },
        afterValue: {
          code: after.code, label: after.label,
          geometry: { x: after.x, y: after.y, w: after.w, h: after.h, corners: Array.isArray(after.points) ? after.points.length : 4 },
          limits: { tempMin: after.tempMin, tempMax: after.tempMax, rhMin: after.rhMin, rhMax: after.rhMax },
          doors: doorSummary(after.doors),
          grade: after.grade,
        },
        signatureMeaning: `Room "${after.code}" updated`,
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      });
      return after;
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        return reply.code(409).send({
          error: 'DUPLICATE_CODE',
          message: `This plan already has a room "${result.data.code}".`,
        });
      }
      throw err;
    }
  });

  app.delete('/:id/rooms/:roomId', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: {
      tags: ['Floorplans'],
      summary: 'Delete a room',
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          roomId: { type: 'string', format: 'uuid' },
        },
      },
      response: { 204: { type: 'null' }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_FLOORPLAN_ROOM', req, reply);
    if (!ok) return;

    const { id, roomId } = req.params as { id: string; roomId: string };
    const ctx = buildContext(req);
    const before = await prisma.floorplanRoom.findFirst({
      where: { id: roomId, floorplanId: id },
      include: { instruments: { select: { id: true, code: true } } },
    });
    if (!before) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: 'Room not found on this floorplan.' });
    }

    await prisma.floorplanRoom.delete({ where: { id: roomId } });
    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'FLOORPLAN_ROOM_DELETED',
      targetType: 'floorplan_room', targetId: roomId,
      beforeValue: {
        code: before.code, label: before.label,
        limits: { tempMin: before.tempMin, tempMax: before.tempMax, rhMin: before.rhMin, rhMax: before.rhMax },
        // Named, because deleting the room unplaces every one of them.
        instruments: before.instruments.map((i) => i.code),
      },
      signatureMeaning:
        `Room "${before.code}" deleted; ${before.instruments.length} instrument(s) unplaced`,
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });
    return reply.code(204).send();
  });

  // GET /:id/rooms/:roomId/history — time-series for the whole room.
  //
  // Gated on INSTRUMENT_READ, not CONFIG_READ: this returns telemetry, and
  // anyone who may see the dashboard may see it. Only the geometry and limit
  // WRITES are a configuration capability.
  // ───────────────────────────── Links ─────────────────────────────
  // A relation the drawing states between two rooms (Layout Designer,
  // 2026-09-22). The OPENING kind is checked against the rooms' real outlines:
  // nothing is stored that the dashboard could not cut out of a wall.

  type LinkRoom = { id: string; code: string; x: number; y: number; w: number; h: number; points: unknown };

  /**
   * Both rooms on this plan; for an OPENING, the named edge really shared and
   * the opening inside the shared stretch; for a CONNECTOR, no second one for
   * the same pair. Sends the 4xx itself and returns null — the caller just
   * returns.
   */
  async function checkLink(planId: string, l: LinkInput, currentLinkId: string | null, reply: FastifyReply):
    Promise<{ from: LinkRoom; to: LinkRoom } | null> {
    const rooms = await prisma.floorplanRoom.findMany({
      where: { floorplanId: planId, id: { in: [l.fromRoomId, l.toRoomId] } },
      select: { id: true, code: true, x: true, y: true, w: true, h: true, points: true },
    });
    const from = rooms.find((r) => r.id === l.fromRoomId);
    const to = rooms.find((r) => r.id === l.toRoomId);
    if (!from || !to) {
      reply.code(404).send({ error: 'NOT_FOUND', message: 'Both rooms must be on this floorplan.' });
      return null;
    }
    if (l.kind === 'OPENING') {
      const shared = sharedEdges(polygonOf(from), polygonOf(to)).find((s) =>
        s.aEdge === l.fromEdge && s.start - 1e-9 <= l.offset! && l.offset! + l.width! <= s.end + 1e-9);
      if (!shared) {
        reply.code(400).send({ error: 'NOT_ADJACENT', message: `"${from.code}" and "${to.code}" do not share that stretch of wall.` });
        return null;
      }
    }
    if (l.kind === 'CONNECTOR') {
      const dup = await prisma.floorplanRoomLink.findFirst({
        where: {
          floorplanId: planId, kind: 'CONNECTOR',
          OR: [{ fromRoomId: l.fromRoomId, toRoomId: l.toRoomId }, { fromRoomId: l.toRoomId, toRoomId: l.fromRoomId }],
        },
        select: { id: true },
      });
      if (dup && dup.id !== currentLinkId) {
        reply.code(409).send({ error: 'DUPLICATE_LINK', message: 'These two rooms are already connected.' });
        return null;
      }
    }
    return { from, to };
  }

  const linkBody = (l: LinkInput) => ({
    kind: l.kind,
    fromEdge: l.kind === 'OPENING' ? l.fromEdge! : null,
    offset: l.kind === 'OPENING' ? l.offset! : null,
    width: l.kind === 'OPENING' ? l.width! : null,
    door: l.kind === 'OPENING' ? (l.door ?? null) : null,
    label: l.kind === 'CONNECTOR' ? (l.label ?? null) : null,
  });
  const linkAudit = (l: { kind: string; fromEdge: number | null; offset: number | null; width: number | null; door: string | null; label: string | null }, code: string) => ({
    code, kind: l.kind, fromEdge: l.fromEdge, offset: l.offset, width: l.width, door: l.door, label: l.label,
  });
  const linkParams = {
    type: 'object',
    properties: { id: { type: 'string', format: 'uuid' }, linkId: { type: 'string', format: 'uuid' } },
  } as const;

  app.post('/:id/links', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: {
      tags: ['Floorplans'],
      summary: 'Link two rooms: an opening in their shared wall, or a connector',
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      response: { 201: { type: 'object', properties: linkProps }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_FLOORPLAN_ROOM', req, reply);
    if (!ok) return;
    const { id } = req.params as { id: string };
    const ctx = buildContext(req);
    const plan = await prisma.floorplan.findUnique({ where: { id }, select: { id: true, name: true } });
    if (!plan) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Floorplan not found.' });

    const result = validateLinkPayload(sanitizeStrings((req.body ?? {}) as Record<string, unknown>, ['label']));
    if (!result.ok) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: result.error });
    const rooms = await checkLink(id, result.data, null, reply);
    if (!rooms) return;

    const code = `${rooms.from.code} ↔ ${rooms.to.code}`;
    const created = await prisma.floorplanRoomLink.create({
      data: {
        ...linkBody(result.data),
        floorplanId: id, fromRoomId: rooms.from.id, toRoomId: rooms.to.id,
        createdBy: ctx.userId, updatedBy: ctx.userId,
      },
      select: linkSelect,
    });
    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'FLOORPLAN_LINK_CREATED',
      targetType: 'floorplan_room_link', targetId: created.id,
      afterValue: { floorplan: plan.name, ...linkAudit(created, code) },
      signatureMeaning: `Room link "${code}" created on floorplan "${plan.name}"`,
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });
    return reply.code(201).send(created);
  });

  app.put('/:id/links/:linkId', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: {
      tags: ['Floorplans'],
      summary: 'Update a room link',
      params: linkParams,
      response: { 200: { type: 'object', properties: linkProps }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_FLOORPLAN_ROOM', req, reply);
    if (!ok) return;
    const { id, linkId } = req.params as { id: string; linkId: string };
    const ctx = buildContext(req);
    const before = await prisma.floorplanRoomLink.findFirst({ where: { id: linkId, floorplanId: id }, select: linkSelect });
    if (!before) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Link not found on this floorplan.' });

    const result = validateLinkPayload(sanitizeStrings((req.body ?? {}) as Record<string, unknown>, ['label']));
    if (!result.ok) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: result.error });
    const rooms = await checkLink(id, result.data, linkId, reply);
    if (!rooms) return;

    const code = `${rooms.from.code} ↔ ${rooms.to.code}`;
    const after = await prisma.floorplanRoomLink.update({
      where: { id: linkId },
      data: { ...linkBody(result.data), fromRoomId: rooms.from.id, toRoomId: rooms.to.id, updatedBy: ctx.userId },
      select: linkSelect,
    });
    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'FLOORPLAN_LINK_UPDATED',
      targetType: 'floorplan_room_link', targetId: linkId,
      beforeValue: linkAudit(before, code),
      afterValue: linkAudit(after, code),
      signatureMeaning: `Room link "${code}" updated`,
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });
    return after;
  });

  app.delete('/:id/links/:linkId', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: {
      tags: ['Floorplans'],
      summary: 'Delete a room link',
      params: linkParams,
      response: { 204: { type: 'null' }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_FLOORPLAN_ROOM', req, reply);
    if (!ok) return;
    const { id, linkId } = req.params as { id: string; linkId: string };
    const ctx = buildContext(req);
    const before = await prisma.floorplanRoomLink.findFirst({
      where: { id: linkId, floorplanId: id },
      select: { ...linkSelect, fromRoom: { select: { code: true } }, toRoom: { select: { code: true } } },
    });
    if (!before) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Link not found on this floorplan.' });
    const code = `${before.fromRoom.code} ↔ ${before.toRoom.code}`;
    await prisma.floorplanRoomLink.delete({ where: { id: linkId } });
    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'FLOORPLAN_LINK_DELETED',
      targetType: 'floorplan_room_link', targetId: linkId,
      beforeValue: linkAudit(before, code),
      signatureMeaning: `Room link "${code}" deleted`,
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });
    return reply.code(204).send();
  });

  app.get('/:id/rooms/:roomId/history', {
    preHandler: [app.requirePermission('INSTRUMENT_READ')],
    schema: {
      tags: ['Floorplans'],
      summary: 'Time-series for every instrument in one room',
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          roomId: { type: 'string', format: 'uuid' },
        },
      },
      querystring: {
        type: 'object',
        properties: { window: { type: 'string', enum: HISTORY_WINDOWS, default: '1h' } },
      },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { id, roomId } = req.params as { id: string; roomId: string };
    const q = req.query as { window?: string };
    const window = (q.window ?? '1h') as HistoryWindow;
    if (!HISTORY_WINDOWS.includes(window)) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: `window must be one of: ${HISTORY_WINDOWS.join(', ')}`,
      });
    }

    const room = await prisma.floorplanRoom.findFirst({
      where: { id: roomId, floorplanId: id },
      select: {
        id: true, code: true, label: true,
        tempMin: true, tempMax: true, rhMin: true, rhMax: true,
      },
    });
    if (!room) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: 'Room not found on this floorplan.' });
    }

    // Instrument-visibility scoped, unlike the room CRUD around it. This route
    // is not configuration — it returns READINGS for whatever sits in the room —
    // so an instrument outside the caller's scope must contribute nothing. The
    // room itself and its limits are still returned: the room is a space, not an
    // instrument, and hiding it would empty the graphical view of geometry the
    // caller is entitled to see.
    const { where: visibility } = await resolveVisibility(buildContext(req));

    // Room limits ride along so the chart can draw its in-spec band without a
    // second request.
    return { room, ...(await getRoomHistory(roomId, window, visibility)) };
  });

  // PUT /:id/rooms/:roomId/instruments — set the room's membership wholesale.
  //
  // Wholesale rather than add/remove: the editor shows a checkbox list, and the
  // operator's intent is "these are the instruments in this room". A diffing API
  // would make the client responsible for computing that diff, and a client that
  // computes it wrong silently unplaces an instrument — the exact failure this
  // feature's "not placed" tray exists to make visible.
  app.put('/:id/rooms/:roomId/instruments', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: {
      tags: ['Floorplans'],
      summary: 'Set which instruments are in a room',
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          roomId: { type: 'string', format: 'uuid' },
        },
      },
      body: {
        type: 'object',
        properties: { instrumentIds: { type: 'array', items: { type: 'string' } } },
        required: ['instrumentIds'],
      },
      response: { 200: { type: 'object', additionalProperties: true }, ...errorResponses },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_FLOORPLAN_ROOM', req, reply);
    if (!ok) return;

    const { id, roomId } = req.params as { id: string; roomId: string };
    const ctx = buildContext(req);
    const room = await prisma.floorplanRoom.findFirst({
      where: { id: roomId, floorplanId: id },
      include: { instruments: { select: { id: true, code: true } } },
    });
    if (!room) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: 'Room not found on this floorplan.' });
    }

    const body = (req.body ?? {}) as { instrumentIds?: unknown };
    if (!Array.isArray(body.instrumentIds) || body.instrumentIds.some((v) => typeof v !== 'string')) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: 'instrumentIds must be an array of instrument ids.',
      });
    }
    const wanted = [...new Set(body.instrumentIds as string[])];

    const found = await prisma.instrument.findMany({
      where: { id: { in: wanted } },
      select: { id: true, code: true, room: { select: { id: true, code: true } } },
    });
    if (found.length !== wanted.length) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: 'One or more instrument ids do not exist.',
      });
    }

    // An instrument already in ANOTHER room is MOVED. roomId is single-valued,
    // so being in two rooms is not representable, and a move is the only honest
    // reading of the request. The response names what moved so the editor can
    // tell the operator rather than letting them discover it later.
    const moved = found
      .filter((i) => i.room && i.room.id !== roomId)
      .map((i) => ({ id: i.id, code: i.code, fromRoom: i.room }));

    await prisma.$transaction([
      prisma.instrument.updateMany({ where: { roomId }, data: { roomId: null } }),
      prisma.instrument.updateMany({ where: { id: { in: wanted } }, data: { roomId } }),
    ]);

    await auditLog({
      userId: ctx.userId, userRole: ctx.userRole,
      action: 'FLOORPLAN_ROOM_UPDATED',
      targetType: 'floorplan_room', targetId: roomId,
      beforeValue: { code: room.code, instruments: room.instruments.map((i) => i.code) },
      afterValue: { code: room.code, instruments: found.map((i) => i.code) },
      signatureMeaning: `Room "${room.code}" membership set to ${found.length} instrument(s)`,
      ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
    });

    return { roomId, instrumentIds: wanted, moved };
  });
}
