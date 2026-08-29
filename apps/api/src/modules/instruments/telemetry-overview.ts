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
import { loadDecimalsConfig, decimalsFor } from './decimals.js';
import { loadLimitConfig, limitsFor } from '../alarms/load-limits.js';
import { limitsInverted } from '../alarms/limit-decide.js';

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
   * The specification this instrument is judged against — the "set point" beside
   * each actual reading, and the bounds `status` uses to decide OUT_OF_SPEC.
   *
   * The INSTRUMENT's own limit attributes where it declares any, else the room's
   * (2026-08-19). It used to be the room's only, which had the dashboard showing
   * one spec while the alarm evaluator enforced a different one: on this
   * database every instrument carrying limits was unplaced, so the column read
   * NA for exactly the instruments an alarm could fire for.
   *
   * NULL when neither source says anything — a real state, not an error. Nobody
   * has said what this space is supposed to hold.
   */
  limits: RoomLimits | null;
  /**
   * Where `limits` came from, so the UI can say so rather than leaving an
   * operator to guess why two instruments in one room show different bands.
   */
  limitSource: 'INSTRUMENT' | 'ROOM' | null;
  temperature: SlotValue | null;
  humidity: SlotValue | null;
  /**
   * How many decimals THIS instrument's readings are shown to, resolved from its
   * own attributes with the site default as the fallback.
   *
   * Resolved here rather than in the browser for the reason `limits` above is:
   * the client would otherwise need every instrument's attributes and a join it
   * could get wrong — and the alarm evaluator, which never touches the browser,
   * needs the same answer to freeze onto a raised alarm. One resolution, one
   * precision per instrument everywhere.
   */
  decimals: { temperature: number; humidity: number };
  reporting: boolean;
  status: InstrumentStatus;
}

interface RawReading {
  instrumentId: string;
  key: string;
  value: unknown;
  ts: Date;
}

/** Exported so the per-instrument telemetry route can label a reading with its slot
 *  using the SAME administered vocabulary the fleet overview resolves with. */
export async function loadAliases(): Promise<{ temperature: string[]; humidity: string[] }> {
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
export async function loadActiveWindowMinutes(): Promise<number> {
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
async function selectionWhere(
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

/**
 * The instrument's own limit attributes as a RoomLimits band, or null.
 *
 * WHOLESALE, never mixed bound-by-bound with the room's. Mixing looks friendlier
 * — "the room says 18–25, the instrument only declares a high of 23, so show
 * 18–23" — and it reintroduces exactly the bug this change exists to remove: the
 * alarm evaluator reads ONLY the instrument's attributes, so it would never fire
 * below 18 while the table coloured that cell red. The displayed spec has to be
 * the enforced spec. An undeclared bound is therefore UNBOUNDED, which is also
 * what the evaluator does with it.
 *
 * An inverted pair (low above high) yields null for that metric, matching
 * `checkPair`: the evaluator raises nothing for it, so the table must not paint a
 * band that can never be met. See limitsInverted() for why that is not treated as
 * a permanent breach.
 */
export function instrumentLimits(
  keys: Awaited<ReturnType<typeof loadLimitConfig>>['keys'],
  attributes: { key: string; value: string }[],
): RoomLimits | null {
  const { limits } = limitsFor(keys, attributes);
  const tempOk = !limitsInverted(limits.temperatureHigh, limits.temperatureLow);
  const rhOk = !limitsInverted(limits.humidityHigh, limits.humidityLow);
  const band: RoomLimits = {
    tempMin: tempOk ? limits.temperatureLow : null,
    tempMax: tempOk ? limits.temperatureHigh : null,
    rhMin: rhOk ? limits.humidityLow : null,
    rhMax: rhOk ? limits.humidityHigh : null,
  };
  const declaresSomething =
    band.tempMin !== null || band.tempMax !== null || band.rhMin !== null || band.rhMax !== null;
  return declaresSomething ? band : null;
}

export async function buildTelemetryOverview(
  opts: {
    floorplanId?: string;
    functionalLocationId?: string;
    functionalLocationDirect?: boolean;
    /** Role/user visibility filter. ANDed with any selection filter — a caller must
     *  never widen their own scope by selecting a location outside it. */
    visibilityWhere?: object;
  } = {},
): Promise<OverviewRow[]> {
  const [aliases, activeWindowMinutes, decimalsCfg, limitCfg] = await Promise.all([
    loadAliases(),
    loadActiveWindowMinutes(),
    loadDecimalsConfig(),
    // The SAME administered key mapping the alarm evaluator resolves limits with.
    // One config, one resolver — two would drift, and the drift would be a table
    // contradicting the alarm sitting beside it.
    loadLimitConfig(),
  ]);

  // SELECTION filter (what the caller asked for) AND VISIBILITY filter (what their
  // role/user scope permits), combined with AND — never merged by spread. Selecting a
  // location outside your scope must return nothing rather than override the scope.
  const selection = await selectionWhere(opts);
  const effectiveWhere = opts.visibilityWhere
    ? (selection ? { AND: [selection, opts.visibilityWhere] } : opts.visibilityWhere)
    : selection;

  const instruments = await prisma.instrument.findMany({
    where: effectiveWhere,
    select: {
      id: true, code: true, name: true, isActive: true,
      expectedIntervalSec: true, lastSeenAt: true,
      // Two string columns per instrument, for the rows already being returned.
      //
      // The alarm evaluator calls this function AND separately loads the whole
      // `instrument_attributes` table for the limit keys, so its per-minute pass
      // does read attributes twice. Left as-is deliberately: the two want
      // different shapes (this one is per-row and scoped, that one is a fleet-wide
      // map), and de-duplicating would mean threading attributes back out of this
      // function purely to save a join over a table that holds single-digit rows
      // here. Revisit if the estate grows enough for the join to show.
      attributes: { select: { key: true, value: true } },
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

    // An unplaced instrument has no ROOM, but it may still carry its own limits
    // — which is the common case here — so it can be OUT_OF_SPEC without ever
    // appearing on a floorplan. Only an instrument with neither source is
    // unjudgeable: nobody has said what it is supposed to hold.
    const room: OverviewRow['room'] = inst.room
      ? {
          id: inst.room.id,
          code: inst.room.code,
          label: inst.room.label,
          floorplanId: inst.room.floorplanId,
        }
      : null;
    // The instrument's own spec wins over its room's. A probe that carries limit
    // attributes is the thing alarms are evaluated against, so it is also the
    // thing the table must show. The room remains the answer for an instrument
    // that declares nothing — a cleanroom's specification IS a property of the
    // room, and that reasoning (2026-08-11) still holds where the device is
    // silent.
    const own = instrumentLimits(limitCfg.keys, inst.attributes);
    const roomBand: RoomLimits | null = inst.room
      ? {
          tempMin: inst.room.tempMin, tempMax: inst.room.tempMax,
          rhMin: inst.room.rhMin, rhMax: inst.room.rhMax,
        }
      : null;
    const limits: RoomLimits | null = own ?? roomBand;
    const limitSource: OverviewRow['limitSource'] =
      own ? 'INSTRUMENT' : roomBand ? 'ROOM' : null;

    return {
      instrumentId: inst.id,
      code: inst.code,
      name: inst.name,
      isActive: inst.isActive,
      room,
      limits,
      limitSource,
      temperature,
      humidity,
      decimals: decimalsFor(decimalsCfg, inst.attributes),
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
