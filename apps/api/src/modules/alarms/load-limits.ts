import { prisma } from '../../lib/prisma.js';
import {
  parseLimitKeys,
  resolveLimit,
  resolveEnableFlag,
  ALARM_LIMIT_KEYS_DEFAULT,
  ALARM_LIMIT_ENABLE_KEYS_DEFAULT,
  type LimitBound,
} from '@digilog/shared';
import type { InstrumentLimits } from './limit-decide.js';
import { limitsInverted } from './limit-decide.js';

/**
 * The administered attribute-key mapping, read from the `alarm-limits` config.
 *
 * Loaded the same way telemetry-overview.ts loads `telemetry-slots`: one row, with
 * the shipped defaults as the fallback so a missing config never means "no alarms".
 */
export interface LimitConfig {
  enabled: boolean;
  keys: Record<LimitBound, string[]>;
  /** Which attribute says whether each bound is IN FORCE. See
   *  ALARM_LIMIT_ENABLE_KEYS_DEFAULT for why a bound needs a switch of its own. */
  enableKeys: Record<LimitBound, string[]>;
}

export async function loadLimitConfig(): Promise<LimitConfig> {
  const row = await prisma.systemConfig.findUnique({ where: { configKey: 'alarm-limits' } });
  const cfg = (row?.configValue ?? {}) as Record<string, unknown>;

  const list = (key: string, fallback: string) =>
    parseLimitKeys(typeof cfg[key] === 'string' ? (cfg[key] as string) : fallback);

  return {
    // Absent config means enabled: the feature ships on, and a half-seeded row
    // must not silently stop every limit alarm.
    enabled: cfg.enabled !== false,
    keys: {
      temperatureHigh: list('temperatureHighKeys', ALARM_LIMIT_KEYS_DEFAULT.temperatureHigh),
      temperatureLow: list('temperatureLowKeys', ALARM_LIMIT_KEYS_DEFAULT.temperatureLow),
      humidityHigh: list('humidityHighKeys', ALARM_LIMIT_KEYS_DEFAULT.humidityHigh),
      humidityLow: list('humidityLowKeys', ALARM_LIMIT_KEYS_DEFAULT.humidityLow),
    },
    enableKeys: {
      temperatureHigh: list('temperatureHighEnableKeys', ALARM_LIMIT_ENABLE_KEYS_DEFAULT.temperatureHigh),
      temperatureLow: list('temperatureLowEnableKeys', ALARM_LIMIT_ENABLE_KEYS_DEFAULT.temperatureLow),
      humidityHigh: list('humidityHighEnableKeys', ALARM_LIMIT_ENABLE_KEYS_DEFAULT.humidityHigh),
      humidityLow: list('humidityLowEnableKeys', ALARM_LIMIT_ENABLE_KEYS_DEFAULT.humidityLow),
    },
  };
}

/**
 * Which of an instrument's four bounds are switched on.
 *
 * Absent flag = enabled, so an instrument that carries no flags at all behaves
 * exactly as it did before this existed.
 */
export function enabledBoundsFor(
  enableKeys: LimitConfig['enableKeys'],
  attributes: { key: string; value: string }[],
): Record<LimitBound, boolean> {
  const on = (bound: LimitBound) => resolveEnableFlag(enableKeys[bound], attributes)?.enabled ?? true;
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
 * or deleted.
 */
export function limitsFor(
  keys: LimitConfig['keys'],
  attributes: { key: string; value: string }[],
): { limits: InstrumentLimits; attributeKeys: Record<LimitBound, string | null> } {
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
 */
export function countWithoutLimits(
  instruments: { code: string; attributes: { key: string; value: string }[] }[],
  keys: LimitConfig['keys'],
): { count: number; codes: string[] } {
  const codes: string[] = [];
  let count = 0;
  for (const inst of instruments) {
    const { limits } = limitsFor(keys, inst.attributes);
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
