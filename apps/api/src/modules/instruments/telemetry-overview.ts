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
  isSensorFailureValue,
  coerceReading,
  isOutOfRange,
  type SensorRangeBounds,
  type RangeBound,
  computeInstrumentStatus,
  isInstrumentReporting,
  INSTRUMENT_ACTIVE_WINDOW_DEFAULT_MIN,
  TELEMETRY_SLOT_ALIASES_DEFAULT,
  type InstrumentStatus,
  type RoomLimits,
} from '@digilog/shared';
import { loadDecimalsConfig, decimalsFor } from './decimals.js';
import { loadLimitConfig, limitsFor, enabledBoundsFor } from '../alarms/load-limits.js';
import { loadRangeConfig, rangeFor } from '../alarms/load-range.js';
import { limitsInverted } from '../alarms/limit-decide.js';

export interface SlotValue {
  key: string;
  value: number;
  ts: string;
}

/**
 * The slot's reading BEFORE the numeric filter — whatever the device actually
 * sent, with the type ingest assigned it.
 *
 * Here for the same reason `decimals` is (see its comment below): the alarm
 * evaluator never touches the browser but needs an answer this function has
 * already worked out. In this case it needs the OPPOSITE of what `temperature`
 * and `humidity` carry — those are null when a sensor sends `NA`, which is
 * precisely the value the RS485 source exists to record. Resolving the slot a
 * second time in the worker would let the alarm and the dashboard disagree about
 * which key is the temperature key, on an installation where that mapping is
 * administered and has already drifted once.
 *
 * Not exposed by the dashboard endpoint — Fastify strips what its response
 * schema does not name, and nothing there declares it.
 */
export interface RawSlotValue {
  key: string;
  value: unknown;
  valueType: string;
  ts: string;
}

export interface OverviewRow {
  instrumentId: string;
  code: string;
  name: string;
  isActive: boolean;
  room: { id: string; code: string; label: string | null; floorplanId: string } | null;
  /**
   * The instrument's FUNCTIONAL location — the authoritative Block > Area
   * grouping (root CLAUDE.md, "Instrument grouping — THREE concepts").
   *
   * A THIRD placement fact beside `room` above and `locationAttribute` below,
   * and all three are real and different: this is the logical grouping alarms
   * and visibility scopes resolve through, `room` is geometry on a drawn plan,
   * and the attribute is free text somebody typed. NULL for an unassigned
   * instrument, which is a normal state here.
   *
   * The NAME only — the id is not returned, because nothing on the dashboard
   * navigates from a row to its location and an unused id is a decoy.
   */
  functionalLocationName: string | null;
  /**
   * The instrument's own `Location` ATTRIBUTE — the free-text placement the
   * plant administers per device ("Dissolution & UV Room"), and what
   * `scripts/draw-cwh-floorplan.ts` names each drawn room from.
   *
   * **Not `Instrument.location`**, the free-text COLUMN of the same name, which
   * is superseded and read by nothing. Named for its source rather than `location`
   * for exactly that reason: the two would be indistinguishable at every call
   * site, and the column is the one that is dead.
   */
  locationAttribute: string | null;
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
   * Which of the four bounds the instrument's own `Enable_*` attributes leave IN
   * FORCE, before the switched-off ones were stripped out of `limits` above.
   *
   * `limits` is the answer to "what is enforced"; this says WHY a bound is
   * missing from it. A UI needs the difference: "no low limit is administered"
   * and "the low limit is switched off" are different facts about the record,
   * and only this tells them apart. Never gate display on it — `limits` already
   * withholds the bound.
   */
  limitEnabled: { tempMin: boolean; tempMax: boolean; rhMin: boolean; rhMax: boolean };
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
  /** Each slot's reading as stored, numeric or not. See {@link RawSlotValue}. */
  rawSlots: { temperature: RawSlotValue | null; humidity: RawSlotValue | null };
  /**
   * Did this slot report something that is not a number?
   *
   * `temperature`/`humidity` above are null in TWO different situations — the
   * sensor sent `NA`, or nothing arrived at all — and the dashboard rendered both
   * as `NA`, so a dead probe looked exactly like an instrument nobody had wired
   * up. This flag separates them, and it is decided HERE rather than in the
   * browser: `isSensorFailureValue()` is the one definition of a broken reading,
   * the alarm evaluator judges by it, and a cell contradicting the alarm beside
   * it is the failure mode this whole area keeps producing.
   *
   * Unlike `rawSlots`, this IS exposed by the dashboard endpoint — it is a
   * decision, not the device's raw text.
   */
  sensorError: { temperature: boolean; humidity: boolean };
  /**
   * Which slots reported a number OUTSIDE the probe's declared measuring span.
   *
   * **When this is true the numeric slot above is NULL**, deliberately. A reading
   * beyond what the sensor can measure is not a measurement — a saturated probe
   * displays `OL`, not the truth — so it is withheld from everything that
   * consumes a reading: the limit evaluator sees no value and therefore neither
   * raises nor clears a spec alarm, the dashboard shows the configured word, and
   * `computeInstrumentStatus` treats the slot as absent. That suppression is the
   * operator's explicit decision (2026-08-31): one alarm for the fault, not a
   * product excursion quoted from a number the sensor cannot stand behind.
   *
   * The reading itself is not lost — it is frozen onto the SENSOR_RANGE alarm.
   */
  rangeError: { temperature: boolean; humidity: boolean };
  /** The span each slot was judged against, for the tooltip and the alarm. */
  rangeBounds: SensorRangeBounds;
}

