import { Prisma } from '@prisma/client';
import { auditLog, type AuditEntry } from '../../lib/audit.js';

/**
 * Replacing a plan's rooms wholesale — what the draw scripts
 * (`scripts/draw-*.ts`) do when a floor is redrawn — in ONE place.
 *
 * Audit 2026-10-12 finding 1: the scripts deleted and recreated every room and
 * carried label / grade / meta over by code, but NOT the four limits. A room's
 * limits are the in-spec band for every instrument in it that has no limit
 * attributes of its own (`telemetry-overview.ts`), so a redraw silently
 * un-judged those instruments. Each room was also its own transaction, so an
 * error half way left a half-drawn plan. Both are fixed here, once:
 *   - `limits` is a REQUIRED field of every room written, and `carriedLimits`
 *     is how a script fills it, by code, from the room it replaces;
 *   - `replacePlanRooms` takes the caller's `tx` — the caller opens ONE
 *     transaction per plan — and refuses a plan whose new rooms repeat a code;
 *   - the delete and create audit rows name the limits, so the trail shows
 *     they were carried rather than leaving it to inference.
 */

export const LIMIT_KEYS = ['tempMin', 'tempMax', 'rhMin', 'rhMax'] as const;
export type RoomLimits = Record<(typeof LIMIT_KEYS)[number], number | null>;

/** What a redraw reads of the rooms it replaces: everything it carries, and what it audits. */
export const REDRAW_ROOM_SELECT = {
  id: true, code: true, label: true, grade: true, meta: true,
  tempMin: true, tempMax: true, rhMin: true, rhMax: true,
  instruments: { select: { code: true } },
} as const;

/** What a redraw reads of the links it deletes — the link routes' own audit shape. */
export const REDRAW_LINK_SELECT = {
  id: true, kind: true, fromEdge: true, offset: true, width: true, door: true, label: true,
  fromRoom: { select: { code: true } }, toRoom: { select: { code: true } },
} as const;

export type RedrawOldRoom = {
  id: string; code: string; label: string | null; grade: string | null; meta: unknown;
  instruments?: { code: string }[];
} & RoomLimits;

export type RedrawOldLink = {
  id: string; kind: string; fromEdge: number | null; offset: number | null; width: number | null;
  door: string | null; label: string | null;
  fromRoom: { code: string }; toRoom: { code: string };
};

/** "A ↔ B", the same code the link routes audit under. */
export const linkCode = (l: { fromRoom: { code: string }; toRoom: { code: string } }) => `${l.fromRoom.code} ↔ ${l.toRoom.code}`;

/** The four limits of a room, all `null` when there is no room to carry from. */
export function carriedLimits(room: Partial<RoomLimits> | null | undefined): RoomLimits {
  return {
    tempMin: room?.tempMin ?? null,
    tempMax: room?.tempMax ?? null,
    rhMin: room?.rhMin ?? null,
    rhMax: room?.rhMax ?? null,
  };
}

/** For a dry run's room list: "T 18..25  RH -..60", or "none". */
export function describeLimits(l: RoomLimits): string {
  if (LIMIT_KEYS.every((k) => l[k] === null)) return 'none';
  const v = (n: number | null) => (n === null ? '-' : String(n));
  return `T ${v(l.tempMin)}..${v(l.tempMax)}  RH ${v(l.rhMin)}..${v(l.rhMax)}`;
}

/**
 * Codes that occur more than once, compared IGNORING CASE: the scripts carry
 * by `code.toUpperCase()`, so two codes differing only by case would both take
 * the one carried room's limits. Empty when every code is distinct.
 */
export function duplicateRoomCodes(codes: string[]): string[] {
  const seen = new Map<string, number>();
  for (const c of codes) seen.set(c.toUpperCase(), (seen.get(c.toUpperCase()) ?? 0) + 1);
  return [...seen.entries()].filter(([, n]) => n > 1).map(([c]) => c);
}

/** Throws, naming every repeated code, before anything is written. */
export function assertUniqueRoomCodes(codes: string[], planName: string): void {
  const dup = duplicateRoomCodes(codes);
  if (dup.length) throw new Error(`"${planName}": room code(s) repeated in the layout (ignoring case): ${dup.join(', ')}`);
}

export interface RedrawRoom {
  code: string;
  label: string | null;
  x: number; y: number; w: number; h: number;
  /** The polygon outline; null = a rectangle. */
  points: { x: number; y: number }[] | null;
  doors: unknown[];
  grade: string | null;
  meta: Record<string, unknown> | null;
  /** Required: a redraw must say what each room's limits are — normally `carriedLimits(<the room it replaces>)`. */
  limits: RoomLimits;
  instrumentIds: string[];
}

