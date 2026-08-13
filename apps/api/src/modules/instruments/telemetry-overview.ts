/**
 * The fleet-wide "what is everything reading right now" query.
 *
 * ONE endpoint feeds BOTH dashboard views. The table renders these rows
 * directly; the floorplan groups them by room and takes each room's colour from
 * the worst status among its members. Two endpoints over the same data would
 * eventually disagree, and a room whose colour contradicts its own rows is the
 * worst possible bug on a compliance dashboard.
 *
 * Separate file rather than more of routes.ts, which is already 1700 lines.
 *
 * Design: docs/superpowers/specs/2026-08-11-instrument-dashboard-floorplan-design.md
 */
import { prisma } from '../../lib/prisma.js';
import { resolveLocationIds } from '../functional-locations/tree.js';
import type { FlType } from '../functional-locations/validation.js';
import {
  parseTelemetryAliases,
  resolveSlot,
  computeInstrumentStatus,
  isInstrumentReporting,
  INSTRUMENT_ACTIVE_WINDOW_DEFAULT_MIN,
  TELEMETRY_SLOT_ALIASES_DEFAULT,
  type InstrumentStatus,
  type RoomLimits,
} from '@digilog/shared';

export interface SlotValue {
  key: string;
  value: number;
  ts: string;
}

export interface OverviewRow {
  instrumentId: string;
  code: string;
  name: string;
  isActive: boolean;
  room: { id: string; code: string; label: string | null; floorplanId: string } | null;
  /**
   * The ROOM's environmental specification, i.e. the "set point" the dashboard
   * table shows beside each actual reading. Already loaded to compute `status`,
   * so returning it costs nothing and saves the client a second request plus a
   * client-side join it could get wrong. NULL when the instrument is unplaced —
   * an unplaced instrument has no specification to meet.
   */
  limits: RoomLimits | null;
  temperature: SlotValue | null;
  humidity: SlotValue | null;
  reporting: boolean;
  status: InstrumentStatus;
}

interface RawReading {
  instrumentId: string;
  key: string;
  value: unknown;
  ts: Date;
}

async function loadAliases(): Promise<{ temperature: string[]; humidity: string[] }> {
  const row = await prisma.systemConfig.findUnique({ where: { configKey: 'telemetry-slots' } });
  const cfg = (row?.configValue ?? {}) as Record<string, unknown>;
  return {
    temperature: parseTelemetryAliases(
      (cfg.temperatureKeys as string) ?? TELEMETRY_SLOT_ALIASES_DEFAULT.temperature,
    ),
    humidity: parseTelemetryAliases(
      (cfg.humidityKeys as string) ?? TELEMETRY_SLOT_ALIASES_DEFAULT.humidity,
    ),
  };
}

/**
 * The site-wide fallback window for instruments that declare no expected
 * interval. `isInstrumentReporting` — the ONE definition of reporting in this
 * system — takes it in minutes.
 */
async function loadActiveWindowMinutes(): Promise<number> {
  const row = await prisma.systemConfig.findUnique({ where: { configKey: 'instrument-activity' } });
  const cfg = (row?.configValue ?? {}) as Record<string, unknown>;
  return typeof cfg.activeWindowMinutes === 'number'
    ? cfg.activeWindowMinutes
    : INSTRUMENT_ACTIVE_WINDOW_DEFAULT_MIN;
}

/**
 * A stored telemetry value is jsonb — it can legitimately be a string, a bool or
 * an object. Only a finite number is a reading; anything else is ignored rather
 * than coerced, because `Number("warm")` is NaN and NaN renders as a blank cell
 * that looks identical to "no data" while silently poisoning limit comparisons.
 */
function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return null;
}

function toSlot(reading: RawReading | null): SlotValue | null {
  if (!reading) return null;
  const n = asNumber(reading.value);
  if (n === null) return null;
  return { key: reading.key, value: n, ts: reading.ts.toISOString() };
}

/**
 * Translates the optional filters into a Prisma `where`.
 *
 * A FUNCTIONAL LOCATION resolves through resolveLocationIds(), so selecting a BLOCK
 * returns its own instruments PLUS all its Areas'. Filtering on
 * `functionalLocationId = :id` directly would return only the directly-pinned ones —
 * a Block view that looks emptier than it is, with nothing on screen to explain why.
 *
 * An unknown id yields `{ in: [] }`, i.e. NO rows. It must never degrade to "no
 * filter": a stale bookmark would then quietly show the whole estate, and project D
 * enforces visibility on this same query.
 */
