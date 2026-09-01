import useSWR from 'swr';

interface DatetimeConfig {
  dateFormat: string;
  timeFormat: string;
  timezone: string;
}

const defaultConfig: DatetimeConfig = {
  dateFormat: 'DD/MM/YYYY',
  timeFormat: '24-hour',
  timezone: 'Asia/Kolkata',
};

function formatDateValue(date: Date, dateFormat: string, timezone: string): string {
  try {
    const opts: Intl.DateTimeFormatOptions = { timeZone: timezone };

    switch (dateFormat) {
      case 'DD/MM/YYYY':
        return date.toLocaleDateString('en-GB', { ...opts });
      case 'MM/DD/YYYY':
        return date.toLocaleDateString('en-US', { ...opts });
      case 'YYYY-MM-DD': {
        const y = date.toLocaleString('en-US', { year: 'numeric', timeZone: timezone });
        const m = date.toLocaleString('en-US', { month: '2-digit', timeZone: timezone });
        const d = date.toLocaleString('en-US', { day: '2-digit', timeZone: timezone });
        return `${y}-${m}-${d}`;
      }
      case 'DD-MMM-YYYY':
        return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', ...opts }).replace(/ /g, '-');
      case 'MMM DD, YYYY':
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', ...opts });
      default:
        return date.toLocaleDateString('en-GB', { ...opts });
    }
  } catch {
    // Fallback to UTC if timezone is invalid
    return formatDateValue(date, dateFormat, 'UTC');
  }
}

function formatTimeValue(date: Date, timeFormat: string, timezone: string): string {
  try {
    if (timeFormat === '12-hour') {
      return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: timezone });
    }
    return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timezone });
  } catch {
    // Fallback to UTC if timezone is invalid
    return formatTimeValue(date, timeFormat, 'UTC');
  }
}

/**
 * A per-surface override of the FORMAT — never of the timezone.
 *
 * Each field falls through to the site-wide setting when it is absent or blank,
 * which is what makes "this widget inherits" the do-nothing default: a surface
 * that passes `{}`, or nothing at all, formats exactly as every other date on the
 * page does.
 *
 * **There is deliberately no `timezone` here.** Two widgets on one screen naming
 * different instants for the same stored reading would be a false statement about
 * a §11 record, not a display choice. The zone always comes from
 * `/api/config/datetime/current`.
 */
export interface DatetimeFormatOverride {
  dateFormat?: string;
  timeFormat?: string;
}

/** Which format wins: the override if it names one, else the administered one. */
function pick(override: string | undefined, siteWide: string): string {
  return typeof override === 'string' && override.trim() ? override.trim() : siteWide;
}

/**
 * The formatters themselves, as a pure function of the administered config and
 * an optional override.
 *
 * Extracted from the hook so the inheritance rule can be tested without
 * rendering anything — the interesting cases (an absent override, a blank one, a
 * half-filled one) are all about which of two strings is chosen, and a render
 * test of that is far easier to write vacuously than to write correctly.
 *
 * The hook is the only other caller and does nothing but supply `config`; there
 * is ONE formatting implementation, which is the point. A second one anywhere
 * would drift from this the first time a format is added to `datetime.def.ts`.
 */
export function makeDatetimeFormatters(
  config: DatetimeConfig,
  override?: DatetimeFormatOverride,
) {
  const dateFormat = pick(override?.dateFormat, config.dateFormat);
  const timeFormat = pick(override?.timeFormat, config.timeFormat);
  const { timezone } = config;

  const formatDate = (value: string | Date): string => {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(value);
    if (isNaN(date.getTime())) return '';
    return formatDateValue(date, dateFormat, timezone);
  };

  const formatTime = (value: string | Date): string => {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(value);
    if (isNaN(date.getTime())) return '';
    return formatTimeValue(date, timeFormat, timezone);
  };

  const formatDateTime = (value: string | Date): string => {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(value);
    if (isNaN(date.getTime())) return '';
    return `${formatDateValue(date, dateFormat, timezone)} ${formatTimeValue(date, timeFormat, timezone)}`;
  };

  // Format a value ONLY if it is an ISO-8601 date/date-time STRING, else return
  // null so callers can fall back to their own rendering. Used to format the
  // date-like values that show up inside opaque JSON payloads (e.g. an audit
  // row's before/after `createdAt`/`updatedAt`) without needing to know the key
  // names. Value-based (not key-name) detection: a string starting with
  // YYYY-MM-DDThh:mm is unambiguously a datetime; YYYY-MM-DD (no time) is a date.
  const formatIfDate = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return formatDateTime(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return formatDate(value);
    return null;
  };

  return { formatDate, formatTime, formatDateTime, formatIfDate, config };
}

/**
 * The administered date/time formatters, optionally overridden for ONE surface.
 *
 * `override` is how the instrument trend page lets each widget carry its own
 * format: an omitted or blank field inherits, so a widget that has never been
 * configured renders exactly as it always did. SWR dedupes on the key, so the
 * several calls one page makes are still one request.
 */
export function useDatetimeFormat(override?: DatetimeFormatOverride) {
  const { data } = useSWR<DatetimeConfig>('/api/config/datetime/current', {
    revalidateOnFocus: false,
    revalidateOnMount: true, dedupingInterval: 5000,
  });

  return makeDatetimeFormatters(data ?? defaultConfig, override);
}
