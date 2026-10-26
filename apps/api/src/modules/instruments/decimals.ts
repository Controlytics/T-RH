/**
 * An instrument's display precision, and which of its attributes are shown at it.
 *
 * Its own module because several unrelated callers need the same answer — the
 * fleet overview, the room-history chart, the per-instrument telemetry route and
 * the alarm evaluator that freezes precision onto a raised alarm — and a second
 * copy of "which key, what fallback" is exactly how one instrument comes to
 * render at two precisions in two places.
 *
 * WHICH attribute holds the decimals, the fallback, and which attributes are
 * "valued" (limits and ranges, shown at the reading's precision) are the
 * instrument PROFILE's since 2026-10-26 — `InstrumentSlotConfig.decimals`,
 * resolved by `profile-measurements.ts`; until then they were the global
 * `telemetry-slots` row. The rules themselves (parsing, precedence, clamping)
 * live in @digilog/shared/telemetry-decimals.
 */
import {
  resolveDecimals,
  slotForAttributeKey,
  formatDecimals,
  slotConfigFromMeasurements,
  DEFAULT_PROFILE_MEASUREMENTS,
  type InstrumentSlotConfig,
  type TelemetrySlot,
} from '@digilog/shared';

/** One profile's decimals mapping — `InstrumentSlotConfig.decimals`. */
export type DecimalsConfig = InstrumentSlotConfig['decimals'];

/** The mapping of a never-customised profile. */
export const DECIMALS_CONFIG_DEFAULT: DecimalsConfig = slotConfigFromMeasurements(DEFAULT_PROFILE_MEASUREMENTS).decimals;

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
