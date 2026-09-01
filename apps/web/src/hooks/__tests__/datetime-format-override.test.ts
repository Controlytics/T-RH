import { describe, it, expect } from 'vitest';
import { makeDatetimeFormatters } from '../use-datetime-format';

/**
 * The per-widget date/time override, tested on the PURE formatter rather than
 * through a rendered widget.
 *
 * The rule under test is which of two strings is chosen, and a render test of
 * that is easy to write vacuously — it passes whether or not the override is
 * consulted, because both formats produce a plausible-looking date. Here the two
 * candidates are chosen to be unmistakable: the site is `MM/DD/YYYY` and the
 * override is `YYYY-MM-DD`, so a wrong answer cannot look like a right one.
 *
 * **The timezone is deliberately not overridable and there is no test asking for
 * one.** Two widgets naming different instants for the same stored reading would
 * be a false statement about a §11 record; the type has no `timezone` field, so
 * the guarantee is structural.
 */
const SITE = { dateFormat: 'MM/DD/YYYY', timeFormat: '12-hour', timezone: 'UTC' };

// 2026-03-04T13:05Z. Day and month differ, so DD/MM and MM/DD cannot be
// confused; the hour is past noon, so 12- and 24-hour cannot be either.
//
// `MM/DD/YYYY` renders through `toLocaleDateString('en-US')`, which does NOT
// zero-pad — "3/4/2026", not "03/04/2026". That is the existing behaviour of the
// site-wide formatter and is not changed by any of this; it is spelled out here
// because the obvious expectation is the wrong one.
const TS = '2026-03-04T13:05:00.000Z';

describe('makeDatetimeFormatters — per-widget override', () => {
  it('inherits the site-wide setting when NO override is given', () => {
    // The do-nothing default. Every widget nobody has configured is this case,
    // so a page untouched by this feature must format exactly as before.
    expect(makeDatetimeFormatters(SITE).formatDate(TS)).toBe('3/4/2026');
    expect(makeDatetimeFormatters(SITE).formatTime(TS)).toBe('01:05 PM');
  });

  it('inherits when the override is present but EMPTY', () => {
    // What the config actually stores for an unconfigured widget: the resolver
    // turns `inherit` into `''`, and `''` must reach the site-wide setting.
    const f = makeDatetimeFormatters(SITE, { dateFormat: '', timeFormat: '' });
    expect(f.formatDate(TS)).toBe('3/4/2026');
    expect(f.formatTime(TS)).toBe('01:05 PM');
  });

  it('inherits when the override is whitespace', () => {
    const f = makeDatetimeFormatters(SITE, { dateFormat: '   ', timeFormat: '\t' });
    expect(f.formatDate(TS)).toBe('3/4/2026');
    expect(f.formatTime(TS)).toBe('01:05 PM');
  });

  it('uses the override when one is set', () => {
    const f = makeDatetimeFormatters(SITE, { dateFormat: 'YYYY-MM-DD', timeFormat: '24-hour' });
    expect(f.formatDate(TS)).toBe('2026-03-04');
    expect(f.formatTime(TS)).toBe('13:05');
  });

  it('inherits PER FIELD — a date override does not drag the clock with it', () => {
    // The half-filled case, which is the one a per-field fallback gets wrong: an
    // override object with one field set must not blank the other.
    const f = makeDatetimeFormatters(SITE, { dateFormat: 'YYYY-MM-DD' });
    expect(f.formatDate(TS)).toBe('2026-03-04');
    expect(f.formatTime(TS)).toBe('01:05 PM');
  });

  it('NEVER overrides the timezone — the override cannot move the instant', () => {
    // Same stored instant, same zone, whatever the format says. This is the §11
    // guarantee: a format is a display choice, a zone is a claim about WHEN.
    const site = { ...SITE, timezone: 'Asia/Kolkata' };
    const plain = makeDatetimeFormatters(site);
    const overridden = makeDatetimeFormatters(site, { dateFormat: 'YYYY-MM-DD' });
    // 13:05 UTC is 18:35 in Kolkata on both.
    expect(plain.formatTime(TS)).toBe('06:35 PM');
    expect(overridden.formatTime(TS)).toBe('06:35 PM');
    // And the date is the Kolkata date, not the browser's.
    expect(overridden.formatDate(TS)).toBe('2026-03-04');
  });

  it('formatDateTime uses both resolved formats', () => {
    const f = makeDatetimeFormatters(SITE, { dateFormat: 'YYYY-MM-DD', timeFormat: '24-hour' });
    expect(f.formatDateTime(TS)).toBe('2026-03-04 13:05');
  });
});
