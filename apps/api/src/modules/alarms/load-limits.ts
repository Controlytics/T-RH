import { prisma } from '../../lib/prisma.js';
import {
  resolveLimit,
  resolveEnableFlag,
  type InstrumentSlotConfig,
  type LimitBound,
} from '@digilog/shared';
import type { InstrumentLimits } from './limit-decide.js';
import { limitsInverted } from './limit-decide.js';

/** Ordered, lower-cased attribute-key aliases per bound. */
export type LimitKeys = Record<LimitBound, string[]>;

/**
 * The GLOBAL half of the limit feature: the master switch, read from the
 * `alarm-limits` config. Which attributes hold the bounds, which attribute
 * switches each bound, and the profile's own NMT / NLT switch are the
 * instrument PROFILE's since 2026-10-26 — `InstrumentSlotConfig.limitKeys` /
 * `enableKeys` / `boundSwitch`, resolved by
 * `modules/instruments/profile-measurements.ts`.
 */
export interface LimitConfig {
  enabled: boolean;
}

export async function loadLimitConfig(): Promise<LimitConfig> {
  const row = await prisma.systemConfig.findUnique({ where: { configKey: 'alarm-limits' } });
  const cfg = (row?.configValue ?? {}) as Record<string, unknown>;
  // Absent config means enabled: the feature ships on, and a half-seeded row
  // must not silently stop every limit alarm.
  return { enabled: cfg.enabled !== false };
}

/**
 * Which of an instrument's four bounds are switched on.
 *
 * Two gates, ANDed (operator 2026-10-26: "in instrument profiles NLT and MNT
 * … enabled or disabled"): the PROFILE's NMT / NLT switch (`boundSwitch`) —
 * off means the bound is never enforced for any instrument of the profile —
 * then the instrument's own enable attribute, exactly as before. Absent
 * attribute = enabled, so an instrument that carries no flags behaves as it did
 * before flags existed; an empty enable-key list therefore means "always on".
 */
export function enabledBoundsFor(
  cfg: Pick<InstrumentSlotConfig, 'enableKeys' | 'boundSwitch'>,
  attributes: { key: string; value: string }[],
): Record<LimitBound, boolean> {
  const on = (bound: LimitBound) =>
    cfg.boundSwitch[bound] && (resolveEnableFlag(cfg.enableKeys[bound], attributes)?.enabled ?? true);
  return {
    temperatureHigh: on('temperatureHigh'),
    temperatureLow: on('temperatureLow'),
    humidityHigh: on('humidityHigh'),
    humidityLow: on('humidityLow'),
  };
}

/**
 * One instrument's four limits, plus which attribute key each came from.
 *
 * The key is kept so it can be frozen onto the alarm snapshot: "this fired against
 * `High Temperature` = 25" is answerable later even after the attribute is renamed
 * or deleted. `keys` is the instrument's profile `limitKeys`.
 */
export function limitsFor(
  keys: LimitKeys,
  attributes: { key: string; value: string }[],
): {
  limits: InstrumentLimits;
  attributeKeys: Record<LimitBound, string | null>;
  /**
   * The TEXT each bound's attribute carries beside its number (`60 (For
   * Reference)`), null when the value is a bare number. The number in
   * `limits` is what is enforced; this is what the set point prints
   * (operator, 2026-10-03). Frozen onto the alarm snapshot beside the number
   * for the same reason the number is.
   */
  texts: Record<LimitBound, string | null>;
} {
  const hit = (bound: LimitBound) => resolveLimit(keys[bound], attributes);
  const th = hit('temperatureHigh');
  const tl = hit('temperatureLow');
  const hh = hit('humidityHigh');
  const hl = hit('humidityLow');
  return {
    limits: {
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

/** How many codes the summary will name before it just gives a number. */
const CODE_CAP = 50;

/**
 * Instruments no limit alarm can ever fire for.
 *
 * Exists so an empty Alarms page cannot mean both "everything is in spec" and
 * "nothing is being watched". Counts the three ways an instrument ends up
 * unwatched — no limit attribute, an unparseable value, and an inverted pair —
 * because all three look identical to an operator who believes it is configured.
 *
 * Each instrument is judged by ITS profile's keys (`limitKeys`, 2026-10-26);
 * `keys` is the fallback for an entry that carries none.
 */
export function countWithoutLimits(
  instruments: { code: string; attributes: { key: string; value: string }[]; limitKeys?: LimitKeys }[],
  keys: LimitKeys,
): { count: number; codes: string[] } {
  const codes: string[] = [];
  let count = 0;
  for (const inst of instruments) {
    const { limits } = limitsFor(inst.limitKeys ?? keys, inst.attributes);
    const tempUsable = !limitsInverted(limits.temperatureHigh, limits.temperatureLow)
      && (limits.temperatureHigh !== null || limits.temperatureLow !== null);
    const rhUsable = !limitsInverted(limits.humidityHigh, limits.humidityLow)
      && (limits.humidityHigh !== null || limits.humidityLow !== null);
    if (tempUsable || rhUsable) continue;
    count += 1;
    if (codes.length < CODE_CAP) codes.push(inst.code);
  }
  return { count, codes };
}
