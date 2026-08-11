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
export function useTelemetryOverview(floorplanId?: string) {
  const { overviewRefreshMs } = useTelemetrySettings();
  const url = floorplanId
    ? `/api/instruments/telemetry-overview?floorplanId=${floorplanId}`
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
