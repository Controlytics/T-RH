/**
 * Reading the administered decimals mapping off the `telemetry-slots` config.
 *
 * Its own module because three unrelated callers need the same answer — the
 * fleet overview, the room-history chart, and the alarm evaluator that freezes
 * precision onto a raised alarm — and a second copy of "which key, what
 * fallback" is exactly how one instrument comes to render at two precisions in
 * two places.
 *
 * The rules themselves (parsing, precedence, clamping) live in
 * @digilog/shared/telemetry-decimals; this file only fetches the settings.
 */
import { prisma } from '../../lib/prisma.js';
import {
  parseTelemetryAliases,
  resolveDecimals,
  clampDecimals,
  slotForAttributeKey,
  formatDecimals,
  TELEMETRY_DECIMALS_KEYS_DEFAULT,
  TELEMETRY_DECIMALS_FALLBACK,
  TELEMETRY_VALUED_KEYS_DEFAULT,
  type TelemetrySlot,
} from '@digilog/shared';

export interface DecimalsConfig {
  keys: Record<TelemetrySlot, string[]>;
  fallback: Record<TelemetrySlot, number>;
  /**
   * Which attribute keys hold a temperature and which a humidity, so a LIMIT or a
   * RANGE is shown at the same precision as the reading it bounds. Nothing about
   * a free-text `High Temperature Range = 50` says it is degrees, so the
   * classification is administered rather than guessed from the words in the key.
   */
  valuedKeys: Record<TelemetrySlot, string[]>;
}

export const DECIMALS_CONFIG_DEFAULT: DecimalsConfig = {
  keys: {
    temperature: parseTelemetryAliases(TELEMETRY_DECIMALS_KEYS_DEFAULT.temperature),
    humidity: parseTelemetryAliases(TELEMETRY_DECIMALS_KEYS_DEFAULT.humidity),
  },
  fallback: {
    temperature: TELEMETRY_DECIMALS_FALLBACK,
    humidity: TELEMETRY_DECIMALS_FALLBACK,
  },
  valuedKeys: {
    temperature: parseTelemetryAliases(TELEMETRY_VALUED_KEYS_DEFAULT.temperature),
    humidity: parseTelemetryAliases(TELEMETRY_VALUED_KEYS_DEFAULT.humidity),
  },
};

/**
 * Same config row the slot aliases come from — one setting group answering "how
 * is this reading presented". A missing row means the shipped defaults, never
 * "no formatting": an unseeded install must still render numbers.
 */
export async function loadDecimalsConfig(): Promise<DecimalsConfig> {
  const row = await prisma.systemConfig.findUnique({ where: { configKey: 'telemetry-slots' } });
  const cfg = (row?.configValue ?? {}) as Record<string, unknown>;

  const list = (key: string, fallback: string) =>
    parseTelemetryAliases(typeof cfg[key] === 'string' ? (cfg[key] as string) : fallback);
  const num = (key: string) =>
    typeof cfg[key] === 'number' ? clampDecimals(cfg[key]) : TELEMETRY_DECIMALS_FALLBACK;

  return {
    keys: {
      temperature: list('temperatureDecimalsKeys', TELEMETRY_DECIMALS_KEYS_DEFAULT.temperature),
      humidity: list('humidityDecimalsKeys', TELEMETRY_DECIMALS_KEYS_DEFAULT.humidity),
    },
    fallback: {
      temperature: num('temperatureDecimals'),
      humidity: num('humidityDecimals'),
    },
    valuedKeys: {
      temperature: list('temperatureValuedKeys', TELEMETRY_VALUED_KEYS_DEFAULT.temperature),
      humidity: list('humidityValuedKeys', TELEMETRY_VALUED_KEYS_DEFAULT.humidity),
    },
  };
}

/** One instrument's precision for both slots. */
export function decimalsFor(
  cfg: DecimalsConfig,
  attributes: { key: string; value: string }[],
): Record<TelemetrySlot, number> {
  return {
    temperature: resolveDecimals(cfg.keys.temperature, attributes, cfg.fallback.temperature),
    humidity: resolveDecimals(cfg.keys.humidity, attributes, cfg.fallback.humidity),
  };
}

/**
 * One attribute annotated with the slot it measures and the precision to show it
 * at — or nulls for an attribute that is not a reading.
 *
 * `display` is computed here rather than left to the client so a limit on this
 * page, the same limit in the set-point column and the same limit on an alarm row
 * are one string produced once. It is DISPLAY ONLY: `value` is still exactly what
 * was typed, and that is what the evaluator parses.
 *
 * A key that is classified but holds something unparseable ("about 25") gets a
 * null `display` and keeps its raw value. Blanking it would hide a recorded §11
 * value because it did not match a number format.
 */
export function annotateAttribute(
  cfg: DecimalsConfig,
  instrumentDecimals: Record<TelemetrySlot, number>,
  attr: { key: string; value: string },
): { slot: TelemetrySlot | null; decimals: number | null; display: string | null } {
  const slot = slotForAttributeKey(cfg.valuedKeys, attr.key);
  if (!slot) return { slot: null, decimals: null, display: null };
  const decimals = instrumentDecimals[slot];
  return { slot, decimals, display: formatDecimals(attr.value, decimals) };
}
