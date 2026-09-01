/**
 * RS485 sensor-failure decisions: is this instrument's temperature (or humidity)
 * sensor reporting something that is not a number?
 *
 * PURE, like `decide.ts`, `limit-decide.ts` and `inactivity-decide.ts` beside it.
 * The worker does only I/O. This is the part that decides whether a regulated
 * fault is recorded, and the only part a machine can check.
 *
 * **The rule that matters: the CLEAR signal is A NUMBER, and SILENCE HOLDS THE
 * ALARM OPEN.** That is the `limit-decide.ts` rule, and the exact OPPOSITE of
 * `inactivity-decide.ts`, where absence IS the alarm and presence is the proof of
 * recovery. Here you cannot prove a probe was repaired from the fact that it
 * stopped talking — so a missing reading changes nothing, and the instrument
 * going quiet is INACTIVITY's question, raised separately and cleared separately.
 * A pass written by copying the inactivity pass's shape would clear every RS485
 * alarm the moment the broken device fell silent, which is precisely when the
 * fault is least resolved.
 *
 * Design: docs/superpowers/specs/2026-08-31-rs485-sensor-failure-alarms-design.md
 */

import { isSensorFailureValue } from '@digilog/shared';

export type Rs485Action = 'raise' | 'clear' | 'none';

export interface Rs485Sample {
  /**
   * The stored value on the slot's resolved key, or `undefined` when the
   * instrument has sent no reading on any alias for this slot.
   *
   * `undefined` and `null` are NOT the same thing and must not be conflated:
   * `undefined` is "no key" (silence), while a stored JSON `null` is a value the
   * device actually sent and IS a failure. `toReadings()` drops nulls at ingest
   * today, so the second case should not arise — but this module is the guard,
   * not the caller.
   */
  value: unknown | undefined;
  /** A decommissioned instrument is not wired up; nothing here is a fault. */
  isActive: boolean;
  hasOpenAlarm: boolean;
}

export function decideRs485(s: Rs485Sample): Rs485Action {
  // Clearing is checked FIRST and is deliberately NOT gated on `isActive`.
  // Retiring an instrument must not strand an alarm that is already open; the
  // isActive guard below suppresses RAISING, which is a different question.
  if (s.hasOpenAlarm) {
    // No reading at all: HOLD. See the header — silence is not recovery.
    if (s.value === undefined) return 'none';
    return isSensorFailureValue(s.value) ? 'none' : 'clear';
  }

  // Nothing arrived on this slot. Not a sensor failure — this instrument may
  // simply not measure humidity, or may never have reported at all. Raising here
  // would alarm every temperature-only logger for a humidity probe it does not
  // have.
  if (s.value === undefined) return 'none';

  // A good reading. Nothing to record.
  if (!isSensorFailureValue(s.value)) return 'none';

  // Silent on purpose. An alarm nobody can clear is worse than no alarm.
  if (!s.isActive) return 'none';

  return 'raise';
}
