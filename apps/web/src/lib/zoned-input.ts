/**
 * `datetime-local` inputs in the CONFIGURED timezone.
 *
 * A `datetime-local` input holds zoneless wall-clock text (`2026-10-12T05:30`).
 * The browser would read it in ITS OWN zone, while every printed time in this
 * app — the tables, the charts, the signed PDFs — is formatted in the
 * administered timezone (`useDatetimeFormat`, default `Asia/Kolkata`). On a
 * workstation whose clock is set to any other zone the period a person typed
 * and the period the report printed were hours apart (audit 2026-10-12,
 * finding 11), and the trend page put raw UTC text into its inputs on top of
 * that (finding 4).
 *
 * These two functions are the ONE conversion, used by every period picker that
 * feeds a report: an instant is shown as wall-clock text in `tz`, and text the
 * person typed is read as wall-clock time in `tz`.
 *
 * `tz` undefined = the browser's zone, which is exactly what the formatter does
 * with an undefined timezone, so a picker and the times printed beside it
 * always agree. An invalid zone falls back to UTC — again the formatter's own
 * rule (`formatDateValue`'s catch), for the same reason.
 */

const pad = (n: number) => String(n).padStart(2, '0');

function partsIn(ms: number, tz: string | undefined) {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch {
    // RangeError: an unknown zone. The formatter prints in UTC then; so do we.
    return partsIn(ms, 'UTC');
  }
  const out: Record<string, number> = {};
  for (const p of fmt.formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return {
    year: out.year, month: out.month, day: out.day,
    // Some engines print midnight as 24 even with h23.
    hour: out.hour === 24 ? 0 : out.hour, minute: out.minute, second: out.second,
  };
}

/** Wall-clock time of instant `ms` in `tz`, re-read as if it were UTC, minus `ms`. */
function offsetMs(ms: number, tz: string | undefined): number {
  const p = partsIn(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - (ms - (ms % 1000));
}

/** An instant (ISO, or anything `Date` parses) → `YYYY-MM-DDTHH:mm` in `tz`. '' when unreadable. */
export function isoToZonedInput(iso: string, tz: string | undefined): string {
  if (!iso) return '';
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return '';
  const p = partsIn(ms, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

const INPUT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** `YYYY-MM-DDTHH:mm` read as wall-clock time in `tz` → an ISO instant. undefined when unreadable. */
export function zonedInputToIso(value: string, tz: string | undefined): string | undefined {
  const m = INPUT_RE.exec(value ?? '');
  if (!m) return undefined;
  const [y, mo, d, h, mi, s] = m.slice(1).map((x) => (x === undefined ? 0 : Number(x)));
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  if (Number.isNaN(wall)) return undefined;
  // First guess with the offset at the wall time itself, then correct once with
  // the offset at the guess — the two differ only across a DST change.
  let ms = wall - offsetMs(wall, tz);
  const second = wall - offsetMs(ms, tz);
  if (second !== ms) ms = second;
  return new Date(ms).toISOString();
}
