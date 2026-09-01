import { prisma } from '../../lib/prisma.js';
import {
  parseLimitKeys,
  resolveLimit,
  SENSOR_RANGE_KEYS_DEFAULT,
  SENSOR_RANGE_TEXT_DEFAULT,
  rangeText,
  type SensorRangeConfig,
  type SensorRangeBounds,
  type RangeBound,
} from '@digilog/shared';

/**
 * The administered `sensor-range-alarms` config.
 *
 * Reads `enabled !== false` — ships ON, like `alarm-limits` and `rs485-alarms`
 * and unlike `inactivity-alarms`. Measured before choosing it: not one of the
 * 200 current slot readings on this installation is outside its instrument's
 * declared range, so switching it on raises nothing. Re-derive elsewhere before
 * trusting that.
 *
 * Reuses `parseLimitKeys`/`resolveLimit` from the limit machinery deliberately:
 * range bounds are instrument attributes read by ordered alias exactly as limits
 * are, and a second resolver would drift from the first the next time somebody's
 * key spelling changed.
 */
export async function loadRangeConfig(): Promise<SensorRangeConfig> {
  const row = await prisma.systemConfig.findUnique({ where: { configKey: 'sensor-range-alarms' } });
  const cfg = (row?.configValue ?? {}) as Record<string, unknown>;

  const list = (key: string, fallback: string) =>
    parseLimitKeys(typeof cfg[key] === 'string' ? (cfg[key] as string) : fallback);

  return {
    enabled: cfg.enabled !== false,
    rangeText: rangeText(cfg.rangeText as string | undefined) || SENSOR_RANGE_TEXT_DEFAULT,
    keys: {
      temperatureHigh: list('temperatureHighKeys', SENSOR_RANGE_KEYS_DEFAULT.temperatureHigh),
      temperatureLow: list('temperatureLowKeys', SENSOR_RANGE_KEYS_DEFAULT.temperatureLow),
      humidityHigh: list('humidityHighKeys', SENSOR_RANGE_KEYS_DEFAULT.humidityHigh),
      humidityLow: list('humidityLowKeys', SENSOR_RANGE_KEYS_DEFAULT.humidityLow),
    },
  };
}

/**
 * One instrument's four range bounds, plus which attribute key each came from.
 *
 * The key is kept so it can be frozen onto the alarm: "this fired against
 * `High Temperature Range` = 50" stays answerable after the attribute is renamed
 * or deleted — the same reasoning as `limitsFor`.
 */
export function rangeFor(
  keys: SensorRangeConfig['keys'],
  attributes: { key: string; value: string }[],
): { bounds: SensorRangeBounds; attributeKeys: Record<RangeBound, string | null> } {
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
  };
}
