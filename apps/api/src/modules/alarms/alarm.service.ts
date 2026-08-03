/**
 * Alarm orchestration for one ingest flush.
 *
 * Called from ingestion.service.ts AFTER writeBatch resolves. Ordering is
 * load-bearing: evaluating first would let a failed write leave a latched
 * excursion — one demanding a signed acknowledgement — pointing at a reading
 * that is not in the history table.
 */
import type { Reading } from '../data-injection/payload-parser.js';
import { evaluate, numericValue, type ThresholdSpec } from './threshold-evaluator.js';
import { nextTransition, type OpenAlarmView } from './alarm-state.js';
import {
  loadThresholdCache, loadOpenAlarms, raiseAlarm, rebreachAlarm, resolveAlarm, touchLiveness,
  seriesKey, alarmKey,
} from './alarm.repository.js';
import { dispatchNotification } from '../notification-delivery/notification-dispatcher.js';
import { auditLog } from '../../lib/audit.js';

export async function evaluateFlush(
  batches: { instrumentId: string; readings: Reading[] }[],
  receivedAt: Date,
): Promise<{ raised: number; rebreached: number; resolved: number }> {
  const counts = { raised: 0, rebreached: 0, resolved: 0 };
  if (batches.length === 0) return counts;

  const instrumentIds = [...new Set(batches.map(b => b.instrumentId))];
  const [thresholds, open] = await Promise.all([loadThresholdCache(), loadOpenAlarms()]);
  await touchLiveness(instrumentIds, receivedAt);
  if (thresholds.size === 0) return counts;

  for (const batch of batches) {
    for (const r of batch.readings) {
      const specs: ThresholdSpec[] | undefined = thresholds.get(seriesKey(batch.instrumentId, r.key));
      if (!specs) continue;

      const value = numericValue(r.value);
      if (value === null) continue;   // booleans/strings are not comparable to a limit

      for (const spec of specs) {
        // Keyed PER THRESHOLD. Each threshold on a key is an independent
        // excursion condition; sharing one key across them lets a high-limit
        // breach satisfy a low-limit threshold's recovery test in the same pass.
        const k = alarmKey(batch.instrumentId, r.key, spec.id);
        // `open` is MUTATED as we go. Without that, three breaches of the same
        // series inside one flush would each see "no open alarm" and race the
        // unique index twice for nothing.
        const current: OpenAlarmView | null = open.get(k) ?? null;
        const verdict = evaluate(spec, value, current !== null);
        const t = nextTransition(verdict, current, spec.severity, value, r.ts);

        if (t.kind === 'RAISE') {
          const row = await raiseAlarm({
            instrumentId: batch.instrumentId, key: r.key, thresholdId: spec.id,
            severity: t.severity, value: t.value, ts: t.ts,
          });
          if (!row) continue;   // lost the unique-index race; another flush owns it
          open.set(k, { id: row.id, state: 'ACTIVE', breachCount: 1, peakValue: t.value });
          counts.raised++;
          await auditLog({
            action: 'ALARM_RAISED', targetType: 'Alarm', targetId: row.id,
            afterValue: { instrumentId: batch.instrumentId, key: r.key, value: t.value, severity: t.severity },
          });
          // Fire-and-forget with a logged catch — the same pattern as
          // auth.service.ts's USER_LOCKED dispatch. Awaited, a rejecting
          // notifier would unwind this loop mid-flush; the batch is already
          // written and the queue drained, so every excursion in a LATER
          // reading would be lost with no retry, and the dead letter would
          // blame the evaluator rather than the notifier. The alarm row and
          // its audit row are both committed above, so the regulated record
          // is safe regardless of what the notifier does.
          dispatchNotification({
            eventType: 'ALARM_RAISED',
            context: { severity: t.severity, instrumentId: batch.instrumentId },
            variables: {
              instrumentId: batch.instrumentId, key: r.key,
              value: String(t.value), severity: t.severity,
              limit: String(spec.limit ?? `${spec.limitLow}..${spec.limitHigh}`),
              breachCount: '1', timestamp: t.ts.toISOString(),
            },
          }).catch(err => console.error('[Alarms] ALARM_RAISED notification dispatch failed:', err.message));
        } else if (t.kind === 'REBREACH') {
          await rebreachAlarm(t.alarmId, t.value, t.ts, t.backToActive);
          const prev = open.get(k)!;
          open.set(k, {
            ...prev,
            state: t.backToActive ? 'ACTIVE' : prev.state,
            breachCount: prev.breachCount + 1,
            peakValue: prev.peakValue === null ? t.value : Math.max(prev.peakValue, t.value),
          });
          counts.rebreached++;
          await auditLog({
            action: 'ALARM_REBREACHED', targetType: 'Alarm', targetId: t.alarmId,
            afterValue: { value: t.value, breachCount: prev.breachCount + 1 },
          });
        } else if (t.kind === 'RESOLVE') {
          await resolveAlarm(t.alarmId, t.ts, t.close);
          if (t.close) open.delete(k);
          else open.set(k, { ...open.get(k)!, state: 'RESOLVED_UNACKED' });
          counts.resolved++;
          await auditLog({
            action: 'ALARM_RESOLVED', targetType: 'Alarm', targetId: t.alarmId,
            afterValue: { closed: t.close, value },
          });
        }
      }
    }
  }

  return counts;
}
