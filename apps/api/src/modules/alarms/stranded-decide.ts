/**
 * STRANDED alarms (2026-10-26) — an alarm open on a measurement the
 * instrument's PROFILE no longer has.
 *
 * Removing a measurement from a profile, or moving an instrument into a profile
 * that does not measure it, leaves every LIMIT / RS485 / RANGE alarm open on
 * that measurement with nothing that will ever judge it again: the reading is
 * no longer resolved, so no pass can raise, hold or clear it. A permanently red
 * row asserting an ongoing excursion is a worse record than an attributable
 * close — the same reasoning that lets a bound switched OFF clear its alarm
 * (operator, 2026-08-31). This is NOT the renamed-attribute case the limit pass
 * deliberately leaves open: there the measurement is still monitored; here it is
 * not monitored at all. Design: docs/superpowers/specs/2026-10-26-profile-measurements-design.md D5.
 *
 * Pure, so the rule is tested without the evaluator.
 */
import type { TelemetrySlot } from '@digilog/shared';

/** The measurement code → the slot it occupies (phase 1: the two the app knows). */
const SLOT_OF_METRIC: Record<string, TelemetrySlot> = { TEMPERATURE: 'temperature', HUMIDITY: 'humidity' };

/**
 * The ids of open alarms whose measurement the instrument's profile no longer
 * measures. An instrument absent from `measured` is left alone (it is not in
 * this pass's view — a deleted instrument is not a profile change), and a metric
 * that is not a measurement (OFFLINE) never qualifies.
 */
export function strandedAlarmIds(
  open: { id: string; instrumentId: string; metric: string }[],
  measured: Map<string, Record<TelemetrySlot, boolean>>,
): string[] {
  const out: string[] = [];
  for (const a of open) {
    const slot = SLOT_OF_METRIC[a.metric];
    if (!slot) continue;
    const m = measured.get(a.instrumentId);
    if (!m) continue;
    if (!m[slot]) out.push(a.id);
  }
  return out;
}

/** The slot an alarm's metric occupies, or null for a non-measurement metric. */
export function slotOfMetric(metric: string): TelemetrySlot | null {
  return SLOT_OF_METRIC[metric] ?? null;
}