/** Who and why, the same on every row of one redraw. */
export type RedrawAudit = Pick<AuditEntry, 'userId' | 'userRole' | 'ipAddress' | 'userAgent' | 'sessionId'> & { reason?: string | null };

/**
 * Delete links EXPLICITLY, one FLOORPLAN_LINK_DELETED row each, inside the
 * caller's transaction. A link dies with either of its rooms (FK cascade)
 * WITHOUT a row of its own, so every path that deletes a room or a plan —
 * the routes (room DELETE, plan DELETE, a merge's DELETE of room B) and the
 * draw scripts — calls this first (audit 2026-10-12 finding 6).
 */
export async function deleteLinksAudited(tx: Prisma.TransactionClient, links: RedrawOldLink[], ctx: {
  planName: string; audit: RedrawAudit; why: string;
}): Promise<string[]> {
  for (const l of links) {
    await tx.floorplanRoomLink.delete({ where: { id: l.id } });
    await auditLog({
      ...ctx.audit, action: 'FLOORPLAN_LINK_DELETED', targetType: 'floorplan_room_link', targetId: l.id,
      beforeValue: { floorplan: ctx.planName, code: linkCode(l), kind: l.kind, fromEdge: l.fromEdge, offset: l.offset, width: l.width, door: l.door, label: l.label },
      signatureMeaning: `Room link "${linkCode(l)}" deleted — ${ctx.why}`,
    }, tx);
  }
  return links.map(linkCode);
}

/**
 * Inside the caller's transaction: delete the plan's links (one
 * FLOORPLAN_LINK_DELETED row each — they would otherwise die with their rooms
 * by cascade, unrecorded), release and delete the old rooms, create the new
 * ones with their limits, and place their instruments. Returns how many
 * instruments were placed.
 */
export async function replacePlanRooms(tx: Prisma.TransactionClient, args: {
  planId: string;
  planName: string;
  oldRooms: RedrawOldRoom[];
  oldLinks: RedrawOldLink[];
  rooms: RedrawRoom[];
  audit: RedrawAudit;
  /** Ends each signature meaning: e.g. `"CWH — QC" redrawn from Layouts/CWH/QC.png`. */
  why: string;
  actor: string;
}): Promise<number> {
  const { planId, planName, audit, why, actor } = args;
  assertUniqueRoomCodes(args.rooms.map((r) => r.code), planName);

  await deleteLinksAudited(tx, args.oldLinks, { planName, audit, why });

  for (const r of args.oldRooms) {
    await tx.instrument.updateMany({ where: { roomId: r.id }, data: { roomId: null } });
    await tx.floorplanRoom.delete({ where: { id: r.id } });
    await auditLog({
      ...audit, action: 'FLOORPLAN_ROOM_DELETED', targetType: 'floorplan_room', targetId: r.id,
      beforeValue: {
        code: r.code, label: r.label, plan: planName, grade: r.grade,
        limits: carriedLimits(r),
        ...(r.instruments ? { instruments: r.instruments.map((i) => i.code) } : {}),
      },
      signatureMeaning: `Room "${r.code}" deleted — ${why}`,
    }, tx);
  }

  let placed = 0;
  for (const s of args.rooms) {
    const room = await tx.floorplanRoom.create({
      data: {
        floorplanId: planId, code: s.code, label: s.label,
        x: s.x, y: s.y, w: s.w, h: s.h,
        points: s.points ? (s.points as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
        doors: s.doors as unknown as Prisma.InputJsonValue,
        grade: s.grade,
        // SQL NULL for no meta — `Prisma.DbNull`, never `JsonNull`, which would
        // write the JSON literal `null` and read back as present.
        meta: s.meta ? (s.meta as Prisma.InputJsonValue) : Prisma.DbNull,
        ...s.limits,
        createdBy: actor, updatedBy: actor,
      },
      select: { id: true },
    });
    if (s.instrumentIds.length) {
      await tx.instrument.updateMany({ where: { id: { in: s.instrumentIds } }, data: { roomId: room.id } });
      placed += s.instrumentIds.length;
    }
    await auditLog({
      ...audit, action: 'FLOORPLAN_ROOM_CREATED', targetType: 'floorplan_room', targetId: room.id,
      afterValue: {
        code: s.code, label: s.label, plan: planName, grade: s.grade,
        corners: s.points ? s.points.length : 4, doors: s.doors.length,
        limits: s.limits,
        instruments: s.instrumentIds.length,
      },
      signatureMeaning: `Room "${s.code}" drawn on "${planName}" — ${why}`,
    }, tx);
  }
  return placed;
}

/** A redraw of hundreds of audited rows is not a 5-second interactive transaction. */
export const REDRAW_TX_OPTIONS = { maxWait: 20_000, timeout: 300_000 } as const;
