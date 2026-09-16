import useSWR from 'swr';
import {
  clampDecimals,
  formatDecimals,
  TELEMETRY_DECIMALS_FALLBACK,
  type InstrumentStatus,
} from '@digilog/shared';
import type { RoomDoor } from './room-geometry';

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
   * The instrument's FUNCTIONAL location — the authoritative Block > Area
   * grouping, shown as the dashboard table's **Area** column.
   *
   * A different fact from `room` above and from `locationAttribute` below, and
   * all three are real: this is the logical grouping, `room` is geometry on a
   * drawn plan, and the attribute is free text. Null for an unassigned
   * instrument, which is normal here.
   *
   * Optional so a cached response from before this field existed still renders.
   */
  functionalLocationName?: string | null;
  /**
   * The instrument's own `Location` ATTRIBUTE — the free-text placement
   * ("Dissolution & UV Room"), shown as the **Location** column.
   *
   * **Not `Instrument.location`**, the superseded column of the same name.
   * Resolved server-side from the attribute rows; never re-derived here, and
   * there is no attributes payload on this row to re-derive it from.
   *
   * Optional so a cached response from before this field existed still renders.
   */
  locationAttribute?: string | null;
  /**
   * The spec this instrument is judged against — the "set point" beside each
   * actual reading, and the bounds that decide OUT_OF_SPEC.
   *
   * Resolved server-side: the INSTRUMENT's own limit attributes where it declares
   * any, else its room's. NULL when neither says anything. Never re-derive it
   * here — the alarm evaluator reads the same attributes through the same
   * resolver, and a second derivation is how a table comes to contradict the
   * alarm printed beside it.
   */
  limits: { tempMin: number | null; tempMax: number | null; rhMin: number | null; rhMax: number | null } | null;
  /**
   * Which of the four bounds the instrument's own `Enable_*` attributes leave in
   * force. A bound switched off is ALREADY absent from `limits` — the server
   * withholds it, because the alarm evaluator will not raise on it and a bound
   * drawn as live but never enforced is a misstatement.
   *
   * This says WHY a bound is missing, not WHETHER to show it: "no low limit is
   * administered" and "the low limit is switched off" are different facts, and
   * only this tells them apart. Never gate display on it.
   *
   * Optional so a cached response from before this field existed still renders.
   */
  limitEnabled?: { tempMin: boolean; tempMax: boolean; rhMin: boolean; rhMax: boolean };
  /** Which of the two said it. Null when no bound survives. */
  limitSource: 'INSTRUMENT' | 'ROOM' | null;
  temperature: SlotValue | null;
  humidity: SlotValue | null;
  /**
   * How many decimals THIS instrument's readings are shown to — resolved on the
   * server from its own `temp_decimals` / `humid_decimals` attributes, with the
   * `telemetry-slots` config as the fallback.
   *
   * Precision is per instrument, never per page: a probe reading whole degrees
   * and one resolving to 0.1 sit in the same table, and any single number here
   * would misreport one of them.
   */
  decimals: { temperature: number; humidity: number };
  reporting: boolean;
  status: InstrumentStatus;
  /**
   * Which slots reported something that is NOT a number — a broken RS485 probe
   * sending `NA`, rather than a slot with no reading at all.
   *
   * `temperature`/`humidity` are null in both cases, so without this the two are
   * indistinguishable and the dashboard renders `NA` for a dead sensor. Decided
   * on the SERVER by the same predicate the alarm evaluator uses; never
   * re-derived here, or a cell will eventually contradict the alarm beside it.
   *
   * Optional so a cached response from before this field existed still renders.
   */
  sensorError?: { temperature: boolean; humidity: boolean };
  /**
   * Which slots reported a NUMBER outside the probe's measurable span.
   *
   * When true the numeric slot above is null — the server withholds a reading the
   * sensor cannot stand behind, so nothing here plots or judges it. A different
   * fault from `sensorError`, and a different word on screen: `OL` for a
   * saturated probe, `Error` for one sending nonsense.
   */
  rangeError?: { temperature: boolean; humidity: boolean };
  /** The probe's declared span, so a HISTORICAL reading can be judged too —
   *  `rangeError` only describes the latest one. */
  rangeBounds?: {
    temperatureHigh: number | null; temperatureLow: number | null;
    humidityHigh: number | null; humidityLow: number | null;
  };
}

export interface TelemetrySettings {
  /**
   * The SITE DEFAULT only — what an instrument with no decimals attribute falls
   * back to. Every row that came from the API already carries its own resolved
   * `decimals`; use that. This is for the few places with no row in hand.
   */
  temperatureDecimals: number;
  humidityDecimals: number;
  overviewRefreshMs: number;
  chartRefreshMs: number;
}

