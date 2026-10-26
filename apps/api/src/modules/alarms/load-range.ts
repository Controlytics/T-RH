import { prisma } from '../../lib/prisma.js';
import {
  resolveLimit,
  SENSOR_RANGE_TEXT_DEFAULT,
  rangeText,
  type SensorRangeConfig,
  type SensorRangeBounds,
  type RangeBound,
} from '@digilog/shared';

/**
 * The administered `sensor-range-alarms` config — the master switch and the
 * word shown instead of the value. WHICH attributes hold the four bounds is the
 * instrument PROFILE's since 2026-10-26 (`InstrumentSlotConfig.rangeKeys`,
 * resolved by `modules/instruments/profile-measurements.ts`).
 *
 * Reads `enabled !== false` — ships ON, like `alarm-limits` and `rs485-alarms`
 * and unlike `inactivity-alarms`. Measured before choosing it: not one of the
 * 200 current slot readings on this installation is outside its instrument's
 * declared range, so switching it on raises nothing. Re-derive elsewhere before
 * trusting that.
 */
export async function loadRangeConfig(): Promise<SensorRangeConfig> {
  const row = await prisma.systemConfig.findUnique({ where: { configKey: 'sensor-range-alarms' } });
  const cfg = (row?.configValue ?? {}) as Record<string, unknown>;
  return {
    enabled: cfg.enabled !== false,
    rangeText: rangeText(cfg.rangeText as string | undefined) || SENSOR_RANGE_TEXT_DEFAULT,
  };
}

/**
 * One instrument's four range bounds, plus which attribute key each came from.
 *
 * `keys` is the instrument's profile `rangeKeys`. Reuses `resolveLimit` from the
 * limit machinery deliberately: range bounds are attributes read by ordered alias
 * exactly as limits are, and a second resolver would drift from the first.
 *
 * The key is kept so it can be frozen onto the alarm: "this fired against
 * `High Temperature Range` = 50" stays answerable after the attribute is renamed
 * or deleted — the same reasoning as `limitsFor`.
 */
export function rangeFor(
  keys: Record<RangeBound, string[]>,
  attributes: { key: string; value: string }[],
): {
  bounds: SensorRangeBounds;
  attributeKeys: Record<RangeBound, string | null>;
  /** The text each bound's attribute carries beside its number, null for a
   *  bare number — frozen onto the range alarm and printed in its place. */
  texts: Record<RangeBound, string | null>;
} {
  const hit = (bound: RangeBound) => resolveLimit(keys[bound], attributes);
  const th = hit('temperatureHigh');
  const tl = hit('temperatureLow');
  const hh = hit('humidityHigh');
  const hl = hit('humidityLow');
  return {
    bounds: {
      temperatureHigh: th?.value ?? null,
      temperatureLow: tl?.value ?? null,
      humidityHigh: hh?.value ?? null,
      humidityLow: hl?.value ?? null,
    },
    attributeKeys: {
      temperatureHigh: th?.key ?? null,
      temperatureLow: tl?.key ?? null,
      humidityHigh: hh?.key ?? null,
      humidityLow: hl?.key ?? null,
    },
    texts: {
      temperatureHigh: th?.text ?? null,
      temperatureLow: tl?.text ?? null,
      humidityHigh: hh?.text ?? null,
      humidityLow: hl?.text ?? null,
    },
  };
}