interface RawReading {
  instrumentId: string;
  key: string;
  value: unknown;
  valueType: string;
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
  // `coerceReading` from @digilog/shared — the ONE definition, shared with the
  // alarm evaluator. A quoted number IS a number (operator, 2026-08-31); `NA`,
  // an empty string, a boolean and an object are not.
  return coerceReading(value);
}

function toSlot(reading: RawReading | null): SlotValue | null {
  if (!reading) return null;
  const n = asNumber(reading.value);
  if (n === null) return null;
  return { key: reading.key, value: n, ts: reading.ts.toISOString() };
}

/**
 * One attribute's value, or null.
 *
 * Matched the way EVERY other attribute lookup in this system matches —
 * trimmed and case-insensitive, exactly as `resolveLimit()` in `@digilog/shared`
 * does. The live rows are keyed `Location`, but a hand-typed `location` names
 * the same fact and must not read as unset.
 *
 * A blank value is treated as ABSENT. An attribute somebody created and left
 * empty says nothing, and letting it through would render an empty cell that
 * looks like a rendering fault rather than a stated absence.
 */
function attributeValue(attributes: { key: string; value: string }[], key: string): string | null {
  const hit = attributes.find((a) => a.key.trim().toLowerCase() === key);
  const value = hit?.value.trim();
  return value ? value : null;
}

/** The same resolved reading, kept whole. Null only when the instrument sent
 *  nothing on any alias for the slot — which is silence, not a bad value. */
