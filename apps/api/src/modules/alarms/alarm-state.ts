/**
 * Alarm state machine — PURE. Returns an INTENDED transition; it never writes.
 *
 *              breach
 *    (none) ───────────▶ ACTIVE ───── recover ────▶ RESOLVED_UNACKED
 *                          │  ▲                          │      │
 *                     ack  │  └───── re-breach ──────────┘      │ ack
 *                          ▼                                    ▼
 *                    ACTIVE_ACKED ──── recover ──────────▶   CLOSED
 *
 * Two invariants, both asserted in the tests:
 *   1. Within THIS machine, CLOSED is reachable ONLY through a human
 *      acknowledgement. Nothing self-closes — that is the entire point of
 *      latching. See the exception below: the invariant holds for THRESHOLD
 *      alarms, and is not the whole truth for the system as a whole.
 *   2. A re-breach walks RESOLVED_UNACKED back to ACTIVE, so a flapping sensor
 *      cannot have its excursion closed out from under the reviewing operator.
 *
 * EXCEPTION — a second writer of `alarms.state` exists outside this machine.
 * `touchLiveness()` in `alarm.repository.ts` closes LIVENESS alarms
 * (`threshold_id IS NULL`, key `__liveness__`) automatically when the device
 * resumes reporting, with no acknowledgement. That is deliberate and specified
 * (design spec §8): a device coming back is not a deviation needing
 * disposition — the THRESHOLD excursions are what latch. So invariant 1 reads
 * precisely as: THRESHOLD alarms reach CLOSED only via `applyAck` below;
 * LIVENESS alarms are additionally auto-closed by `touchLiveness`, which emits
 * its own ALARM_RESOLVED audit row for the closure.
 */
import type { AlarmSeverity, AlarmState } from '@prisma/client';
import type { Verdict } from './threshold-evaluator.js';

export interface OpenAlarmView {
  id: string;
  state: AlarmState;
  breachCount: number;
  peakValue: number | null;
}

export type Transition =
  | { kind: 'RAISE'; severity: AlarmSeverity; value: number; ts: Date }
  | { kind: 'REBREACH'; alarmId: string; value: number; ts: Date; backToActive: boolean }
  | { kind: 'RESOLVE'; alarmId: string; ts: Date; close: boolean }
  | { kind: 'NONE' };

export function nextTransition(
  verdict: Verdict,
  open: OpenAlarmView | null,
  severity: AlarmSeverity,
  value: number,
  ts: Date,
): Transition {
  if (verdict === 'BREACH') {
    if (!open) return { kind: 'RAISE', severity, value, ts };
    return {
      kind: 'REBREACH', alarmId: open.id, value, ts,
      backToActive: open.state === 'RESOLVED_UNACKED',
    };
  }

  if (verdict === 'RECOVERED' && open) {
    // Only ACTIVE and ACTIVE_ACKED can recover. RESOLVED_UNACKED has already
    // recovered; re-reporting it would rewrite resolvedAt on every message.
    if (open.state === 'ACTIVE') return { kind: 'RESOLVE', alarmId: open.id, ts, close: false };
    if (open.state === 'ACTIVE_ACKED') return { kind: 'RESOLVE', alarmId: open.id, ts, close: true };
  }

  return { kind: 'NONE' };
}

/**
 * The state an acknowledgement produces, or null if the alarm cannot be
 * acknowledged. Null is a rejection (HTTP 409), not a no-op — re-signing an
 * already-signed record would put a second attributable signature on the same
 * event.
 */
export function applyAck(state: AlarmState): AlarmState | null {
  if (state === 'ACTIVE') return 'ACTIVE_ACKED';
  if (state === 'RESOLVED_UNACKED') return 'CLOSED';
  return null;
}
