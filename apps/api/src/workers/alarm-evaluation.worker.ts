import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { buildTelemetryOverview } from '../modules/instruments/telemetry-overview.js';
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
import { loadLimitConfig, limitsFor, enabledBoundsFor } from '../modules/alarms/load-limits.js';
import { loadInactivityConfig } from '../modules/alarms/load-inactivity.js';
import { decideInactivity, quietMinutes } from '../modules/alarms/inactivity-decide.js';
import { loadActiveWindowMinutes } from '../modules/instruments/telemetry-overview.js';
import { loadRs485Config } from '../modules/alarms/load-rs485.js';
import { loadRangeConfig, rangeFor } from '../modules/alarms/load-range.js';
import { loadAlarmTypeNames } from '../modules/alarms/load-type-names.js';
import { decideRange } from '../modules/alarms/range-decide.js';
import { decideRs485 } from '../modules/alarms/rs485-decide.js';
import {
  ALARM_SEVERITY_FALLBACK,
  describeInactivity, type InactivitySnapshot,
  describeRs485, renderRawValue, RS485_TYPE_LABEL,
  type Rs485Metric, type Rs485Snapshot,
  describeRangeFault, formatDecimals, SENSOR_RANGE_TYPE_LABEL,
  alarmTypeKeyFor, alarmTypeName,
  type RangeMetric, type SensorRangeSnapshot,
} from '@digilog/shared';
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
  raised: number;
  cleared: number;
  /**
   * How many instruments the instrument-limit pass examined. Without it, a run that
   * raised nothing is indistinguishable from a run where the pass never executed —
   * and with zero alarm rules configured, the limit pass IS the whole feature.
   * Zero when the pass is disabled by config.
   */
  instrumentsEvaluated: number;
  /**
   * How many instruments the INACTIVITY pass examined. Separate from
   * `instrumentsEvaluated` for the same reason that number exists at all: the
   * two passes are independently switchable, and one number could not say
   * which of them ran.
   */
  inactivityEvaluated: number;
  /**
   * How many instrument/metric PAIRS the RS485 pass examined — two per
   * instrument, not one, because a failed temperature probe and a failed
   * humidity probe on one logger are independent faults holding independent
   * alarms. Separate from the other two counts for the same reason they are
   * separate from each other: all three passes are independently switchable.
   */
  rs485Evaluated: number;
  /**
   * How many instrument/metric pairs the SENSOR RANGE pass examined. Separate
   * from the other three for the same reason they are separate from each other:
   * every pass is independently switchable, and one number could not say which
   * of them ran.
   */
  rangeEvaluated: number;
}

