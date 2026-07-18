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

export function useDatetimeFormat() {
  const { data } = useSWR<DatetimeConfig>('/api/config/datetime/current', {
    revalidateOnFocus: false,
    revalidateOnMount: true, dedupingInterval: 5000,
  });

  const config = data ?? defaultConfig;

  const formatDate = (value: string | Date): string => {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(value);
    if (isNaN(date.getTime())) return '';
    return formatDateValue(date, config.dateFormat, config.timezone);
  };

  const formatTime = (value: string | Date): string => {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(value);
    if (isNaN(date.getTime())) return '';
    return formatTimeValue(date, config.timeFormat, config.timezone);
  };

  const formatDateTime = (value: string | Date): string => {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(value);
    if (isNaN(date.getTime())) return '';
    return `${formatDateValue(date, config.dateFormat, config.timezone)} ${formatTimeValue(date, config.timeFormat, config.timezone)}`;
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