function toRawSlot(reading: RawReading | null): RawSlotValue | null {
  if (!reading) return null;
  return {
    key: reading.key,
    value: reading.value,
    valueType: reading.valueType,
    ts: reading.ts.toISOString(),
  };
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
  const [aliases, activeWindowMinutes, decimalsCfg, limitCfg, rangeCfg] = await Promise.all([
    loadAliases(),
    loadActiveWindowMinutes(),
    loadDecimalsConfig(),
    // The SAME administered key mapping the alarm evaluator resolves limits with.
    // One config, one resolver — two would drift, and the drift would be a table
    // contradicting the alarm sitting beside it.
    loadLimitConfig(),
    // The range bounds are resolved from the SAME attribute rows the limits come
    // from, by the same alias resolver — so "which key holds the high range" has
    // one answer here, in the alarm, and on the dashboard.
    loadRangeConfig(),
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
      // The NAME of the authoritative grouping. One extra join on a query that
      // already joins the room and the attributes; the alternative is the browser
      // resolving the Block > Area tree itself, which is a server decision.
      functionalLocation: { select: { name: true } },
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
    SELECT instrument_id AS "instrumentId", key, value, value_type AS "valueType", ts
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
    // Resolved ONCE per slot and used for both shapes, so the numeric view and
    // the raw view can never name different keys.
    const rawTemperature = resolveSlot(aliases.temperature, mine);
    const rawHumidity = resolveSlot(aliases.humidity, mine);
    let temperature = toSlot(rawTemperature);
    let humidity = toSlot(rawHumidity);

    // Range check, and the WITHHOLDING that follows from it. Done here rather
    // than in each consumer because this function is the one place a stored
    // value becomes "a reading" — putting the test anywhere else would leave
    // some consumer trusting a number the others had rejected.
    const { bounds: rangeBounds } = rangeFor(rangeCfg.keys, inst.attributes);
    const rangeError = {
      temperature: rangeCfg.enabled && temperature !== null
        && isOutOfRange(temperature.value, rangeBounds.temperatureLow, rangeBounds.temperatureHigh),
      humidity: rangeCfg.enabled && humidity !== null
        && isOutOfRange(humidity.value, rangeBounds.humidityLow, rangeBounds.humidityHigh),
    };
    if (rangeError.temperature) temperature = null;
    if (rangeError.humidity) humidity = null;

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
    const resolved: RoomLimits | null = own ?? roomBand;

    /**
     * A bound the instrument switches OFF is WITHHELD, exactly as an
     * out-of-range reading is withheld a few lines above — one place where a
     * stored number becomes "a bound this system enforces", so no consumer can
     * trust one the others rejected.
     *
     * This is not display sugar. `computeInstrumentStatus` below reads `limits`,
     * and the alarm evaluator will not raise on a disabled bound, so leaving it
     * in would paint an instrument OUT_OF_SPEC against a bound that can never
     * produce an alarm — and on this installation a `High Humidity Limit = 0`
     * meaning "not judged" does exactly that at every real humidity.
     *
     * Mapping is `LIMIT_BOUND`'s (alarm-evaluation.worker.ts): NMT is the HIGH
     * bound, NLT the LOW one. Reversing it silently hides the opposite bound.
     *
     * Applied whatever `limitSource` says, deliberately. The flags are the
     * INSTRUMENT's statement about its own bounds, and the evaluator reads
     * instrument attributes ONLY — on a room-sourced row it is enforcing nothing
     * anyway, so a bound the instrument disowns has no claim to be drawn.
     */
    const boundEnabled = enabledBoundsFor(limitCfg.enableKeys, inst.attributes);
    const limitEnabled = {
      tempMax: boundEnabled.temperatureHigh,
      tempMin: boundEnabled.temperatureLow,
      rhMax: boundEnabled.humidityHigh,
      rhMin: boundEnabled.humidityLow,
    };
    const limits: RoomLimits | null = resolved && {
      tempMin: limitEnabled.tempMin ? resolved.tempMin : null,
      tempMax: limitEnabled.tempMax ? resolved.tempMax : null,
      rhMin: limitEnabled.rhMin ? resolved.rhMin : null,
      rhMax: limitEnabled.rhMax ? resolved.rhMax : null,
    };
    // The source describes a band. Once every bound in it is gone there is no
    // band left to attribute, and "from this instrument" over an empty set is a
    // §11 string that contradicts itself.
    const anyBound = limits !== null
      && (limits.tempMin !== null || limits.tempMax !== null
        || limits.rhMin !== null || limits.rhMax !== null);
    const limitSource: OverviewRow['limitSource'] =
      !anyBound ? null : own ? 'INSTRUMENT' : roomBand ? 'ROOM' : null;

    return {
      instrumentId: inst.id,
      code: inst.code,
      name: inst.name,
      isActive: inst.isActive,
      room,
      functionalLocationName: inst.functionalLocation?.name ?? null,
      // From the attribute rows already selected above for the limits — no
      // second query, and no `where` on the relation, so one pass over the same
      // list answers every attribute question this function asks.
      locationAttribute: attributeValue(inst.attributes, 'location'),
      limits,
      limitEnabled,
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
      rawSlots: { temperature: toRawSlot(rawTemperature), humidity: toRawSlot(rawHumidity) },
      rangeError,
      rangeBounds,
      sensorError: {
        // A reading that ARRIVED and is not a number. A missing slot is not an
        // error here — that is silence, and it keeps saying NA.
        temperature: rawTemperature !== null && isSensorFailureValue(rawTemperature.value),
        humidity: rawHumidity !== null && isSensorFailureValue(rawHumidity.value),
      },
    };
  });
}
