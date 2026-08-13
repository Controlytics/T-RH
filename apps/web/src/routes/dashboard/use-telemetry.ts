import useSWR from 'swr';
import type { InstrumentStatus } from '@digilog/shared';

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
  /** The room's spec — the "set point" beside each actual reading. NULL if unplaced. */
  limits: { tempMin: number | null; tempMax: number | null; rhMin: number | null; rhMax: number | null } | null;
  temperature: SlotValue | null;
  humidity: SlotValue | null;
  reporting: boolean;
  status: InstrumentStatus;
}

export interface TelemetrySettings {
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
    temperatureDecimals: num('temperatureDecimals', 1),
    humidityDecimals: num('humidityDecimals', 1),
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
  });

  return { rows: data?.data ?? [], isLoading, error, refreshMs: overviewRefreshMs };
}

/** "22.4 °C", or an em dash when the slot has no reading. */
export function formatSlot(v: SlotValue | null, decimals: number, unit: string): string {
  if (!v) return '—';
  return `${v.value.toFixed(decimals)} ${unit}`;
}

export interface FloorplanRoomShape {
  id: string;
  code: string;
  label: string | null;
  x: number; y: number; w: number; h: number;
  tempMin: number | null; tempMax: number | null;
  rhMin: number | null; rhMax: number | null;
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
