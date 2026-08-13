import { prisma } from '../lib/prisma.js';
import { buildTelemetryOverview } from '../modules/instruments/telemetry-overview.js';
import { resolveLocationIds } from '../modules/functional-locations/tree.js';
import type { FlType } from '../modules/functional-locations/validation.js';
import {
  decide,
  isBreaching,
  describeRule,
  ruleSnapshot,
  type RuleShape,
  type Sample,
} from '../modules/alarms/decide.js';

/**
 * Alarm evaluation. graphile-worker task, registered as `alarm_evaluation`.
 *
 * NOT in the ingest path, deliberately: an evaluation that throws must never be able
 * to reject a telemetry write. Device data is the record; alarms are derived from it.
 *
 * Reuses `buildTelemetryOverview()` rather than re-reading telemetry, so slot
 * resolution (which key counts as temperature) and `isInstrumentReporting` — the ONE
 * definition of reporting in this system — are not duplicated here and cannot drift
 * from what the dashboard shows.
 *
 * The decision itself lives in modules/alarms/decide.ts and is unit-tested. This file
 * is only I/O around it.
 */

/**
 * When the current breach run started, for rules with a delay.
 *
 * Derived from history rather than kept as worker state: a restart must not reset every
 * pending delay, and there is nowhere to keep in-memory state in a single-process API
 * that is expected to be restarted freely.
 *
 * Returns null when no breach start can be established, which `decide()` treats as
 * "just started" — the safe direction, because it delays rather than raises.
 */
async function breachStartedAt(
  instrumentId: string,
  keys: string[],
  rule: RuleShape,
  windowSeconds: number,
): Promise<Date | null> {
  if (keys.length === 0) return null;
  const since = new Date(Date.now() - Math.max(windowSeconds, 60) * 1000);
  const rows = await prisma.$queryRaw<{ value: unknown; ts: Date }[]>`
    SELECT value, ts FROM instrument_telemetry_history
    WHERE instrument_id = ${instrumentId}
      AND key = ANY(${keys})
      AND ts >= ${since}
    ORDER BY ts DESC
    LIMIT 500`;

  // Walk newest → oldest. The breach began at the oldest consecutive breaching
  // reading; the first NON-breaching reading ends the run.
  let start: Date | null = null;
  for (const r of rows) {
    const v = typeof r.value === 'number' && Number.isFinite(r.value) ? r.value : null;
    const breaching = isBreaching(rule, { value: v, offline: false, breachingSince: null });
    if (!breaching) break;
    start = r.ts;
  }
  return start;
}

export interface AlarmEvaluationResult {
  rulesEvaluated: number;
  raised: number;
  cleared: number;
}

export async function evaluateAlarms(now = new Date()): Promise<AlarmEvaluationResult> {
  const [rules, locations, overview] = await Promise.all([
    prisma.alarmRule.findMany({ where: { isActive: true } }),
    prisma.functionalLocation.findMany({ select: { id: true, name: true, type: true, parentId: true } }),
    buildTelemetryOverview({}),
  ]);
  if (rules.length === 0) return { rulesEvaluated: 0, raised: 0, cleared: 0 };

  const nodes = locations.map((l) => ({ ...l, type: l.type as FlType }));
  const byInstrument = new Map(overview.map((r) => [r.instrumentId, r]));

  // Which instruments already have an ACTIVE alarm for which rule. One query rather
  // than one per instrument: this runs every minute.
  const active = await prisma.alarm.findMany({
    where: { state: 'ACTIVE', ruleId: { in: rules.map((r) => r.id) } },
    select: { id: true, ruleId: true, instrumentId: true },
  });
  const activeKey = (ruleId: string, instrumentId: string) => `${ruleId}:${instrumentId}`;
  const activeMap = new Map(active.map((a) => [activeKey(a.ruleId, a.instrumentId), a.id]));

  let raised = 0;
  let cleared = 0;

  for (const rule of rules) {
    // A rule targets ONE instrument or a functional location. A location expands
    // through resolveLocationIds, so a rule on a Block covers its Areas — the same
    // expansion the dashboard and visibility scope use.
    let targetIds: string[] = [];
    if (rule.instrumentId) {
      targetIds = [rule.instrumentId];
    } else if (rule.functionalLocationId) {
      // Expanded through resolveLocationIds, so a rule on a BLOCK covers its Areas —
      // the same expansion the dashboard and the visibility scope use. An unknown id
      // resolves to [], which selects nothing rather than everything.
      const scope = resolveLocationIds(rule.functionalLocationId, nodes);
      const members = await prisma.instrument.findMany({
        where: { functionalLocationId: { in: scope } },
        select: { id: true },
      });
      targetIds = members.map((m) => m.id);
    }

    const shape: RuleShape = {
      id: rule.id,
      metric: rule.metric,
      comparison: rule.comparison,
      thresholdLow: rule.thresholdLow,
      thresholdHigh: rule.thresholdHigh,
      delaySeconds: rule.delaySeconds,
    };

    for (const instrumentId of targetIds) {
      const row = byInstrument.get(instrumentId);
      if (!row) continue;

      const value = rule.metric === 'TEMPERATURE'
        ? row.temperature?.value ?? null
        : rule.metric === 'HUMIDITY'
          ? row.humidity?.value ?? null
          : null;

      const sample: Sample = {
        value,
        offline: !row.reporting,
        breachingSince: null,
      };

      // Only pay for the history query when a delay is configured AND the condition
      // is currently met — otherwise it cannot change the outcome.
      if (rule.delaySeconds > 0 && rule.metric !== 'OFFLINE' && isBreaching(shape, sample)) {
        const keys = rule.metric === 'TEMPERATURE'
          ? (row.temperature?.key ? [row.temperature.key] : [])
          : (row.humidity?.key ? [row.humidity.key] : []);
        sample.breachingSince = await breachStartedAt(instrumentId, keys, shape, rule.delaySeconds * 3);
      }

      const existing = activeMap.get(activeKey(rule.id, instrumentId));
      const decision = decide(shape, sample, Boolean(existing), now);

      if (decision.action === 'raise') {
        await prisma.alarm.create({
          data: {
            ruleId: rule.id,
            // Frozen here, on purpose: editing or deleting the rule must not change
            // what this alarm says about itself.
            ruleSnapshot: {
              ...ruleSnapshot({ ...shape, name: rule.name, severity: rule.severity }),
              description: describeRule(shape),
              snapshotAt: now.toISOString(),
            },
            instrumentId,
            metric: rule.metric,
            triggeredValue: rule.metric === 'OFFLINE' ? null : value,
            severity: rule.severity,
            state: 'ACTIVE',
            raisedAt: now,
          },
        });
        raised += 1;
      } else if (decision.action === 'clear' && existing) {
        // Acknowledgement fields are untouched: a cleared-but-unacknowledged alarm is
        // the overnight excursion someone must still answer for in the morning.
        await prisma.alarm.update({
          where: { id: existing },
          data: { state: 'CLEARED', clearedAt: now },
        });
        cleared += 1;
      }
    }
  }

  return { rulesEvaluated: rules.length, raised, cleared };
}

/** graphile-worker task. Registered as `alarm_evaluation`. */
export const alarmEvaluationTask = async (_payload: unknown, helpers?: { logger?: { info: (m: string) => void } }) => {
  const res = await evaluateAlarms();
  if (res.raised || res.cleared) {
    helpers?.logger?.info(
      `[alarms] ${res.rulesEvaluated} rule(s): raised ${res.raised}, cleared ${res.cleared}`,
    );
  }
};
