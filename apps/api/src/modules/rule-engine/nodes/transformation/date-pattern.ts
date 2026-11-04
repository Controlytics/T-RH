/**
 * `%d{<pattern>}` in a To email subject / body — ThingsBoard master's
 * `TbMsgToEmailNode.processDatePatterns`: each `%d{…}` becomes NOW (one
 * instant for the whole email) in `java.text.SimpleDateFormat` syntax, in the
 * time zone the message metadata names in `emailTimezone` (else the server's).
 *
 * The letters supported are SimpleDateFormat's: G y M L d D E u a H k K h m s
 * S z Z X w W F, and quoted text ('T', '' for a quote). Any other letter is an
 * error, as SimpleDateFormat raises one ("Illegal pattern character").
 * The week fields follow Java's default locale (en_US): a week runs Sunday to
 * Saturday and week 1 is the one holding the 1st (minimal days 1) — so
 * 31 Dec 2025 is week 1 (of 2026) while `yyyy` still prints 2025, exactly as
 * Java prints it. `F` is the n-th such weekday of the month (days 1-7 = 1).
 * An `emailTimezone` that is not an IANA zone reads as UTC — Java's
 * `TimeZone.getTimeZone` falls back to GMT the same way. `z` prints the
 * zone's short name as the platform knows it (`UTC`, `GMT+5:30`), which can
 * differ from Java's (`IST`).
 */
const DATE_VAR = /%d\{([^}]*)\}/g;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

