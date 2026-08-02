/**
 * Fan-out — PURE. Resolution is injected, so this file never touches a database.
 *
 * The load-bearing rule: in a batch payload, ONE unknown deviceKey dead-letters
 * only its own entry. Discarding 49 good readings because the 50th device was
 * mis-keyed would turn a configuration error into data loss.
 */
import type { TopicRoute } from './topic-router.js';
import { toReadings, type ParsedPayload, type Reading } from './payload-parser.js';
import type { TopicCategory } from '../instruments/topic-resolver.js';

/**
 * Categories P2 has storage for. Everything else dead-letters.
 *
 * Without this guard a message on …/alarm or …/status would be written to the
 * telemetry tables and become indistinguishable from a real reading — and since
 * the adapter subscribes to `<gatewayBase>/#`, outbound COMMAND/RPC traffic the
 * API itself publishes (P8) would be received and ingested as instrument data,
 * manufacturing readings from our own writes.
 *
 * Widen this deliberately when P3 adds attribute/event storage — never by
 * accident.
 */
const INGESTIBLE_CATEGORIES = new Set<TopicCategory>(['TELEMETRY']);

export interface InstrumentResolver {
  /** Keyed on baseTopic, NOT gatewaySlug — see TopicRoute for why. */
  bySlug(baseTopic: string, instrumentSlug: string): string | null;
  /** Keyed on gatewayId, NOT gatewaySlug — deviceKey is unique per gateway id. */
  byDeviceKey(gatewayId: string, deviceKey: string): string | null;
}

export interface FanOutBatch {
  instrumentId: string;
  readings: Reading[];
}

export interface FanOutResult {
  batches: FanOutBatch[];
  deadLetters: { reason: string; detail: string }[];
}

export function fanOut(
  route: TopicRoute,
  parsed: ParsedPayload,
  resolver: InstrumentResolver,
  receivedAt: Date,
): FanOutResult {
  // Checked before anything else — an unsupported category must never reach
  // resolution or storage, regardless of whether its payload happens to parse.
  if (!INGESTIBLE_CATEGORIES.has(route.category)) {
    return {
      batches: [],
      deadLetters: [{
        reason: 'UNSUPPORTED_CATEGORY',
        detail: `Category '${route.category}' has no storage in P2`,
      }],
    };
  }

  if (!parsed.ok) {
    return {
      batches: [],
      deadLetters: [{ reason: 'UNPARSEABLE_PAYLOAD', detail: parsed.reason ?? 'unknown' }],
    };
  }

  const ts = parsed.ts ?? receivedAt;
  const batches: FanOutBatch[] = [];
  const deadLetters: { reason: string; detail: string }[] = [];

  const push = (instrumentId: string, values: Record<string, unknown>, label: string) => {
    const readings = toReadings(values, ts);
    if (readings.length === 0) {
      deadLetters.push({ reason: 'NO_READINGS', detail: `${label} produced no usable values` });
      return;
    }
    batches.push({ instrumentId, readings });
  };

  if (route.instrumentSlug !== null) {
    const id = resolver.bySlug(route.baseTopic, route.instrumentSlug);
    if (!id) {
      deadLetters.push({
        reason: 'UNKNOWN_INSTRUMENT',
        detail: `No instrument '${route.instrumentSlug}' under gateway '${route.gatewaySlug}'`,
      });
      return { batches, deadLetters };
    }
    push(id, parsed.values, route.instrumentSlug);
    return { batches, deadLetters };
  }

  if (!parsed.devices) {
    deadLetters.push({
      reason: 'EXPECTED_BATCH_PAYLOAD',
      detail: `Gateway-level topic requires a 'devices' object`,
    });
    return { batches, deadLetters };
  }

  for (const [deviceKey, values] of Object.entries(parsed.devices)) {
    const id = resolver.byDeviceKey(route.gatewayId, deviceKey);
    if (!id) {
      // Only THIS entry is lost. The rest of the batch still lands.
      deadLetters.push({
        reason: 'UNKNOWN_DEVICE_KEY',
        detail: `No instrument with deviceKey '${deviceKey}' under gateway '${route.gatewaySlug}'`,
      });
      continue;
    }
    if (values === null || typeof values !== 'object' || Array.isArray(values)) {
      deadLetters.push({
        reason: 'INVALID_DEVICE_ENTRY',
        detail: `devices['${deviceKey}'] is not an object`,
      });
      continue;
    }
    push(id, values as Record<string, unknown>, deviceKey);
  }

  return { batches, deadLetters };
}