/**
 * Read the telemetry-slots config.
 *
 * VERIFIED path and shape: a config def with `hasCustomPage: false` is served by
 * `config/dynamic-routes.ts` at `/api/config/dynamic/<moduleKey>` and returns
 * the BARE value object. It is NOT at `/<key>/current` — that path exists only
 * for defs that hand-wrote a static route — and there is no `{value: …}`
 * wrapper to unpick.
 */
export function useTelemetrySettings(): TelemetrySettings {
  const { data } = useSWR<Record<string, number | string>>('/api/config/dynamic/telemetry-slots', {
    revalidateOnFocus: false,
    dedupingInterval: 60000,
  });
  const v = data ?? {};
  const num = (key: string, fallback: number) =>
    typeof v[key] === 'number' ? (v[key] as number) : fallback;

  return {
    temperatureDecimals: clampDecimals(num('temperatureDecimals', TELEMETRY_DECIMALS_FALLBACK)),
    humidityDecimals: clampDecimals(num('humidityDecimals', TELEMETRY_DECIMALS_FALLBACK)),
    overviewRefreshMs: num('overviewRefreshSeconds', 5) * 1000,
    chartRefreshMs: num('chartRefreshSeconds', 10) * 1000,
  };
}

/**
 * Every instrument's current reading.
 *
 * POLLING, NOT PUSH. This repo has no browser-facing WebSocket or SSE channel —
 * the `@fastify/websocket` registration that does exist is INBOUND device
 * ingest. Every "live" surface in this feature is an interval, and the UI says
 * so rather than implying a stream.
 */
export function useTelemetryOverview(opts?: string | { floorplanId?: string; functionalLocationId?: string; directOnly?: boolean }) {
  const { overviewRefreshMs } = useTelemetrySettings();
  // A bare string stays supported so existing callers (floorplan-view) are
  // unchanged; the object form adds the functional-location scope.
  const o = typeof opts === 'string' ? { floorplanId: opts } : (opts ?? {});
  const qs = new URLSearchParams();
  if (o.floorplanId) qs.set('floorplanId', o.floorplanId);
  // The scope goes to the SERVER, not applied to rows here: the payload would
  // otherwise be the whole estate, and project D enforces visibility on this same
  // query. A client-side filter would have to be rewritten then.
  if (o.functionalLocationId) qs.set('functionalLocationId', o.functionalLocationId);
  // Direct-only: this location itself, WITHOUT its Areas. Without this flag the
  // "— direct" card said 1 instrument while its table showed all 4 in the Block.
  if (o.functionalLocationId && o.directOnly) qs.set('functionalLocationDirect', 'true');
  const url = qs.size
    ? `/api/instruments/telemetry-overview?${qs.toString()}`
    : '/api/instruments/telemetry-overview';

  const { data, error, isLoading } = useSWR<{ data: OverviewRow[] }>(url, {
    refreshInterval: overviewRefreshMs,
    revalidateOnFocus: true,
    dedupingInterval: 1000,
    // Drilling into a location changes this key. Keep the previous rows until
    // the new ones land (2026-09-16): with SWR's default the panel collapsed
    // to a skeleton on every drill-down and the auto-height grid shrank, then
    // grew again — "widgets take 2-3 sec to align" (operator). Rows carry
    // their own instrument codes, so a brief stale set is not mislabeled.
    keepPreviousData: true,
  });

  // Neither `mutate` NOR `refreshMs` is exported, and both absences are deliberate.
  // The table had a manual refresh button for one commit (2026-08-29) and the
  // operator removed it: this hook already polls on `overviewRefreshMs` and
  // revalidates on focus, so the button only re-asked a question that was being
  // asked anyway. The "updates every 5s" captions that `refreshMs` fed went the
  // same way, from the table and then the floorplan, leaving it with no consumer.
  // The POLL itself is unchanged — only the captions announcing it are gone.
  return { rows: data?.data ?? [], isLoading, error };
}

/**
 * "22.4 °C", or an em dash when the slot has no reading.
 *
 * `decimals` is the INSTRUMENT's, i.e. `row.decimals.temperature` — not a page-wide
 * number. It goes through `formatDecimals`, which cannot throw: `toFixed` raises a
 * RangeError outside 0…100, and that throw inside the floorplan's `.map()` would
 * blank the entire dashboard because one attribute held a silly value.
 */
export function formatSlot(v: SlotValue | null, decimals: number, unit: string): string {
  if (!v) return '—';
  const text = formatDecimals(v.value, decimals);
  return text === null ? '—' : `${text} ${unit}`;
}

/**
 * Cleanroom classification vocabulary.
 *
 * TEXT, not a Postgres enum — a classification list that may need extending
 * should not need a migration to do it. Which also means the value arriving
 * from the API is only ever `string`: everything that paints from it must
 * tolerate one it does not know and fall back to unclassified.
 */
export const ROOM_GRADES = ['A', 'B', 'C', 'D', 'CIRCULATION', 'UTILITY'] as const;
export type RoomGrade = (typeof ROOM_GRADES)[number];

