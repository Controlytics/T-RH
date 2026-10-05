import {
  SENSOR_OFFSETS_CONFIG_KEY, TELEMETRY_SLOT_ALIASES_DEFAULT,
  coerceSensorOffsetConfig, parseOffsetValue, parseTelemetryAliases, offsetReadings, isOffsetAttributeKey,
  type SensorOffsetConfig, type TelemetrySlot,
} from '@digilog/shared';
import { prisma } from '../../lib/prisma.js';
import { classifyValue } from './payload-parser.js';

/**
 * Sensor offsets (2026-10-01) — the server half. See
 * `@digilog/shared/sensor-offsets` for the rules.
 *
 * The config is read on EVERY ingest batch, so it is cached for 10 seconds
 * (the reauth-config precedent): a super admin's change reaches the next
 * readings within that, and a device reporting every few seconds does not
 * cost a config read per message. `invalidateOffsetConfigCache` clears it.
 */
let cache: { config: SensorOffsetConfig; at: number } | null = null;
const TTL_MS = 10_000;

export async function loadOffsetConfig(): Promise<SensorOffsetConfig> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.config;
  const row = await prisma.systemConfig.findUnique({ where: { configKey: SENSOR_OFFSETS_CONFIG_KEY } });
  const config = coerceSensorOffsetConfig(row?.configValue);
  cache = { config, at: Date.now() };
  return config;
}

export function invalidateOffsetConfigCache(): void { cache = null; }

/** Which telemetry keys are temperature / humidity — Configuration → Telemetry Slots. */
async function slotAliases(): Promise<Record<TelemetrySlot, string[]>> {
  const row = await prisma.systemConfig.findUnique({ where: { configKey: 'telemetry-slots' } });
  const cfg = (row?.configValue ?? {}) as Record<string, unknown>;
  return {
    temperature: parseTelemetryAliases((cfg.temperatureKeys as string) ?? TELEMETRY_SLOT_ALIASES_DEFAULT.temperature),
    humidity: parseTelemetryAliases((cfg.humidityKeys as string) ?? TELEMETRY_SLOT_ALIASES_DEFAULT.humidity),
  };
}

/**
 * Each instrument's offsets, from its attributes: per slot, the FIRST alias key
 * the instrument actually has, if its value parses. An unparseable value is
 * ignored (the write path refuses one, so only a row older than the rule could
 * hold it) — a typo must never shift every reading by NaN.
 */
async function offsetsFor(config: SensorOffsetConfig, instrumentIds: string[]): Promise<Map<string, Partial<Record<TelemetrySlot, number>>>> {
  const keys = [...config.keys.temperature, ...config.keys.humidity];
  const rows = await prisma.instrumentAttribute.findMany({
    where: { instrumentId: { in: instrumentIds }, OR: keys.map((k) => ({ key: { equals: k, mode: 'insensitive' as const } })) },
    select: { instrumentId: true, key: true, value: true },
  });
  const out = new Map<string, Partial<Record<TelemetrySlot, number>>>();
  for (const id of instrumentIds) {
    const mine = rows.filter((r) => r.instrumentId === id);
    const pick = (aliases: string[]) => {
      for (const a of aliases) {
        const hit = mine.find((r) => r.key.trim().toLowerCase() === a);
        if (hit) return parseOffsetValue(hit.value) ?? undefined;
      }
      return undefined;
    };
    const t = pick(config.keys.temperature);
    const h = pick(config.keys.humidity);
    if (t !== undefined || h !== undefined) out.set(id, { ...(t !== undefined ? { temperature: t } : {}), ...(h !== undefined ? { humidity: h } : {}) });
  }
  return out;
}

/**
 * Correct a batch of readings (any number of instruments) before it is stored.
 * Returns the rows unchanged when the feature is off or nobody in the batch has
 * an offset.
 *
 * THROWS when the offsets cannot be resolved (audit 2026-10-03, INGEST-11).
 * Until then a failed lookup — a database blip inside `offsetsFor`, say —
 * logged a line and handed the rows back UNCORRECTED, which the write path
 * then stored exactly as it stores a corrected batch: `raw_value` NULL,
 * nothing on the row to say the correction was skipped, two degrees off and
 * indistinguishable from a reading that never needed one. A reading this
 * system cannot vouch for must not be stored as one it can. The throw lands in
 * `writeBatchOrDeadLetter` (ingest-core.ts), which records the raw payload as
 * a dead letter with the error against the sender and answers the device with
 * WRITE_FAILED (503 on HTTP), so it retries once the fault is gone — the same
 * path a partition miss takes, for the same reason.
 *
 * The corrected number's `valueType` comes from `classifyValue`, the ONE
 * ingest vocabulary (`int` | `float`), passed into the pure shared function
 * rather than restated there.
 */
export async function applySensorOffsets<R extends { instrumentId: string; key: string; value: unknown; valueType: string }>(
  rows: R[],
): Promise<(R & { rawValue?: unknown })[]> {
  if (rows.length === 0) return rows;
  const config = await loadOffsetConfig();
  if (!config.enabled) return rows;
  const ids = [...new Set(rows.map((r) => r.instrumentId))];
  const offsets = await offsetsFor(config, ids);
  if (offsets.size === 0) return rows;
  const aliases = await slotAliases();
  return rows.map((r) => {
    const o = offsets.get(r.instrumentId);
    return o ? offsetReadings([r], aliases, o, classifyValue)[0] : r;
  });
}

/**
 * The ONE server-side test of "is this attribute key an offset" (config-driven,
 * case-folded). Offsets are SUPER_ADMIN-only: stripped from every response to
 * any other role, refused on their writes, never sent to a device (firmware
 * that applied it too would correct the reading twice) and never accepted from
 * one.
 */
export async function offsetKeyTest(): Promise<(key: string) => boolean> {
  const config = await loadOffsetConfig();
  return (key: string) => isOffsetAttributeKey(config, key);
}

/** Drop offset keys from a key→value map (a downlink, a response). */
export async function withoutOffsets<V>(attributes: Record<string, V>): Promise<Record<string, V>> {
  const isOffset = await offsetKeyTest();
  return Object.fromEntries(Object.entries(attributes).filter(([k]) => !isOffset(k)));
}