interface Fields {
  year: number; month: number; day: number; hour: number; minute: number; second: number; ms: number;
  weekday: number; offsetMinutes: number; zoneShort: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string | undefined, zoneName: 'longOffset' | 'short'): Intl.DateTimeFormat {
  const key = `${timeZone ?? ''}\u0000${zoneName}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
      hourCycle: 'h23', weekday: 'long', timeZoneName: zoneName,
    });
    if (formatters.size > 64) formatters.clear();
    formatters.set(key, f);
  }
  return f;
}

/** The IANA zone to print in: the metadata's when it is one, UTC when it is not, the server's when none is given. */
export function resolveTimeZone(name: string | undefined): string | undefined {
  if (!name) return undefined;
  try {
    formatterFor(name, 'longOffset');
    return name;
  } catch {
    return 'UTC';
  }
}

function fieldsOf(date: Date, timeZone: string | undefined): Fields {
  const parts: Record<string, string> = {};
  for (const p of formatterFor(timeZone, 'longOffset').formatToParts(date)) parts[p.type] = p.value;
  const short = formatterFor(timeZone, 'short').formatToParts(date).find((p) => p.type === 'timeZoneName')?.value ?? 'UTC';
  const off = /^GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/.exec(parts.timeZoneName ?? 'GMT');
  const offsetMinutes = off && off[1] ? (off[1] === '-' ? -1 : 1) * (Number(off[2]) * 60 + Number(off[3] ?? 0)) : 0;
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour) % 24, minute: Number(parts.minute), second: Number(parts.second), ms: date.getUTCMilliseconds(),
    weekday: DAYS.indexOf(parts.weekday ?? '') + 1, offsetMinutes, zoneShort: short,
  };
}

const pad = (n: number, width: number) => String(n).padStart(width, '0');

const DAY_MS = 86_400_000;
/** 0 = Sunday … 6 = Saturday, for a calendar date. */
const dowOf = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();
const dayOfYear = (f: Fields) => Math.round((Date.UTC(f.year, f.month - 1, f.day) - Date.UTC(f.year, 0, 1)) / DAY_MS) + 1;
const daysInYear = (y: number) => Math.round((Date.UTC(y + 1, 0, 1) - Date.UTC(y, 0, 1)) / DAY_MS);

/** Java `WEEK_OF_YEAR`, en_US (Sunday first, minimal days 1). */
function weekOfYear(f: Fields): number {
  const day = dayOfYear(f);
  // The Sunday-to-Saturday week holding this date also holds 1 January of the next year: week 1 of THAT year.
  if (day + (6 - dowOf(f.year, f.month, f.day)) > daysInYear(f.year)) return 1;
  return Math.floor((day - 1 + dowOf(f.year, 1, 1)) / 7) + 1;
}

/** Java `WEEK_OF_MONTH`, en_US: week 1 holds the 1st. */
const weekOfMonth = (f: Fields) => Math.floor((f.day - 1 + dowOf(f.year, f.month, 1)) / 7) + 1;

function offsetText(minutes: number, style: 'rfc' | 'X' | 'XX' | 'XXX'): string {
  if (minutes === 0 && style !== 'rfc') return 'Z';
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const hh = pad(Math.floor(abs / 60), 2);
  const mm = pad(abs % 60, 2);
  if (style === 'X') return `${sign}${hh}`;
  if (style === 'XXX') return `${sign}${hh}:${mm}`;
  return `${sign}${hh}${mm}`;
}

function field(letter: string, count: number, f: Fields): string {
  switch (letter) {
    case 'G': return 'AD';
    case 'y': return count === 2 ? pad(f.year % 100, 2) : pad(f.year, count);
    case 'M':
    case 'L':
      if (count >= 4) return MONTHS[f.month - 1];
      if (count === 3) return MONTHS[f.month - 1].slice(0, 3);
      return pad(f.month, count);
    case 'd': return pad(f.day, count);
    case 'D': return pad(dayOfYear(f), count);
    case 'w': return pad(weekOfYear(f), count);
    case 'W': return pad(weekOfMonth(f), count);
    case 'F': return pad(Math.floor((f.day - 1) / 7) + 1, count);
    case 'E': return count >= 4 ? DAYS[f.weekday - 1] : DAYS[f.weekday - 1].slice(0, 3);
    case 'u': return pad(f.weekday, count);
    case 'a': return f.hour < 12 ? 'AM' : 'PM';
    case 'H': return pad(f.hour, count);
    case 'k': return pad(f.hour === 0 ? 24 : f.hour, count);
    case 'K': return pad(f.hour % 12, count);
    case 'h': return pad(f.hour % 12 === 0 ? 12 : f.hour % 12, count);
    case 'm': return pad(f.minute, count);
    case 's': return pad(f.second, count);
    case 'S': return pad(f.ms, count);
    case 'z': return f.zoneShort;
    case 'Z': return offsetText(f.offsetMinutes, 'rfc');
    case 'X':
      if (count > 3) throw new Error('invalid ISO 8601 format: length=' + count);
      return offsetText(f.offsetMinutes, count === 1 ? 'X' : count === 2 ? 'XX' : 'XXX');
    default:
      throw new Error(`Illegal pattern character '${letter}'`);
  }
}

/** One SimpleDateFormat pattern, applied to `date` in `timeZone`. */
export function formatSimpleDate(pattern: string, date: Date, timeZone: string | undefined): string {
  const f = fieldsOf(date, timeZone);
  let out = '';
  for (let i = 0; i < pattern.length;) {
    const c = pattern[i];
    if (c === "'") {
      if (pattern[i + 1] === "'") { out += "'"; i += 2; continue; }
      // A quoted run may hold '' for a quote; find the closing quote that is not doubled.
      let j = i + 1;
      let text = '';
      for (;;) {
        if (j >= pattern.length) throw new Error('Unterminated quote');
        if (pattern[j] === "'") {
          if (pattern[j + 1] === "'") { text += "'"; j += 2; continue; }
          break;
        }
        text += pattern[j];
        j += 1;
      }
      out += text;
      i = j + 1;
      continue;
    }
    if (/[A-Za-z]/.test(c)) {
      let j = i;
      while (pattern[j] === c) j += 1;
      out += field(c, j - i, f);
      i = j;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Every `%d{…}` of `text`, at `now`, in `timeZone`. */
export function processDatePatterns(text: string, now: Date, timeZone: string | undefined): string {
  return text.replace(DATE_VAR, (_whole, pattern: string) => formatSimpleDate(pattern, now, timeZone));
}
