/**
 * Timezone-safe conversions between stored ISO-8601 UTC instants and the naive
 * wall-clock strings that `<input type="date">` / `<input type="datetime-local">`
 * exchange.
 *
 * Those inputs carry NO zone: '2026-07-15T09:30' means "09:30 wherever the
 * reader stands". So slicing a stored UTC instant into one (`iso.slice(0, 16)`)
 * renders the UTC clock while the input claims it is local, and posting that
 * naive string back makes the server's `new Date(...)` re-read it as local —
 * a silent shift of the zone's offset (−5:30 in Asia/Kolkata) on a
 * 21 CFR §11 record. Both directions must convert.
 *
 * Every function takes an explicit `timeZone` (callers pass
 * `useDatetimeFormat().config.timezone`) so that (a) an input agrees with the
 * `formatDateTime()` label rendered beside it, and (b) a conversion never
 * depends on the host machine's zone.
 */

/**
 * A wall-clock string as produced by a date/datetime-local input: no trailing
 * `Z`, no `±hh:mm` offset. Anchored so it never matches an already-zoned ISO
 * string — that distinction is what lets the generic body-normalisers below
 * convert edited fields while leaving untouched ones alone.
 */
export const NAIVE_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
export const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

const pad = (n: number) => String(n).padStart(2, '0');

interface ZonedParts { year: number; month: number; day: number; hour: number; minute: number; second: number }

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p: Record<string, string> = {};
  for (const { type, value } of fmt.formatToParts(date)) p[type] = value;
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    // Some engines still render midnight as hour '24' — normalise defensively.
    hour: Number(p.hour) % 24, minute: Number(p.minute), second: Number(p.second),
  };
}

/** Offset (ms) to ADD to a UTC instant to get the zone's wall clock. */
function offsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Parts have no millisecond field, so compare against the whole second.
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Mirror use-datetime-format.ts: an unusable zone falls back to UTC, never throws. */
function safeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}

/**
 * Stored UTC instant → `YYYY-MM-DDTHH:mm` for a `datetime-local` input.
 * `'2026-07-15T09:30:00.000Z'` in Asia/Kolkata → `'2026-07-15T15:00'`.
 */
export function isoToDatetimeInput(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = zonedParts(d, safeZone(timeZone));
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** Stored UTC instant → `YYYY-MM-DD` for a `date` input, or a zone-local day key. */
export function isoToDateInput(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = zonedParts(d, safeZone(timeZone));
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/**
 * `YYYY-MM-DDTHH:mm` wall clock → ISO-8601 UTC instant.
 * `'2026-07-15T15:00'` in Asia/Kolkata → `'2026-07-15T09:30:00.000Z'`.
 *
 * The returned string carries an explicit `Z`, so a server parsing it with
 * `new Date(...)` lands on the intended instant whatever the server's own zone.
 */
export function datetimeInputToIso(wall: string | null | undefined, timeZone: string): string {
  if (!wall) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(wall);
  if (!m) return '';
  const zone = safeZone(timeZone);
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
  // Two passes: the offset in effect at the guessed instant can differ from the
  // one at the true instant across a DST boundary. Re-resolving with the offset
  // actually in force at the first result converges for every real zone.
  const first = guess - offsetMs(new Date(guess), zone);
  const ts = guess - offsetMs(new Date(first), zone);
  return new Date(ts).toISOString();
}

/**
 * First instant of the given zone-local day, as ISO UTC.
 * `'2026-07-15'` in Asia/Kolkata → `'2026-07-14T18:30:00.000Z'`.
 */
export function startOfDayIso(dateInput: string | null | undefined, timeZone: string): string {
  if (!dateInput || !DATE_ONLY_RE.test(dateInput)) return '';
  return datetimeInputToIso(`${dateInput}T00:00:00`, timeZone);
}

/**
 * Last instant of the given zone-local day, as ISO UTC — an INCLUSIVE upper
 * bound. `'2026-07-15'` in Asia/Kolkata → `'2026-07-15T18:29:59.999Z'`.
 * A date-only "to" filter means "through the end of that day"; bounding at the
 * day's 00:00 instead silently drops the rest of it.
 */
export function endOfDayIso(dateInput: string | null | undefined, timeZone: string): string {
  if (!dateInput || !DATE_ONLY_RE.test(dateInput)) return '';
  // One millisecond before the next day starts. The next day is found by
  // CALENDAR arithmetic on the label (not by adding 24h to the instant): a
  // DST day is 23 or 25 hours long, so a blind +24h can land back inside the
  // same local day and collapse the range.
  const [y, m, d] = dateInput.split('-').map(Number);
  const nextDay = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return new Date(new Date(startOfDayIso(nextDay, timeZone)).getTime() - 1).toISOString();
}

/**
 * Convert a value ONLY if it is a naive wall-clock datetime string, else return
 * it unchanged. Mirrors the value-based (not key-name) detection of
 * `useDatetimeFormat().formatIfDate`, so generic "loop over the edited fields"
 * request builders convert every datetime-local field without having to know
 * which keys are dates. Already-zoned ISO strings and empty values pass through.
 */
export function toIsoIfNaiveDatetime(value: unknown, timeZone: string): unknown {
  if (typeof value !== 'string' || !NAIVE_DATETIME_RE.test(value)) return value;
  return datetimeInputToIso(value, timeZone);
}
