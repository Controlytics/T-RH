/**
 * Inactivity alarms — raised when an instrument stops reporting, cleared when it
 * starts again.
 *
 * Lives in @digilog/shared because both sides need the same numbers: the API
 * decides and freezes them onto the alarm, the web app renders "quiet > 15m" in
 * the Limit column from that frozen snapshot. Two copies would drift, and the
 * drift would show as an alarm whose stated threshold contradicts the one that
 * fired it.
 *
 * **This is a THIRD alarm source, beside RULE and INSTRUMENT_LIMIT.** An
 * `AlarmRule` with `metric: 'OFFLINE'` can already do raise-on-offline, but it
 * needs somebody to author a rule per instrument or per location — and a rule
 * targeted at a functional location cannot reach an instrument that has not been
 * assigned to one, which is a normal state for a freshly commissioned device.
 * "Every instrument, automatically" is what this source is for.
 */

export interface InactivityAlarmConfig {
  /** Ships OFF. See INACTIVITY_ALARMS_DEFAULT. */
  enabled: boolean;
  /** Minutes an instrument must be quiet before an alarm is RAISED. */
  graceMinutes: number;
}

export const INACTIVITY_GRACE_MIN = 0;
export const INACTIVITY_GRACE_MAX = 10_080; // one week

export const INACTIVITY_ALARMS_DEFAULT: InactivityAlarmConfig = {
  /**
   * **OFF, unlike `alarm-limits` which ships ON.** Switching this on raises one
   * alarm for every instrument that is already quiet, and each raise also fires a
   * notification and every matching alarm webhook. On the installation this was
   * written for that was 101 instruments in a single tick — a plant-wide buzzer
   * gets a feature switched off for good. It is turned on deliberately, once the
   * estate is actually reporting.
   */
  enabled: false,
  /**
   * 15 minutes. The window that decides "offline" (`instrument-activity`
   * `activeWindowMinutes`) is 3 on this installation, and no instrument declares
   * an `expectedIntervalSec`, so a 30-second network blip crosses it. Raising on
   * that would write two permanent §11 rows per blip, each needing an
   * e-signature. The grace delays only RAISING — a returning instrument still
   * clears on the next pass.
   *
   * **The effective threshold is the LATER of this and `activeWindowMinutes`.**
   * The pass needs both "counts as offline" and "quiet for at least the grace",
   * so a grace shorter than the window changes nothing. Setting grace to 1 on an
   * installation with a 24-hour window does not raise after a minute.
   */
  graceMinutes: 15,
};

/** What the Alarms page's Type column calls one of these. */
export const INACTIVITY_TYPE_LABEL = 'Inactivity';

/**
 * The snapshot frozen onto an inactivity alarm when it is raised.
 *
 * `activeWindowMinutes` is here because it is administered LIVE — someone can
 * change what "offline" means tomorrow, and an inspector asking "why did this
 * fire at 14:03" must get the threshold as it stood, not as it stands. Same
 * reasoning as freezing a limit onto an instrument-limit alarm.
 */
export interface InactivitySnapshot {
  kind: 'INACTIVITY';
  graceMinutes: number;
  /** The `instrument-activity` window in force at raise time. */
  activeWindowMinutes: number;
  /** The instrument's own declared reporting interval, when it has one. */
  expectedIntervalSec: number | null;
  /** When it was last heard from. Null is impossible on a raise — see decideInactivity. */
  lastSeenAt: string | null;
  description: string;
  snapshotAt: string;
}

/** "quiet for more than 15 minutes" — one wording, server and browser. */
export function describeInactivity(graceMinutes: number): string {
  if (graceMinutes <= 0) return 'instrument stopped reporting';
  const m = Math.round(graceMinutes);
  return `no telemetry for more than ${m} minute${m === 1 ? '' : 's'}`;
}


/**
 * What the three VALUE columns say for an inactivity alarm, all three
 * administered in Config → Inactivity Alarms.
 *
 * These cells are empty on an inactivity row and cannot be anything else: the
 * alarm is raised by the ABSENCE of a reading (`triggeredValue` is null by
 * design — see the worker, where a number there "would be an invention") and it
 * clears because telemetry RETURNED, not because a reading came back inside a
 * bound (`clearedValue` is null for the same reason). A bare `—` in both reads
 * as a rendering fault on a §11 table, so the cells carry a word instead.
 *
 * **Read LIVE, not frozen onto the alarm** — the same treatment as the four
 * status wordings in `alarm-limits`. Re-wording a column re-phrases every row;
 * the THRESHOLD underneath the Limit column stays frozen on the alarm, which is
 * the part an inspector is entitled to see unchanged.
 */
export interface InactivityColumnTexts {
  /** The Generated Value cell. */
  generatedValue: string;
  /** The Limit cell. A TEMPLATE — see INACTIVITY_MINUTES_TOKEN. */
  limit: string;
  /** The Cleared Value cell. */
  clearedValue: string;
}

/**
 * The placeholder the Limit template MUST contain, replaced with the grace this
 * alarm was FROZEN against.
 *
 * It is required rather than optional on purpose. The other two cells are pure
 * wording with no number to lose, but the Limit cell states the threshold the
 * alarm actually fired against, and an admin must not be able to delete that by
 * typing over it — the same reasoning that makes a blank status text fall back
 * to the default instead of rendering an invisible status.
 */
export const INACTIVITY_MINUTES_TOKEN = '{minutes}';

export const INACTIVITY_TEXT_DEFAULT: InactivityColumnTexts = {
  /** Short on purpose: the Alarms table is twelve columns and width is the
   *  constraint that pushed the Acknowledge button off screen once already. */
  generatedValue: 'No data',
  limit: `quiet > ${INACTIVITY_MINUTES_TOKEN}m`,
  clearedValue: 'Data resumed',
};

/**
 * The Limit column's cell for an inactivity alarm: `quiet > 15m` by default.
 *
 * `graceMinutes` comes from the alarm's FROZEN snapshot, so lengthening the
 * grace today does not rewrite what a past outage says it breached.
 *
 * A template that does not contain {@link INACTIVITY_MINUTES_TOKEN} is REJECTED
 * in favour of the shipped default — honouring it would let an admin erase the
 * threshold from a regulated record by typing a fixed string into a config box.
 * Same shape as the blank-falls-back-to-default rule on the status wordings.
 */
export function inactivityLimitText(graceMinutes: number, template?: string): string {
  const minutes = String(Math.round(graceMinutes));
  const t = template?.trim();
  const usable = t && t.includes(INACTIVITY_MINUTES_TOKEN) ? t : INACTIVITY_TEXT_DEFAULT.limit;
  // `split/join`, not `replace`, so a template naming the token twice
  // ("quiet > {minutes}m ({minutes} min)") substitutes both.
  return usable.split(INACTIVITY_MINUTES_TOKEN).join(minutes);
}
