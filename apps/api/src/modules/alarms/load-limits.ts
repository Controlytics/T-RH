import { prisma } from '../../lib/prisma.js';
import {
  parseLimitKeys,
  resolveLimit,
  ALARM_LIMIT_KEYS_DEFAULT,
  type LimitBound,
} from '@digilog/shared';
import type { InstrumentLimits } from './limit-decide.js';

/**
 * The administered attribute-key mapping, read from the `alarm-limits` config.
 *
 * Loaded the same way telemetry-overview.ts loads `telemetry-slots`: one row, with
 * the shipped defaults as the fallback so a missing config never means "no alarms".
 */
export interface LimitConfig {
  enabled: boolean;
  severity: 'CRITICAL' | 'MAJOR' | 'MINOR';
  keys: Record<LimitBound, string[]>;
}

const SEVERITIES = ['CRITICAL', 'MAJOR', 'MINOR'] as const;

export async function loadLimitConfig(): Promise<LimitConfig> {
  const row = await prisma.systemConfig.findUnique({ where: { configKey: 'alarm-limits' } });
  const cfg = (row?.configValue ?? {}) as Record<string, unknown>;

  const list = (key: string, fallback: string) =>
    parseLimitKeys(typeof cfg[key] === 'string' ? (cfg[key] as string) : fallback);

  const severity = SEVERITIES.includes(cfg.severity as never)
    ? (cfg.severity as LimitConfig['severity'])
    : 'CRITICAL';

  return {
    // Absent config means enabled: the feature ships on, and a half-seeded row
    // must not silently stop every limit alarm.
    enabled: cfg.enabled !== false,
    severity,
    keys: {
      temperatureHigh: list('temperatureHighKeys', ALARM_LIMIT_KEYS_DEFAULT.temperatureHigh),
      temperatureLow: list('temperatureLowKeys', ALARM_LIMIT_KEYS_DEFAULT.temperatureLow),
      humidityHigh: list('humidityHighKeys', ALARM_LIMIT_KEYS_DEFAULT.humidityHigh),
      humidityLow: list('humidityLowKeys', ALARM_LIMIT_KEYS_DEFAULT.humidityLow),
    },
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
