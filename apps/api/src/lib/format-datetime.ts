/**
 * Server-side date/time formatter that honours the admin "Date/Time Format"
 * config (system_config key `datetime`: dateFormat / timeFormat / timezone).
 *
 * Mirrors the frontend `useDatetimeFormat` hook so a value rendered in a
 * notification message (built server-side at emit time) matches what the UI
 * shows everywhere else. Default timezone is Asia/Kolkata (IST), NOT UTC.
 */
import { prisma } from './prisma.js';

interface DatetimeConfig {
  dateFormat: string;
  timeFormat: string;
  timezone: string;
}

// Matches datetime.def.ts defaults (stored config wins; this is only the
// fallback when the row is missing).
const DEFAULT_CONFIG: DatetimeConfig = {
  dateFormat: 'DD/MM/YYYY',
  timeFormat: '12-hour',
  timezone: 'Asia/Kolkata',
};

function formatDateValue(date: Date, dateFormat: string, timezone: string): string {
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
}

function formatTimeValue(date: Date, timeFormat: string, timezone: string): string {
  if (timeFormat === '12-hour') {
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: timezone });
  }
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timezone });
}

/** Read the stored datetime config (flat shape), falling back to defaults. */
export async function getDatetimeConfig(): Promise<DatetimeConfig> {
  try {
    const row = await prisma.systemConfig.findUnique({ where: { configKey: 'datetime' } });
    const v = (row?.configValue as Partial<DatetimeConfig> | null) ?? {};
    return {
      dateFormat: v.dateFormat || DEFAULT_CONFIG.dateFormat,
      timeFormat: v.timeFormat || DEFAULT_CONFIG.timeFormat,
      timezone: v.timezone || DEFAULT_CONFIG.timezone,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

/** "DD/MM/YYYY hh:mm AM" in the configured timezone (IST by default). */
export async function formatConfiguredDateTime(value: Date | string): Promise<string> {
  const date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) return '';
  const cfg = await getDatetimeConfig();
  try {
    return `${formatDateValue(date, cfg.dateFormat, cfg.timezone)} ${formatTimeValue(date, cfg.timeFormat, cfg.timezone)}`;
  } catch {
    // Invalid timezone string → fall back to UTC rather than throwing.
    return `${formatDateValue(date, cfg.dateFormat, 'UTC')} ${formatTimeValue(date, cfg.timeFormat, 'UTC')}`;
  }
}

/** Date only ("DD/MM/YYYY") in the configured timezone (IST by default). */
export async function formatConfiguredDate(value: Date | string): Promise<string> {
  const date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) return '';
  const cfg = await getDatetimeConfig();
  try {
    return formatDateValue(date, cfg.dateFormat, cfg.timezone);
  } catch {
    return formatDateValue(date, cfg.dateFormat, 'UTC');
  }
}
