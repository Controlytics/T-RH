import { Prisma } from '@prisma/client';
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
import { enqueueAlarmNotification } from '../modules/alarms/enqueue-notification.js';
import { enqueueAlarmWebhook } from '../modules/alarm-webhooks/enqueue.js';
import {
  checkLimits,
  limitSnapshot,
  describeLimit,
  finiteOrNull,
  type LimitKind,
  type LimitMetric,
} from '../modules/alarms/limit-decide.js';
import { loadLimitConfig, limitsFor } from '../modules/alarms/load-limits.js';
import type { LimitBound } from '@digilog/shared';
import { logger } from '../lib/logger.js';

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

/**
 * Which config bound a (metric, kind) pair names.
 *
 * An exhaustive table rather than string concatenation: the result indexes
 * `attributeKeys`, and the value it finds is frozen onto the alarm's snapshot as
 * `attributeKey`. A composed key that misses yields `undefined`, which would silently
 * drop "which attribute did this fire against" from a regulated record rather than
 * failing. Adding a metric or a kind now breaks the build here, which is the point.
 */
const LIMIT_BOUND: Record<LimitMetric, Record<LimitKind, LimitBound>> = {
  TEMPERATURE: { HIGH: 'temperatureHigh', LOW: 'temperatureLow' },
  HUMIDITY: { HIGH: 'humidityHigh', LOW: 'humidityLow' },
};

/**
 * The display precision frozen onto an alarm when it was RAISED.
 *
 * The clear notification must quote its reading the same way the raise did — one
 * excursion, one precision. Reading it live instead would let an attribute edited
 * mid-excursion make the "returned to spec" message disagree with the "breached"
 * one about the same instrument. Null for alarms raised before the field existed;
 * the caller then falls back to the instrument's current setting.
 */
function snapshotDecimals(snapshot: unknown): number | null {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const d = (snapshot as Record<string, unknown>).decimals;
  return typeof d === 'number' && Number.isFinite(d) ? d : null;
}

export interface AlarmEvaluationResult {
  rulesEvaluated: number;
  raised: number;
  cleared: number;
  /**
   * How many instruments the instrument-limit pass examined. Without it, a run that
   * raised nothing is indistinguishable from a run where the pass never executed —
   * and with zero alarm rules configured, the limit pass IS the whole feature.
   * Zero when the pass is disabled by config.
   */
  instrumentsEvaluated: number;
}

