/**
 * Alarm severity is NO LONGER ADMINISTERED (2026-09-01, operator).
 *
 * It was removed from every configuration and display surface: the four config
 * defs that let an admin pick it per alarm source, the Alarms page filter, the
 * dashboard selection panel's badge, the signed PDF's column, the alarm webhook
 * targets' severity match, and the `${severity}` placeholder in every
 * notification and webhook body.
 *
 * **The database column and the `AlarmSeverity` enum SURVIVE, deliberately.**
 * 148 alarms carried a real, meaningful severity when this was written — 105
 * MAJOR and 43 CRITICAL, counted against `compliance_core_db` on 2026-09-01;
 * `alarms.severity` is NOT NULL with no default, so this constant is what keeps
 * every insert legal. An alarm is a 21 CFR Part 11 record and is never
 * rewritten or dropped to tidy a schema — the same rule that let the alarm-RULES
 * removal drop `AlarmRule` (verified 0 rows) but would not have let it drop a
 * populated one. So `alarms.severity` stays NOT NULL and keeps its history, and
 * this constant is what every new alarm is stamped with.
 *
 * **One constant, in one place, on purpose.** A literal `'MAJOR'` scattered
 * through the evaluation worker's five raise paths is five independent chances
 * for the column to drift into meaning something again. Everything that writes
 * the column imports this.
 *
 * Why `MAJOR` and not `CRITICAL`: the value is inert — nothing reads it, filters
 * on it, counts it or displays it — so the only property that matters is that it
 * misrepresents the retained history as little as possible. MAJOR is the value
 * most of the retained rows already carry, so an external query run against the
 * table for its own reasons is not handed a growing pile of new CRITICALs that no
 * excursion actually justified.
 *
 * If severity is ever brought back as an administered concept, it must come back
 * as a real setting with a real reader — not by quietly editing this value,
 * which would relabel every alarm raised in between.
 */
export const ALARM_SEVERITY_FALLBACK = 'MAJOR';
