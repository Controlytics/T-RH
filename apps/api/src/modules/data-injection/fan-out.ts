/**
 * Fan-out — PURE. Resolution is injected, so this file never touches a database.
 *
 * The load-bearing rule: in a batch payload, ONE unknown deviceKey dead-letters
 * only its own entry. Discarding 49 good readings because the 50th device was
 * mis-keyed would turn a configuration error into data loss.
 */
import type { TopicRoute } from './topic-router.js';
import { toReadings, type ParsedPayload, type Reading } from './payload-parser.js';

export interface InstrumentResolver {
  bySlug(gatewaySlug: string, instrumentSlug: string): string | null;
  byDeviceKey(gatewaySlug: string, deviceKey: string): string | null;
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
    const id = resolver.bySlug(route.gatewaySlug, route.instrumentSlug);
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
    const id = resolver.byDeviceKey(route.gatewaySlug, deviceKey);
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