/**
 * `tab` is what fits in the 14×11 grade tab on the drawing; `label` and `name`
 * are the legend and the editor's wording. CIRCULATION and UTILITY get two
 * letters rather than one because a bare "C" on a corridor would read as grade
 * C — the two are different classifications and must not share a glyph.
 */
export const ROOM_GRADE_META: Record<RoomGrade, { tab: string; label: string; name: string }> = {
  A: { tab: 'A', label: 'A', name: 'Sterile core' },
  B: { tab: 'B', label: 'B', name: 'Aseptic' },
  C: { tab: 'C', label: 'C', name: 'Clean production' },
  D: { tab: 'D', label: 'D', name: 'Support / stores' },
  CIRCULATION: { tab: 'CR', label: 'Circulation', name: 'Corridors' },
  UTILITY: { tab: 'UT', label: 'Utility', name: 'Plant, offices' },
};

export interface FloorplanRoomShape {
  id: string;
  code: string;
  label: string | null;
  /**
   * Cleanroom grade, one of `ROOM_GRADES`. NULL = nobody has classified this
   * room; it draws exactly as it did before grades existed.
   */
  grade: string | null;
  x: number; y: number; w: number; h: number;
  tempMin: number | null; tempMax: number | null;
  rhMin: number | null; rhMax: number | null;
  /** Drawn openings. NULL for every room drawn before doors existed. */
  doors: RoomDoor[] | null;
  /**
   * What the DRAWING says about this room, on a TRACED plan. NULL on every
   * generated plan, which renders exactly as it did before this existed.
   *
   * `fill` overrides the grade hue: the draughtsman's colours say what a room is
   * FOR, `grade` says how it is classified, and both are true. `fch` and `dims`
   * are transcribed strings, never re-derived — the drawing is schematic, so
   * computing a size from `w`/`h` would print a different number from the plan.
   */
  meta: RoomMeta | null;
}

export interface RoomMeta {
  fill?: string;
  fch?: string;
  dims?: string;
}

/**
 * Everything on a plan that is not a room, in the same normalized 0..1 space as
 * the rooms. NULL on a generated plan — and the legend is drawn only when this
 * is present, since a legend for symbols a plan never uses is furniture.
 *
 * All of it is STATIC drawing content. An HVAC symbol marks where a unit is
 * DRAWN; it is not a unit that reports, and it must never take a status colour.
 */
export interface PlanAnnotations {
  equipment: { x: number; y: number; w: number; h: number }[];
  hvac: { x: number; y: number; w: number; h: number }[];
  water: { x: number; y: number }[];
  airflow: { y: number; x0: number; x1: number }[];
  labels: { x: number; y: number; text: string }[];
}

export interface FloorplanShape {
  id: string;
  name: string;
  imagePath: string;
  imageWidth: number;
  imageHeight: number;
  isActive: boolean;
  sortOrder: number;
  rooms: FloorplanRoomShape[];
  annotations: PlanAnnotations | null;
}

/**
 * The plans and their room geometry.
 *
 * The dashboard DRAWS these rooms; it never renders `imagePath`. The image is a
 * tracing guide in the editor only — see the spec §7. `imageWidth`/`imageHeight`
 * are still used here, as the aspect ratio the drawn floor is laid out at.
 */
export function useFloorplans() {
  const { data, error, isLoading } = useSWR<{ data: FloorplanShape[] }>('/api/floorplans', {
    revalidateOnFocus: false,
    dedupingInterval: 30000,
  });
  return { plans: data?.data ?? [], isLoading, error };
}

export type HistoryWindow = '15m' | '1h' | '6h' | '24h' | '7d';

export const HISTORY_WINDOWS: { value: HistoryWindow; label: string }[] = [
  { value: '15m', label: '15 min' },
  { value: '1h', label: '1 hour' },
  { value: '6h', label: '6 hours' },
  { value: '24h', label: '24 hours' },
  { value: '7d', label: '7 days' },
];

export interface HistorySeries {
  instrumentId: string;
  instrumentCode: string;
  slot: 'temperature' | 'humidity';
  key: string;
  /** This instrument's display precision, resolved server-side. Per series, because
   *  two probes in one room can legitimately resolve differently. */
  decimals: number;
  points: { ts: string; value: number }[];
}

export interface RoomHistory {
  room: FloorplanRoomShape;
  from: string;
  to: string;
  bucketSeconds: number | null;
  series: HistorySeries[];
}

export function useRoomHistory(floorplanId: string, roomId: string, window: HistoryWindow) {
  const { chartRefreshMs } = useTelemetrySettings();
  const { data, error, isLoading } = useSWR<RoomHistory>(
    floorplanId && roomId
      ? `/api/floorplans/${floorplanId}/rooms/${roomId}/history?window=${window}`
      : null,
    { refreshInterval: chartRefreshMs, revalidateOnFocus: true },
  );
  return { history: data, isLoading, error, refreshMs: chartRefreshMs };
}
