/**
 * Gateway fan-out — PURE. No database, no I/O.
 *
 * Splits a device-keyed batch payload into per-child readings, applying the one
 * authorisation rule this feature exists for: a gateway may write instrument X
 * iff X is in its child map. Everything else is dead-lettered rather than
 * silently dropped, and never auto-created — a registry that grows itself from
 * payloads cannot be trusted as a §11 record.
 */
import { toReadings, type Reading } from './payload-parser.js';

export interface ChildRef { id: string; isActive: boolean }
/** code → child. The gateway's OWN code is deliberately absent. */
export type ChildMap = Map<string, ChildRef>;

export interface FanoutResult {
  readings: (Reading & { instrumentId: string })[];
  rejected: { code: string; reason: string }[];
}

/** Reserved keys inside a per-device block (mirrors payload-parser's META_KEYS). */
const BLOCK_META = new Set(['ts', 'timestamp', 'quality']);

export function fanoutDevices(
  devices: Record<string, unknown>,
  childMap: ChildMap,
  ts: Date,
  gatewayCode: string,
): FanoutResult {
  const readings: FanoutResult['readings'] = [];
  const rejected: FanoutResult['rejected'] = [];

  for (const [code, block] of Object.entries(devices)) {
    const child = childMap.get(code);
    if (!child) {
      // The gateway's own code is never in its child map (a gateway is not its
      // own child), so a gateway that folds its own diagnostics into the batch
      // lands here — and the generic reason then tells the operator that "GW-1"
      // is not linked to gateway "GW-1", which is true and useless. Name the
      // actual situation and the actual remedy: the flat payload form is
      // authenticated as the gateway itself and stores against it.
      rejected.push({
        code,
        reason: code === gatewayCode
          ? `A gateway cannot report its own readings inside a batch. Send "${gatewayCode}"'s own readings as a flat payload on a separate request.`
          : `"${code}" is not linked to gateway "${gatewayCode}" (unknown or linked elsewhere)`,
      });
      continue;
    }
    if (!child.isActive) {
      rejected.push({ code, reason: `Instrument "${code}" is not active` });
      continue;
    }
    if (block === null || typeof block !== 'object' || Array.isArray(block)) {
      rejected.push({ code, reason: `Block for "${code}" must be a JSON object` });
      continue;
    }

    const obj = block as Record<string, unknown>;
    // A per-block timestamp wins: the gateway may be forwarding a reading it
    // buffered minutes ago, and stamping it with the envelope time would
    // silently rewrite when it was measured.
    let blockTs = ts;
    const rawTs = obj.ts ?? obj.timestamp;
    if (typeof rawTs === 'string' || typeof rawTs === 'number') {
      const d = new Date(rawTs);
      if (!Number.isNaN(d.getTime())) blockTs = d;
    }

    // Object.create(null) — a plain {} has an inherited Object.prototype.__proto__
    // setter, so a reading key literally named "__proto__" would hit that
    // accessor instead of creating an own property and vanish with no trace in
    // either readings or rejected. Do not "tidy" this back to {}.
    const values: Record<string, unknown> = Object.create(null);
    for (const [k, v] of Object.entries(obj)) if (!BLOCK_META.has(k)) values[k] = v;

    for (const r of toReadings(values, blockTs)) {
      readings.push({ ...r, instrumentId: child.id });
    }
  }

  return { readings, rejected };
}
