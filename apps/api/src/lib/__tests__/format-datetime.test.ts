import { describe, it, expect } from 'vitest';
import { resolveDatetimeConfig } from '../format-datetime.js';

/**
 * Audit 2026-11-07, S10-20: the configured time zone had TWO readers. The screens
 * resolve the `datetime` row through `datetimeConfigSchema` (via
 * `configService.getConfig`), which accepts only 'Asia/Kolkata' and falls back to
 * the schema defaults on anything else; the server's formatter read the RAW row.
 * The seed wrote 'UTC', so after a fresh seed or an upgrade the screens printed IST
 * while alarm e-mails, SMS, webhook times and chart buckets used UTC. The server
 * must resolve the row exactly as the screens do.
 */
describe('resolveDatetimeConfig', () => {
  it('reads a stored UTC zone the way the screens do: the schema default, Asia/Kolkata', () => {
    expect(resolveDatetimeConfig({ dateFormat: 'DD/MM/YYYY', timeFormat: '24-hour', timezone: 'UTC' }).timezone)
      .toBe('Asia/Kolkata');
  });

  it('falls back to the schema defaults when nothing is stored (24-hour, not 12-hour)', () => {
    expect(resolveDatetimeConfig(undefined)).toEqual({
      dateFormat: 'DD/MM/YYYY', timeFormat: '24-hour', timezone: 'Asia/Kolkata',
    });
  });

  it('keeps a valid stored setting', () => {
    const stored = { dateFormat: 'YYYY-MM-DD', timeFormat: '12-hour', timezone: 'Asia/Kolkata' };
    expect(resolveDatetimeConfig(stored)).toEqual(stored);
  });
});
