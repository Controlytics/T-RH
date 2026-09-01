import useSWR from 'swr';
import {
  failureText, RS485_FAILURE_TEXT_DEFAULT,
  rangeText, SENSOR_RANGE_TEXT_DEFAULT,
  type AlarmTypeNames,
} from '@digilog/shared';

/**
 * The two words shown where an unusable reading would go:
 *
 *   `Error` — the sensor sent something that is not a number (`NA`).
 *   `OL`    — the sensor sent a number outside the span it can measure.
 *
 * Both administered, both defaulting to the shared constants, and kept SEPARATE
 * on purpose: they send an engineer to check different things — a wiring or bus
 * fault versus a saturated or mis-specified probe.
 *
 * ONE hook rather than a fetch per surface, because these words appear on the
 * dashboard table, the floorplan tiles, the Alarms page, the trend table and the
 * signed PDF, and those must never disagree.
 *
 * **The fallbacks are the SHARED constants, never literals here.** A `'OL'` baked
 * into a component is a second opinion about a value the server administers, and
 * the two diverge the moment somebody edits the setting.
 */
export interface SensorWords {
  /** RS485 / non-numeric. */
  failure: string;
  /** Out of the probe's measurable range. */
  outOfRange: string;
}

export function useSensorWords(): SensorWords {
  const opts = {
    // They change about once in the life of an installation; re-fetching on every
    // window focus would put two requests behind every tab switch on a page that
    // already polls telemetry every few seconds.
    revalidateOnFocus: false,
    dedupingInterval: 5 * 60_000,
  };
  const { data: rs485 } = useSWR<{ failureText: string }>('/api/config/rs485-alarms/display-text', opts);
  const { data: range } = useSWR<{ rangeText: string }>('/api/config/sensor-range-alarms/display-text', opts);
  return {
    failure: failureText(rs485?.failureText),
    outOfRange: rangeText(range?.rangeText),
  };
}

/** Back-compat for callers that only need the RS485 word. */
export function useFailureText(): string {
  return useSensorWords().failure;
}

/**
 * What each kind of alarm is CALLED, from Config → Alarm Type Names.
 *
 * Already defaulted server-side, so `undefined` here means "not loaded yet" and
 * every helper falls back to the shipped name on its own. One hook, because the
 * Type column, the Type filter, the trend widget and the signed PDF must not be
 * able to call the same alarm four different things.
 */
export function useAlarmTypeNames(): AlarmTypeNames | undefined {
  const { data } = useSWR<AlarmTypeNames>('/api/config/alarm-type-names/current', {
    revalidateOnFocus: false,
    dedupingInterval: 5 * 60_000,
  });
  return data;
}

export { RS485_FAILURE_TEXT_DEFAULT, SENSOR_RANGE_TEXT_DEFAULT };