export async function evaluateAlarms(now = new Date()): Promise<AlarmEvaluationResult> {
  // What each kind of alarm is CALLED. Read once per pass and stamped onto every
  // notification and webhook payload, from the SAME resolver the browser labels
  // the row with — so an email cannot call an alarm something the table does not.
  // Before this, a limit breach printed `TEMPERATURE HIGH limit` in an email while
  // the Alarms page beside it said `High Temperature`.
  const typeNames = await loadAlarmTypeNames();
  /** The administered name for an alarm, or a fallback for a rule alarm, which is
   *  named by its own rule. */
  const typeName = (source: string, metric: string, limitKind: string | null, fallback: string) => {
    const key = alarmTypeKeyFor(source, metric, limitKind);
    return key ? alarmTypeName(typeNames, key) : fallback;
  };

  // Alarm RULES were removed 2026-08-31 — see `modules/alarms/routes.ts` for
  // the note. Every remaining source derives from the instrument itself, so
  // this pass needs only the fleet overview.
  const overview = await buildTelemetryOverview({});

  let raised = 0;
  let cleared = 0;

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

      // Which of this instrument's four bounds are actually IN FORCE, from its own
      // `Enable_Temp_NMT` / `Enable_Temp_NLT` / `Enable_Humid_NMT` /
      // `Enable_Humid_NLT` attributes. Absent means enabled, so an instrument
      // carrying no flags behaves exactly as it did before these existed.
      const boundEnabled = enabledBoundsFor(limitCfg.enableKeys, attributes);

      for (const check of checkLimits(limits, reading)) {
        const key = openKey(row.instrumentId, check.metric, check.limitKind);
        const existingId = openMap.get(key);
        const bound = LIMIT_BOUND[check.metric][check.limitKind];

        // ── The bound is switched OFF ───────────────────────────────────────
        //
        // It cannot raise, whatever the reading does. That is the whole point:
        // an instrument here can carry `High Humidity Limit = 0` meaning "not
        // judged", and a 0 is a real bound to this system — 17 CRITICAL alarms
        // were open at 44-50 %RH against exactly that when this was written.
        //
        // And an alarm ALREADY open on it is CLEARED (operator, 2026-08-31).
        // This is a deliberate departure from the rule that a config change never
        // closes a regulated record — the rule that leaves a renamed attribute's
        // alarm stranded. The reasoning does not carry here: an alarm raised
        // against a bound nobody is enforcing asserts an ongoing excursion that is
        // not real, and it can NEVER clear on its own, because the reading it
        // waits for (humidity below 0) cannot occur. A permanently red row is a
        // worse record than an attributable close. `raisedAt` and
        // `triggeredValue` are untouched, so the history is closed, not erased.
        if (!boundEnabled[bound]) {
          if (!existingId) continue;
          const raw = check.metric === 'TEMPERATURE' ? reading.temperature : reading.humidity;
          const closed = await prisma.alarm.update({
            where: { id: existingId },
            // Acknowledgement untouched, as on every other clear path: an
            // excursion that ended without a signature is still owed an answer.
            data: { state: 'CLEARED', clearedAt: now, clearedValue: finiteOrNull(raw) },
          });
          cleared += 1;
          // Says WHY, rather than reusing the frozen "returned to spec" wording —
          // this alarm did not end because the condition ended.
          const condition = `${check.metric === 'TEMPERATURE' ? 'temperature' : 'humidity'} `
            + `${check.limitKind === 'HIGH' ? 'high' : 'low'} limit is no longer enforced for this instrument`;
          const payload = {
            alarmId: closed.id,
            instrumentId: row.instrumentId,
            instrumentCode: row.code,
            instrumentName: row.name,
            metric: closed.metric,
            ruleName: typeName('INSTRUMENT_LIMIT', check.metric, check.limitKind, `${check.metric} ${check.limitKind} limit`),
            condition,
            triggeredValue: closed.clearedValue,
            decimals: snapshotDecimals(closed.ruleSnapshot)
              ?? (check.metric === 'HUMIDITY' ? row.decimals.humidity : row.decimals.temperature),
            raisedAt: closed.raisedAt,
            clearedAt: closed.clearedAt,
          };
          await enqueueAlarmNotification('cleared', payload);
          await enqueueAlarmWebhook('CLEARED', payload);
          continue;
        }

        if (check.breaching && !existingId) {
          const data: Prisma.AlarmUncheckedCreateInput = {
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
                // BOTH of this metric's bounds, so the Alarm Report's High/Low
                // Set Point columns can name the pair. Gated by `boundEnabled`
                // for the same reason the dashboard withholds a switched-off
                // bound: it could not have raised this alarm, so printing it
                // would state a limit that was not in force.
                thresholdHigh: boundEnabled[LIMIT_BOUND[check.metric].HIGH]
                  ? limits[LIMIT_BOUND[check.metric].HIGH]
                  : null,
                thresholdLow: boundEnabled[LIMIT_BOUND[check.metric].LOW]
                  ? limits[LIMIT_BOUND[check.metric].LOW]
                  : null,
                // Frozen so the report can word a SWITCHED-OFF bound differently
                // from one nobody ever administered — both of which are null above.
                highEnabled: boundEnabled[LIMIT_BOUND[check.metric].HIGH],
                lowEnabled: boundEnabled[LIMIT_BOUND[check.metric].LOW],
                snapshotAt: now.toISOString(),
              }) as Prisma.InputJsonObject,
              instrumentId: row.instrumentId,
              metric: check.metric,
              triggeredValue: check.metric === 'TEMPERATURE' ? reading.temperature : reading.humidity,
              severity: ALARM_SEVERITY_FALLBACK,
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
            ruleName: typeName('INSTRUMENT_LIMIT', check.metric, check.limitKind, `${check.metric} ${check.limitKind} limit`),
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
            ruleName: typeName('INSTRUMENT_LIMIT', check.metric, check.limitKind, `${check.metric} ${check.limitKind} limit`),
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
            ruleName: typeName('INSTRUMENT_LIMIT', check.metric, check.limitKind, `${check.metric} ${check.limitKind} limit`),
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
            ruleName: typeName('INSTRUMENT_LIMIT', check.metric, check.limitKind, `${check.metric} ${check.limitKind} limit`),
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

  // ─── Inactivity pass ──────────────────────────────────────────────────────
  //
  // Additive to the other two, the way the limit pass is additive to the rule
  // pass: an instrument can hold a limit alarm and an inactivity alarm at once,
  // and neither clears the other. A probe that was breaching when it went quiet
  // SHOULD hold both — the excursion is unresolved AND the record now has a hole
  // in it, and those are two different facts.
  //
  // Identity is the INSTRUMENT alone. There is no metric or bound to key on: an
  // instrument is either reporting or it is not.
  let inactivityEvaluated = 0;
  const inactivityCfg = await loadInactivityConfig();
  if (inactivityCfg.enabled) {
    const [activeWindowMinutes, seen, openInactivity] = await Promise.all([
      loadActiveWindowMinutes(),
      // `reporting` is NOT recomputed from these — that comes from the overview,
      // which carries the ONE definition. These two are for the GRACE period and
      // for the frozen snapshot, neither of which the overview holds.
      prisma.instrument.findMany({ select: { id: true, lastSeenAt: true, expectedIntervalSec: true } }),
      prisma.alarm.findMany({
        where: { source: 'INACTIVITY', state: 'ACTIVE' },
        // `ruleSnapshot` so the clear can MERGE onto the frozen raise fields
        // rather than overwrite them — see the clear branch below.
        select: { id: true, instrumentId: true, ruleSnapshot: true },
      }),
    ]);
    const seenById = new Map(seen.map((i) => [i.id, i]));
    const openById = new Map(openInactivity.map((a) => [a.instrumentId, a]));

    for (const row of overview) {
      inactivityEvaluated += 1;
      const inst = seenById.get(row.instrumentId);
      const open = openById.get(row.instrumentId);

      const action = decideInactivity(
        {
          reporting: row.reporting,
          lastSeenAt: inst?.lastSeenAt ?? null,
          isActive: row.isActive,
          hasOpenAlarm: Boolean(open),
        },
        inactivityCfg.graceMinutes,
        now,
      );

      if (action === 'raise') {
        const condition = describeInactivity(inactivityCfg.graceMinutes);
        const snapshot: InactivitySnapshot = {
          kind: 'INACTIVITY',
          graceMinutes: inactivityCfg.graceMinutes,
          // FROZEN because it is administered live: someone can change what
          // "offline" means tomorrow, and an inspector asking why this fired must
          // get the threshold as it stood, not as it stands.
          activeWindowMinutes,
          expectedIntervalSec: inst?.expectedIntervalSec ?? null,
          lastSeenAt: inst?.lastSeenAt?.toISOString() ?? null,
          description: condition,
          snapshotAt: now.toISOString(),
        };

        // Same guard and the same reasoning as the limit pass: the partial unique
        // index is what actually stops two overlapping cycles opening one outage,
        // and a P2002 here means somebody else opened it — a success for the
        // system. Caught rather than thrown, because an uncaught throw abandons
        // every remaining instrument in the cycle.
        let created;
        try {
          created = await prisma.alarm.create({
            data: {
              source: 'INACTIVITY',
              limitKind: null,
              // OFFLINE already means "not reporting". Reusing it keeps the Alarms
              // page's type filter matching these alongside any rule-based offline
              // alarm, which is what an operator means when they pick it.
              metric: 'OFFLINE',
              // No reading. This alarm is raised by the ABSENCE of one, so a
              // number here would be an invention.
              triggeredValue: null,
              ruleSnapshot: snapshot as unknown as Prisma.InputJsonObject,
              instrumentId: row.instrumentId,
              severity: ALARM_SEVERITY_FALLBACK,
              state: 'ACTIVE',
              raisedAt: now,
            },
          });
        } catch (e) {
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
            logger.warn(
              `[alarms] ${row.code ?? row.instrumentId}: an ACTIVE inactivity alarm was opened concurrently; skipping the duplicate`,
            );
            continue;
          }
          throw e;
        }
        raised += 1;

        const quiet = quietMinutes(inst?.lastSeenAt ?? null, now);
        const payload = {
          alarmId: created.id,
          instrumentId: row.instrumentId,
          instrumentCode: row.code,
          instrumentName: row.name,
          metric: 'OFFLINE',
          ruleName: typeName('INACTIVITY', 'OFFLINE', null, 'Inactivity'),
          condition: quiet === null ? condition : `${condition} (silent for ${quiet} minutes)`,
          triggeredValue: null,
          decimals: row.decimals.temperature,
          raisedAt: created.raisedAt,
        };
        await enqueueAlarmNotification('raised', payload);
        await enqueueAlarmWebhook('RAISED', payload);
      } else if (action === 'clear' && open) {
        /**
         * THE READING THAT ENDED THE OUTAGE.
         *
         * This alarm is raised by the ABSENCE of a reading, so the arrival of one
         * is the clear signal — and until 2026-09-01 that arrival was reported as
         * an administered word ("Data resumed") with no number behind it, because
         * nothing wrote `clearedValue`. The operator asked for the value instead:
         * a wording says the instrument came back, the number says what it came
         * back reading.
         *
         * Temperature first, humidity second — the order the dashboard resolves a
         * slot in, so the Cleared Value column and the tile agree about which
         * quantity a bare number belongs to. NULL when the pass cleared on
         * presence alone with no numeric slot yet; `clearedText()` falls back to
         * the wording for exactly that case, which is why the wording stays in
         * the config rather than being deleted with this change.
         *
         * The slot, its key and its precision are frozen alongside it. A Float in
         * a column shared by five alarm sources is unattributable on its own, and
         * a §11 record must not need today's alias configuration re-read to say
         * what its own number meant.
         */
        const resumeSlot = row.temperature ? 'temperature' as const
          : row.humidity ? 'humidity' as const
            : null;
        const resume = resumeSlot === 'temperature' ? row.temperature
          : resumeSlot === 'humidity' ? row.humidity
            : null;

        // Merged onto the snapshot, never replacing it: everything already there
        // describes why this alarm was RAISED and must survive untouched.
        const clearSnapshot = open.ruleSnapshot
          && typeof open.ruleSnapshot === 'object'
          && !Array.isArray(open.ruleSnapshot)
          ? { ...(open.ruleSnapshot as Record<string, unknown>) }
          : {};
        if (resume && resumeSlot) {
          clearSnapshot.clearedSlot = resumeSlot;
          clearSnapshot.clearedKey = resume.key;
          clearSnapshot.clearedDecimals = row.decimals[resumeSlot];
        }

        // Acknowledgement fields untouched: an outage that ended without a
        // signature is still owed an answer.
        const closed = await prisma.alarm.update({
          where: { id: open.id },
          data: {
            state: 'CLEARED',
            clearedAt: now,
            clearedValue: resume ? resume.value : null,
            ruleSnapshot: clearSnapshot as unknown as Prisma.InputJsonObject,
          },
        });
        cleared += 1;

        // From the FROZEN snapshot, not the live config. If someone lengthened the
        // grace while the instrument was down, naming the CURRENT grace here would
        // describe a threshold this alarm was never raised against.
        const snapshotDescription = closed.ruleSnapshot
          && typeof closed.ruleSnapshot === 'object'
          && !Array.isArray(closed.ruleSnapshot)
          ? (closed.ruleSnapshot as Record<string, unknown>).description
          : undefined;
        const payload = {
          alarmId: closed.id,
          instrumentId: row.instrumentId,
          instrumentCode: row.code,
          instrumentName: row.name,
          metric: closed.metric,
          ruleName: typeName('INACTIVITY', 'OFFLINE', null, 'Inactivity'),
          condition: typeof snapshotDescription === 'string' && snapshotDescription
            ? snapshotDescription
            : describeInactivity(inactivityCfg.graceMinutes),
          // The reading that ended the outage, so the message and the row agree.
          // Still null when nothing numeric arrived — `${value}` must not print a
          // number the record does not hold.
          triggeredValue: closed.clearedValue,
          decimals: resumeSlot ? row.decimals[resumeSlot] : row.decimals.temperature,
          raisedAt: closed.raisedAt,
          clearedAt: closed.clearedAt,
        };
        await enqueueAlarmNotification('cleared', payload);
        await enqueueAlarmWebhook('CLEARED', payload);
      }
    }
  }

  // ─── RS485 sensor-failure pass ────────────────────────────────────────────
  //
  // Additive to the other three, and the ONLY one that can see this fault. When
  // an RS485 probe or its bus fails, the logger keeps talking and sends `NA`
  // where the reading should be, so:
  //   - the inactivity pass sees a REPORTING instrument — `last_seen_at` was
  //     stamped by the very payload carrying the bad value;
  //   - the limit pass sees `null`, because a non-numeric reading is discarded
  //     before any comparison, and a null is deliberately not a breach;
  //   - the dashboard renders an empty cell, indistinguishable from an
  //     instrument that has never reported.
  // Before this pass existed a dead probe looked exactly like a healthy plant
  // with a gap in it, and nothing in the system said otherwise.
  //
  // Identity is the INSTRUMENT AND THE METRIC, unlike the inactivity pass. Two
  // probes on one logger fail independently and must be able to hold two open
  // alarms at once — which is what `alarms_active_rs485_unique` is keyed on.
  let rs485Evaluated = 0;
  const rs485Cfg = await loadRs485Config();
  if (rs485Cfg.enabled) {
    const openRs485 = await prisma.alarm.findMany({
      where: { state: 'ACTIVE', source: 'RS485_FAILURE' },
      select: { id: true, instrumentId: true, metric: true },
    });
    // Keyed by instrument AND metric. A map on instrumentId alone would let an
    // open temperature failure hide a humidity one, and the second fault would
    // never be recorded.
    const openByKey = new Map(openRs485.map((a) => [`${a.instrumentId}:${a.metric}`, a]));
    const METRICS: Rs485Metric[] = ['TEMPERATURE', 'HUMIDITY'];

    for (const row of overview) {
      for (const metric of METRICS) {
        rs485Evaluated += 1;
        // The slot as the OVERVIEW resolved it, value and all. Deliberately not
        // re-resolved here: the alias mapping is administered, it has drifted on
        // this installation before, and an alarm naming a different key than the
        // dashboard shows would be unanswerable.
        const slot = metric === 'TEMPERATURE' ? row.rawSlots.temperature : row.rawSlots.humidity;
        const open = openByKey.get(`${row.instrumentId}:${metric}`);

        const action = decideRs485({
          // `undefined` means the instrument sent nothing on any alias for this
          // slot — silence, which is the INACTIVITY source's question, not this
          // one's. A value that actually arrived is judged, whatever it is.
          value: slot ? slot.value : undefined,
          isActive: row.isActive,
          hasOpenAlarm: Boolean(open),
        });

        if (action === 'raise' && slot) {
          const rawValue = renderRawValue(slot.value);
          const condition = describeRs485(metric, rawValue);
          const snapshot: Rs485Snapshot = {
            kind: 'RS485',
            metric,
            key: slot.key,
            // The evidence, and the reason the Generated Value column shows the
            // offending text rather than an administered wording.
            rawValue,
            valueType: slot.valueType,
            readingAt: slot.ts,
            decimals: metric === 'TEMPERATURE' ? row.decimals.temperature : row.decimals.humidity,
            description: condition,
            snapshotAt: now.toISOString(),
          };

          // Same guard and the same reasoning as the other two passes: the
          // partial unique index is what actually stops two overlapping cycles
          // opening one fault, and a P2002 means somebody else opened it — a
          // success for the system. Caught rather than thrown, because an
          // uncaught throw abandons every remaining instrument in the cycle.
          let created;
          try {
            created = await prisma.alarm.create({
              data: {
                source: 'RS485_FAILURE',
                limitKind: null,
                metric,
                // No reading. The value that tripped this alarm is, by
                // definition, not a number; it is on the snapshot instead.
                triggeredValue: null,
                ruleSnapshot: snapshot as unknown as Prisma.InputJsonObject,
                instrumentId: row.instrumentId,
                severity: ALARM_SEVERITY_FALLBACK,
                state: 'ACTIVE',
                raisedAt: now,
              },
            });
          } catch (e) {
            if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
              logger.warn(
                `[alarms] ${row.code ?? row.instrumentId}: an ACTIVE RS485 ${metric} alarm was opened concurrently; skipping the duplicate`,
              );
              continue;
            }
            throw e;
          }
          raised += 1;

          const payload = {
            alarmId: created.id,
            instrumentId: row.instrumentId,
            instrumentCode: row.code,
            instrumentName: row.name,
            metric,
            ruleName: typeName('RS485_FAILURE', metric, null, RS485_TYPE_LABEL[metric]),
            condition,
            // Null for the same reason the column is — there is no number.
            triggeredValue: null,
            // ...so the value FIELD prints the operator's configured word instead
            // of '—'. The raw reading is still named in `condition`, which every
            // template prints beside it.
            valueText: rs485Cfg.failureText,
            decimals: metric === 'TEMPERATURE' ? row.decimals.temperature : row.decimals.humidity,
            raisedAt: created.raisedAt,
          };
          await enqueueAlarmNotification('raised', payload);
          await enqueueAlarmWebhook('RAISED', payload);
        } else if (action === 'clear' && open) {
          // The reading that cleared this IS a number — unlike an inactivity
          // alarm, which clears on the mere return of telemetry. Recording it
          // makes the Cleared Value column a real measurement.
          //
          // `slot` is non-null whenever `decideRs485` says 'clear', because that
          // answer requires a numeric value to have been read. The conditional is
          // a type guard, NOT a second opinion: making it part of the `else if`
          // would have this branch silently skip whenever the two disagreed, and
          // a silent skip cannot be tested — it makes an e2e for the clear rule
          // pass even when the rule is inverted, which is exactly how it was
          // found.
          const clearedValue = slot ? finiteOrNull(slot.value) : null;
          const closed = await prisma.alarm.update({
            where: { id: open.id },
            // Acknowledgement fields untouched: a fault that ended without a
            // signature is still owed an answer.
            data: { state: 'CLEARED', clearedAt: now, clearedValue },
          });
          cleared += 1;

          // From the FROZEN snapshot, never rebuilt from today's reading: the
          // condition must describe what was wrong, not what is now right.
          const snapshotDescription = closed.ruleSnapshot
            && typeof closed.ruleSnapshot === 'object'
            && !Array.isArray(closed.ruleSnapshot)
            ? (closed.ruleSnapshot as Record<string, unknown>).description
            : undefined;
          const payload = {
            alarmId: closed.id,
            instrumentId: row.instrumentId,
            instrumentCode: row.code,
            instrumentName: row.name,
            metric: closed.metric,
            ruleName: typeName('RS485_FAILURE', metric, null, RS485_TYPE_LABEL[metric]),
            condition: typeof snapshotDescription === 'string' && snapshotDescription
              ? snapshotDescription
              : `${metric === 'TEMPERATURE' ? 'temperature' : 'humidity'} sensor failure`,
            triggeredValue: clearedValue,
            decimals: metric === 'TEMPERATURE' ? row.decimals.temperature : row.decimals.humidity,
            raisedAt: closed.raisedAt,
            clearedAt: closed.clearedAt,
          };
          await enqueueAlarmNotification('cleared', payload);
          await enqueueAlarmWebhook('CLEARED', payload);
        }
      }
    }
  }

  // ─── Sensor RANGE pass ────────────────────────────────────────────────────
  //
  // A reading outside what the probe can physically measure — above
  // `High Temperature Range` or below `Low Temperature Range`. NOT a limit
  // breach: the limits (25 / 0 here) are the product SPEC, the range (50 / -40)
  // is the hardware's span, and a number beyond it is not a measurement at all.
  //
  // **The overview has already withheld those readings** — `rangeError` is set
  // and the numeric slot is null — so by the time the limit pass above ran, an
  // out-of-range value could neither raise a spec alarm nor clear one. That
  // suppression is the operator's decision (2026-08-31) and it lives in
  // `telemetry-overview.ts`, at the single point where a stored value becomes
  // "a reading"; this pass only records the fault.
  //
  // Identity is the INSTRUMENT AND THE METRIC, like the RS485 pass: two probes
  // on one logger saturate independently.
  let rangeEvaluated = 0;
  const rangeCfg = await loadRangeConfig();
  if (rangeCfg.enabled) {
    const openRange = await prisma.alarm.findMany({
      where: { state: 'ACTIVE', source: 'SENSOR_RANGE' },
      select: { id: true, instrumentId: true, metric: true },
    });
    const openByKey = new Map(openRange.map((a) => [`${a.instrumentId}:${a.metric}`, a]));
    const METRICS: RangeMetric[] = ['TEMPERATURE', 'HUMIDITY'];
    // Attributes for the frozen snapshot's key names. The overview resolved the
    // same bounds from the same rows; this re-reads only to name the KEYS, which
    // it does not carry.
    const attrRows = await prisma.instrumentAttribute.findMany({ select: { instrumentId: true, key: true, value: true } });
    const attrsByInstrument = new Map<string, { key: string; value: string }[]>();
    for (const a of attrRows) {
      const list = attrsByInstrument.get(a.instrumentId);
      if (list) list.push({ key: a.key, value: a.value });
      else attrsByInstrument.set(a.instrumentId, [{ key: a.key, value: a.value }]);
    }

    for (const row of overview) {
      for (const metric of METRICS) {
        rangeEvaluated += 1;
        const isTemp = metric === 'TEMPERATURE';
        const raw = isTemp ? row.rawSlots.temperature : row.rawSlots.humidity;
        const outOfRange = isTemp ? row.rangeError.temperature : row.rangeError.humidity;
        // A usable reading is a NUMBER that arrived. A non-numeric value is the
        // RS485 source's fault, and treating it as "no reading" here is what
        // stops one broken probe raising two different alarms.
        const hasReading = raw !== null && typeof raw.value === 'number' && Number.isFinite(raw.value);
        const open = openByKey.get(`${row.instrumentId}:${metric}`);

        const action = decideRange({
          outOfRange,
          hasReading,
          isActive: row.isActive,
          hasOpenAlarm: Boolean(open),
        });

        const decimals = isTemp ? row.decimals.temperature : row.decimals.humidity;
        const low = isTemp ? row.rangeBounds.temperatureLow : row.rangeBounds.humidityLow;
        const high = isTemp ? row.rangeBounds.temperatureHigh : row.rangeBounds.humidityHigh;

        if (action === 'raise' && raw && typeof raw.value === 'number') {
          const shown = formatDecimals(raw.value, decimals) ?? String(raw.value);
          const condition = describeRangeFault(metric, shown, low, high);
          const { attributeKeys } = rangeFor(rangeCfg.keys, attrsByInstrument.get(row.instrumentId) ?? []);
          const snapshot: SensorRangeSnapshot = {
            kind: 'SENSOR_RANGE',
            metric,
            key: raw.key,
            reading: raw.value,
            // FROZEN: editing the range attribute tomorrow must not rewrite what
            // this fault says it exceeded.
            rangeLow: low,
            rangeHigh: high,
            lowKey: isTemp ? attributeKeys.temperatureLow : attributeKeys.humidityLow,
            highKey: isTemp ? attributeKeys.temperatureHigh : attributeKeys.humidityHigh,
            decimals,
            description: condition,
            snapshotAt: now.toISOString(),
          };

          let created;
          try {
            created = await prisma.alarm.create({
              data: {
                source: 'SENSOR_RANGE',
                limitKind: null,
                metric,
                // The reading IS a number, so it is recorded here as well as on
                // the snapshot — unlike an RS485 failure, which has none.
                triggeredValue: raw.value,
                ruleSnapshot: snapshot as unknown as Prisma.InputJsonObject,
                instrumentId: row.instrumentId,
                severity: ALARM_SEVERITY_FALLBACK,
                state: 'ACTIVE',
                raisedAt: now,
              },
            });
          } catch (e) {
            if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
              logger.warn(
                `[alarms] ${row.code ?? row.instrumentId}: an ACTIVE range ${metric} alarm was opened concurrently; skipping the duplicate`,
              );
              continue;
            }
            throw e;
          }
          raised += 1;

          const payload = {
            alarmId: created.id,
            instrumentId: row.instrumentId,
            instrumentCode: row.code,
            instrumentName: row.name,
            metric,
            ruleName: typeName('SENSOR_RANGE', metric, null, SENSOR_RANGE_TYPE_LABEL[metric]),
            condition,
            triggeredValue: raw.value,
            // The value FIELD shows the operator's word, not the unusable
            // number. The condition beside it still quotes the reading and the
            // span, so nothing is hidden.
            valueText: rangeCfg.rangeText,
            decimals,
            raisedAt: created.raisedAt,
          };
          await enqueueAlarmNotification('raised', payload);
          await enqueueAlarmWebhook('RAISED', payload);
        } else if (action === 'clear' && open) {
          // An in-range number arrived. `raw` is non-null whenever decideRange
          // says 'clear' — the conditional below is a type guard, not a second
          // opinion (see the same note on the RS485 pass).
          const clearedValue = raw && typeof raw.value === 'number' ? raw.value : null;
          const closed = await prisma.alarm.update({
            where: { id: open.id },
            data: { state: 'CLEARED', clearedAt: now, clearedValue },
          });
          cleared += 1;

          const snapshotDescription = closed.ruleSnapshot
            && typeof closed.ruleSnapshot === 'object'
            && !Array.isArray(closed.ruleSnapshot)
            ? (closed.ruleSnapshot as Record<string, unknown>).description
            : undefined;
          const payload = {
            alarmId: closed.id,
            instrumentId: row.instrumentId,
            instrumentCode: row.code,
            instrumentName: row.name,
            metric: closed.metric,
            ruleName: typeName('SENSOR_RANGE', metric, null, SENSOR_RANGE_TYPE_LABEL[metric]),
            condition: typeof snapshotDescription === 'string' && snapshotDescription
              ? snapshotDescription
              : `${metric === 'TEMPERATURE' ? 'temperature' : 'humidity'} outside the sensor range`,
            triggeredValue: clearedValue,
            decimals,
            raisedAt: closed.raisedAt,
            clearedAt: closed.clearedAt,
          };
          await enqueueAlarmNotification('cleared', payload);
          await enqueueAlarmWebhook('CLEARED', payload);
        }
      }
    }
  }

  return { raised, cleared, instrumentsEvaluated, inactivityEvaluated, rs485Evaluated, rangeEvaluated };
}

/** graphile-worker task. Registered as `alarm_evaluation`. */
export const alarmEvaluationTask = async (
  _payload: unknown,
  helpers?: { logger?: { info: (m: string) => void; debug?: (m: string) => void } },
) => {
  const res = await evaluateAlarms();
  const scope = `${res.instrumentsEvaluated} instrument(s)`;
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