async function scopeWhere(
  opts: { floorplanId?: string; functionalLocationId?: string; functionalLocationDirect?: boolean },
) {
  if (opts.functionalLocationId) {
    // DIRECT: instruments pinned to this location itself, WITHOUT the Area
    // expansion. The dashboard's "— direct" card exists to answer "what is pinned
    // to the Block rather than to one of its Areas", and resolving the scope here
    // would return the Areas too — the card would say 1 and the table show 4.
    if (opts.functionalLocationDirect) {
      return { functionalLocationId: opts.functionalLocationId };
    }
    const rows = await prisma.functionalLocation.findMany({
      select: { id: true, name: true, type: true, parentId: true },
    });
    const ids = resolveLocationIds(
      opts.functionalLocationId,
      rows.map((r) => ({ ...r, type: r.type as FlType })),
    );
    return { functionalLocationId: { in: ids } };
  }
  if (opts.floorplanId) return { room: { floorplanId: opts.floorplanId } };
  return undefined;
}

export async function buildTelemetryOverview(
  opts: { floorplanId?: string; functionalLocationId?: string; functionalLocationDirect?: boolean } = {},
): Promise<OverviewRow[]> {
  const [aliases, activeWindowMinutes] = await Promise.all([
    loadAliases(),
    loadActiveWindowMinutes(),
  ]);

  const instruments = await prisma.instrument.findMany({
    where: await scopeWhere(opts),
    select: {
      id: true, code: true, name: true, isActive: true,
      expectedIntervalSec: true, lastSeenAt: true,
      room: {
        select: {
          id: true, code: true, label: true, floorplanId: true,
          tempMin: true, tempMax: true, rhMin: true, rhMax: true,
        },
      },
    },
    orderBy: { code: 'asc' },
  });
  if (instruments.length === 0) return [];

  // One query for every latest reading, not one per instrument. The table is the
  // whole fleet and this is polled every few seconds.
  const readings = await prisma.$queryRaw<RawReading[]>`
    SELECT instrument_id AS "instrumentId", key, value, ts
    FROM instrument_telemetry_latest`;

  const byInstrument = new Map<string, RawReading[]>();
  for (const r of readings) {
    const list = byInstrument.get(r.instrumentId);
    if (list) list.push(r);
    else byInstrument.set(r.instrumentId, [r]);
  }

  // One `now` for the whole response: half the fleet judged against a different
  // instant than the other half is a status that cannot be reasoned about.
  const now = new Date();

  return instruments.map((inst) => {
    const mine = byInstrument.get(inst.id) ?? [];
    const temperature = toSlot(resolveSlot(aliases.temperature, mine));
    const humidity = toSlot(resolveSlot(aliases.humidity, mine));

    // The ONE staleness rule in this system, already defined in @digilog/shared:
    // the instrument's own declared interval (times its slack) where it has one,
    // else the site-wide fallback window. Do not restate it here.
    const reporting = isInstrumentReporting(
      inst.lastSeenAt, inst.expectedIntervalSec, activeWindowMinutes, now,
    );

    // An unplaced instrument has no room and therefore no specification to
    // breach: it can be STALE or NO_DATA, never OUT_OF_SPEC. That is correct —
    // nobody has said what this space is supposed to hold.
    const room: OverviewRow['room'] = inst.room
      ? {
          id: inst.room.id,
          code: inst.room.code,
          label: inst.room.label,
          floorplanId: inst.room.floorplanId,
        }
      : null;
    const limits: RoomLimits | null = inst.room
      ? {
          tempMin: inst.room.tempMin, tempMax: inst.room.tempMax,
          rhMin: inst.room.rhMin, rhMax: inst.room.rhMax,
        }
      : null;

    return {
      instrumentId: inst.id,
      code: inst.code,
      name: inst.name,
      isActive: inst.isActive,
      room,
      limits,
      temperature,
      humidity,
      reporting,
      status: computeInstrumentStatus({
        temperature: temperature?.value ?? null,
        humidity: humidity?.value ?? null,
        limits,
        reporting,
      }),
    };
  });
}