export async function evaluateAlarms(now = new Date()): Promise<AlarmEvaluationResult> {
  const [rules, locations, overview] = await Promise.all([
    prisma.alarmRule.findMany({ where: { isActive: true } }),
    prisma.functionalLocation.findMany({ select: { id: true, name: true, type: true, parentId: true } }),
    buildTelemetryOverview({}),
  ]);
  // NO early return on rules.length === 0. Instrument-limit alarms have no rules at
  // all, so skipping here would disable the entire limit feature on exactly the sites
  // that rely on it — the rule loop over an empty array is already a no-op.
  const nodes = locations.map((l) => ({ ...l, type: l.type as FlType }));
  const byInstrument = new Map(overview.map((r) => [r.instrumentId, r]));

  // Which instruments already have an ACTIVE alarm for which rule. One query rather
  // than one per instrument: this runs every minute.
  const active = await prisma.alarm.findMany({
    // `source: 'RULE'` is not redundant with the ruleId filter — it states the intent at
    // the query, so a later widening of this where clause cannot silently pull
    // instrument-limit alarms into a Map keyed on ruleId.
    where: { state: 'ACTIVE', source: 'RULE', ruleId: { in: rules.map((r) => r.id) } },
    select: { id: true, ruleId: true, instrumentId: true },
  });
  const activeKey = (ruleId: string, instrumentId: string) => `${ruleId}:${instrumentId}`;
  // This worker only ever evaluates rule-based alarms (queried above by ruleId IN
  // rule ids), so ruleId is never null here in practice — but the column is now
  // nullable for instrument-limit alarms, so narrow explicitly rather than assert.
  const activeMap = new Map(
    active.filter((a): a is typeof a & { ruleId: string } => a.ruleId !== null)
      .map((a) => [activeKey(a.ruleId, a.instrumentId), a.id])
  );

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
        const created = await prisma.alarm.create({
          data: {
            ruleId: rule.id,
            // Frozen here, on purpose: editing or deleting the rule must not change
            // what this alarm says about itself.
            ruleSnapshot: {
              ...ruleSnapshot({ ...shape, name: rule.name, severity: rule.severity }),
              description: describeRule(shape),
              // The instrument's display precision AS IT WAS. Frozen for the same
              // reason the threshold is: an inspector reading "fired at 24.0"
              // must see the number the operator saw, and editing
              // `temp_decimals` today must not re-render a year-old excursion.
              decimals: rule.metric === 'HUMIDITY' ? row.decimals.humidity : row.decimals.temperature,
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
        // After the commit. Awaited, because this is a queue INSERT and not a delivery —
        // it costs a round trip, not an SMTP handshake. It cannot fail the pass either
        // way: enqueueAlarmNotification never throws, since the alarm is the regulated
        // record and the notification is a courtesy on top of it.
        await enqueueAlarmNotification('raised', {
          alarmId: created.id,
          instrumentId,
          instrumentCode: row.code,
          instrumentName: row.name,
          metric: rule.metric,
          severity: rule.severity,
          ruleName: rule.name,
          condition: describeRule(shape),
          triggeredValue: created.triggeredValue,
          decimals: rule.metric === 'HUMIDITY' ? row.decimals.humidity : row.decimals.temperature,
          raisedAt: created.raisedAt,
        });
        await enqueueAlarmWebhook('RAISED', {
          alarmId: created.id,
          instrumentId,
          instrumentCode: row.code,
          instrumentName: row.name,
          metric: rule.metric,
          severity: rule.severity,
          ruleName: rule.name,
          condition: describeRule(shape),
          triggeredValue: created.triggeredValue,
          decimals: rule.metric === 'HUMIDITY' ? row.decimals.humidity : row.decimals.temperature,
          raisedAt: created.raisedAt,
        });
      } else if (decision.action === 'clear' && existing) {
        // Acknowledgement fields are untouched: a cleared-but-unacknowledged alarm is
        // the overnight excursion someone must still answer for in the morning.
        const closed = await prisma.alarm.update({
          where: { id: existing },
          data: { state: 'CLEARED', clearedAt: now },
        });
        cleared += 1;
        await enqueueAlarmNotification('cleared', {
          alarmId: closed.id,
          instrumentId,
          instrumentCode: row.code,
          instrumentName: row.name,
          metric: closed.metric,
          severity: closed.severity,
          ruleName: rule.name,
          condition: describeRule(shape),
          triggeredValue: closed.triggeredValue,
          decimals: snapshotDecimals(closed.ruleSnapshot)
            ?? (closed.metric === 'HUMIDITY' ? row.decimals.humidity : row.decimals.temperature),
          raisedAt: closed.raisedAt,
          clearedAt: closed.clearedAt,
        });
        await enqueueAlarmWebhook('CLEARED', {
          alarmId: closed.id,
          instrumentId,
          instrumentCode: row.code,
          instrumentName: row.name,
          metric: closed.metric,
          severity: closed.severity,
          ruleName: rule.name,
          condition: describeRule(shape),
          triggeredValue: closed.triggeredValue,
          decimals: snapshotDecimals(closed.ruleSnapshot)
            ?? (closed.metric === 'HUMIDITY' ? row.decimals.humidity : row.decimals.temperature),
          raisedAt: closed.raisedAt,
          clearedAt: closed.clearedAt,
        });
      }
    }
  }

  // ─── Instrument-limit pass ────────────────────────────────────────────────
  //
  // Separate from the rule pass and additive to it: an instrument can hold a rule
  // alarm and a limit alarm at once, and neither clears the other. Identity here is
  // (instrument, metric, limitKind) rather than (rule, instrument), because these
  // alarms have no rule.
  let instrumentsEvaluated = 0;
  const limitCfg = await loadLimitConfig();
  if (limitCfg.enabled) {
    const attrRows = await prisma.instrumentAttribute.findMany({
      select: { instrumentId: true, key: true, value: true },
    });
    const attrsByInstrument = new Map<string, { key: string; value: string }[]>();
    for (const a of attrRows) {
      const list = attrsByInstrument.get(a.instrumentId) ?? [];
      list.push({ key: a.key, value: a.value });
      attrsByInstrument.set(a.instrumentId, list);
    }

    const openLimitAlarms = await prisma.alarm.findMany({
      where: { source: 'INSTRUMENT_LIMIT', state: 'ACTIVE' },
      select: { id: true, instrumentId: true, metric: true, limitKind: true },
    });
    const openKey = (instrumentId: string, metric: string, kind: string) =>
      `${instrumentId}:${metric}:${kind}`;
    const openMap = new Map(
      openLimitAlarms.map((a) => [openKey(a.instrumentId, a.metric, a.limitKind ?? ''), a.id]),
    );

    for (const row of overview) {
      // Counted BEFORE the attribute check: an estate with no limit attributes must
      // report the instruments it looked at, not 0 — 0 would be indistinguishable
      // from a pass that never ran.
      instrumentsEvaluated += 1;
      const attributes = attrsByInstrument.get(row.instrumentId) ?? [];
      if (attributes.length === 0) continue;

      const { limits, attributeKeys } = limitsFor(limitCfg.keys, attributes);
      const reading = {
        temperature: row.temperature?.value ?? null,
        humidity: row.humidity?.value ?? null,
      };

      for (const check of checkLimits(limits, reading)) {
        const key = openKey(row.instrumentId, check.metric, check.limitKind);
        const existingId = openMap.get(key);

        if (check.breaching && !existingId) {
          const bound = LIMIT_BOUND[check.metric][check.limitKind];
          const data: Prisma.AlarmUncheckedCreateInput = {
              ruleId: null,
              source: 'INSTRUMENT_LIMIT',
              limitKind: check.limitKind,
              // Frozen here: changing the attribute later must not change what
              // this alarm says about itself.
              // The cast is only structural: limitSnapshot returns
              // Record<string, unknown>, which Prisma's InputJsonValue union does not
              // accept directly. Every value it puts in the object is a JSON scalar.
              ruleSnapshot: limitSnapshot({
                metric: check.metric,
                limitKind: check.limitKind,
                limit: check.limit,
                attributeKey: attributeKeys[bound],
                decimals: check.metric === 'HUMIDITY'
                  ? row.decimals.humidity
                  : row.decimals.temperature,
                snapshotAt: now.toISOString(),
              }) as Prisma.InputJsonObject,
              instrumentId: row.instrumentId,
              metric: check.metric,
              triggeredValue: check.metric === 'TEMPERATURE' ? reading.temperature : reading.humidity,
              severity: limitCfg.severity,
              state: 'ACTIVE',
              raisedAt: now,
          };

          // The partial unique index `alarms_active_instrument_limit_unique` is the
          // real guard against two passes opening one excursion — `openMap` is read
          // once and cannot see a row another process inserts mid-pass. P2002 here
          // therefore means "somebody else already opened this one", which is a
          // success for the system and nothing for this pass to do.
          //
          // Caught rather than allowed to propagate ON PURPOSE: an uncaught throw
          // abandons every remaining instrument in the cycle, so the constraint would
          // trade one duplicate row for a minute of undetected excursions across the
          // whole estate — strictly worse than the problem it fixes.
          let created;
          try {
            created = await prisma.alarm.create({ data });
          } catch (e) {
            if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
              logger.warn(
                `[alarms] ${row.code ?? row.instrumentId} ${check.metric} ${check.limitKind}: ` +
                  'an ACTIVE limit alarm was opened concurrently; skipping the duplicate',
              );
              continue;
            }
            throw e;
          }
          raised += 1;
          await enqueueAlarmNotification('raised', {
            alarmId: created.id,
            instrumentId: row.instrumentId,
            instrumentCode: row.code,
            instrumentName: row.name,
            metric: check.metric,
            severity: limitCfg.severity,
            ruleName: `${check.metric} ${check.limitKind} limit`,
            condition: describeLimit(check),
            triggeredValue: created.triggeredValue,
            decimals: check.metric === 'HUMIDITY' ? row.decimals.humidity : row.decimals.temperature,
            raisedAt: created.raisedAt,
          });
          await enqueueAlarmWebhook('RAISED', {
            alarmId: created.id,
            instrumentId: row.instrumentId,
            instrumentCode: row.code,
            instrumentName: row.name,
            metric: check.metric,
            severity: limitCfg.severity,
            ruleName: `${check.metric} ${check.limitKind} limit`,
            condition: describeLimit(check),
            triggeredValue: created.triggeredValue,
            decimals: check.metric === 'HUMIDITY' ? row.decimals.humidity : row.decimals.temperature,
            raisedAt: created.raisedAt,
          });
        } else if (!check.breaching && existingId) {
          const raw = check.metric === 'TEMPERATURE' ? reading.temperature : reading.humidity;
          // `finiteOrNull` is the SAME function checkPair() uses on the raise path —
          // see its doc comment in limit-decide.ts for why the two guards must never
          // diverge. Without it, a NaN could sail past `value === null` below and get
          // written into `clearedValue`, a CLEARED row that renders as an em dash: the
          // exact false "excursion ended" the null-guard exists to prevent.
          const value = finiteOrNull(raw);
          // A MISSING reading holds the alarm open; it does not clear it.
          //
          // The asymmetry is deliberate and symmetrical in its reasoning: without data
          // you cannot prove a breach, so a null never RAISES — and equally you cannot
          // prove recovery, so a null must never CLEAR. checkLimits() reports
          // `breaching: false` for a null because that is right for the raise path;
          // acting on it here would write "returned to spec" into a regulated record
          // about an instrument that had merely gone quiet, with `cleared_value` NULL
          // as the only trace of the falsehood. A probe that dies mid-excursion leaves
          // the alarm ACTIVE, which is the truthful state.
          if (value === null) continue;
          // KNOWN LIMITATION, deliberately not fixed: clearing needs checkLimits() to
          // still produce a check for this bound, so renaming or deleting the limit
          // attribute — or inverting the high/low pair — strands an open alarm ACTIVE
          // for good. Auto-clearing on a config change would erase the evidence of an
          // excursion, which is worse than a stale row an operator can acknowledge.
          // Acknowledgement fields untouched: a cleared-but-unacknowledged alarm
          // is the overnight excursion someone must still answer for.
          const closed = await prisma.alarm.update({
            where: { id: existingId },
            data: { state: 'CLEARED', clearedAt: now, clearedValue: value },
          });
          cleared += 1;
          // Named off the FROZEN snapshot, not the live limit: if a limit change is
          // what put the reading back in spec, `describeLimit(check)` here would
          // describe the CURRENT bound, which never fired — the courtesy email would
          // name a threshold the alarm was never raised against. The alarm row itself
          // is already correct (limitSnapshot() froze `description` at raise time);
          // this only fixes what the notification says about it. Falls back to
          // `describeLimit(check)` only if the snapshot somehow has no description.
          const snapshotDescription = closed.ruleSnapshot
            && typeof closed.ruleSnapshot === 'object'
            && !Array.isArray(closed.ruleSnapshot)
            ? (closed.ruleSnapshot as Record<string, unknown>).description
            : undefined;
          const condition = typeof snapshotDescription === 'string' && snapshotDescription
            ? snapshotDescription
            : describeLimit(check);
          await enqueueAlarmNotification('cleared', {
            alarmId: closed.id,
            instrumentId: row.instrumentId,
            instrumentCode: row.code,
            instrumentName: row.name,
            metric: closed.metric,
            severity: closed.severity,
            ruleName: `${check.metric} ${check.limitKind} limit`,
            condition,
            triggeredValue: closed.triggeredValue,
            decimals: snapshotDecimals(closed.ruleSnapshot)
              ?? (check.metric === 'HUMIDITY' ? row.decimals.humidity : row.decimals.temperature),
            raisedAt: closed.raisedAt,
            clearedAt: closed.clearedAt,
          });
          await enqueueAlarmWebhook('CLEARED', {
            alarmId: closed.id,
            instrumentId: row.instrumentId,
            instrumentCode: row.code,
            instrumentName: row.name,
            metric: closed.metric,
            severity: closed.severity,
            ruleName: `${check.metric} ${check.limitKind} limit`,
            condition,
            triggeredValue: closed.triggeredValue,
            decimals: snapshotDecimals(closed.ruleSnapshot)
              ?? (check.metric === 'HUMIDITY' ? row.decimals.humidity : row.decimals.temperature),
            raisedAt: closed.raisedAt,
            clearedAt: closed.clearedAt,
          });
        }
      }
    }
  }

  return { rulesEvaluated: rules.length, raised, cleared, instrumentsEvaluated };
}

/** graphile-worker task. Registered as `alarm_evaluation`. */
export const alarmEvaluationTask = async (
  _payload: unknown,
  helpers?: { logger?: { info: (m: string) => void; debug?: (m: string) => void } },
) => {
  const res = await evaluateAlarms();
  const scope = `${res.rulesEvaluated} rule(s), ${res.instrumentsEvaluated} instrument(s)`;
  if (res.raised || res.cleared) {
    helpers?.logger?.info(`[alarms] ${scope}: raised ${res.raised}, cleared ${res.cleared}`);
  } else {
    // A quiet minute still has to be distinguishable from a pass that never ran —
    // with zero rules, `instrumentsEvaluated` is the only evidence the limit feature
    // is alive at all. At DEBUG so it does not put 1440 lines a day in the operator's
    // log; graphile-worker suppresses it unless GRAPHILE_LOGGER_DEBUG is set.
    helpers?.logger?.debug?.(`[alarms] ${scope}: nothing raised or cleared`);
  }
};
