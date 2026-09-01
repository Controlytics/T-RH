import { describe, it, expect } from 'vitest';
import {
  TREND_WIDGET_LABEL_DEFAULT, TREND_WIDGET_LABEL_KEYS, TREND_WIDGET_IDS,
  TREND_WIDGET_FIELDS, TREND_WIDGET_FORMAT_INHERIT,
  trendWidgetLabel, trendWidgetFormat, resolveTrendWidgetTexts, coerceTrendWidgetTexts,
} from './trend-widgets.js';

/**
 * The two rules this module exists to keep, and both are invisible on a rendered
 * page:
 *
 * 1. **A blank administered label falls back to the SHIPPED wording, never to an
 *    empty heading.** An admin who clears "Status" must not be able to leave a
 *    table column with no name — and the failure is a nameless column, which
 *    looks like a styling glitch rather than a configuration one.
 *
 * 2. **A blank, absent or UNRECOGNISED format inherits the site-wide setting.**
 *    The last of those three is the one worth having a test for:
 *    `useDatetimeFormat`'s own switch falls through to `en-GB` for a string it
 *    does not know, so a stale override would print DD/MM/YYYY on a site
 *    administered as MM/DD/YYYY — silently wrong, and wrong in a way that looks
 *    deliberate.
 */
describe('trend widget labels', () => {
  it('uses the administered wording when one is set', () => {
    expect(trendWidgetLabel({ alarmsStatusHeading: 'State' }, 'alarmsStatusHeading')).toBe('State');
  });

  it('falls back to the shipped wording for a blank, whitespace or absent value', () => {
    // The three ways a field arrives empty. All of them must name the column.
    for (const cfg of [{}, { alarmsStatusHeading: '' }, { alarmsStatusHeading: '   ' }]) {
      expect(trendWidgetLabel(cfg, 'alarmsStatusHeading'))
        .toBe(TREND_WIDGET_LABEL_DEFAULT.alarmsStatusHeading);
    }
    // A non-string is administered junk, not a heading.
    expect(trendWidgetLabel({ alarmsStatusHeading: 42 as unknown as string }, 'alarmsStatusHeading'))
      .toBe(TREND_WIDGET_LABEL_DEFAULT.alarmsStatusHeading);
  });

  it('never resolves ANY label to an empty string', () => {
    // The guarantee every consumer relies on, asserted across the whole set
    // rather than one key — a new label added without a default would slip past
    // a single-key test.
    const { labels } = resolveTrendWidgetTexts({});
    for (const key of TREND_WIDGET_LABEL_KEYS) {
      expect(labels[key], key).toBeTruthy();
      expect(labels[key], key).toBe(TREND_WIDGET_LABEL_DEFAULT[key]);
    }
  });

  it('trims a stored label — a trailing space is not part of a column name', () => {
    expect(trendWidgetLabel({ alarmsTypeHeading: '  Kind  ' }, 'alarmsTypeHeading')).toBe('Kind');
  });
});

describe('trend widget date/time formats', () => {
  it('an unset format inherits — the default state of every widget', () => {
    expect(trendWidgetFormat({}, 'alarms')).toEqual({ dateFormat: '', timeFormat: '' });
  });

  it('the inherit sentinel and a blank both mean inherit', () => {
    expect(trendWidgetFormat(
      { alarmsDateFormat: TREND_WIDGET_FORMAT_INHERIT, alarmsTimeFormat: '  ' },
      'alarms',
    )).toEqual({ dateFormat: '', timeFormat: '' });
  });

  it('carries a recognised override through', () => {
    expect(trendWidgetFormat(
      { tempCardDateFormat: 'YYYY-MM-DD', tempCardTimeFormat: '12-hour' },
      'tempCard',
    )).toEqual({ dateFormat: 'YYYY-MM-DD', timeFormat: '12-hour' });
  });

  it('an UNRECOGNISED format inherits rather than being passed on', () => {
    // The whole reason the vocabulary is checked here. Passed on, this reaches
    // `formatDateValue`, whose `default:` branch prints en-GB — so a typo would
    // silently render DD/MM/YYYY on a site set to MM/DD/YYYY.
    expect(trendWidgetFormat(
      { humidCardDateFormat: 'DD/MM/YY', humidCardTimeFormat: '36-hour' },
      'humidCard',
    )).toEqual({ dateFormat: '', timeFormat: '' });
  });

  it('resolves a format for every widget', () => {
    const { formats } = resolveTrendWidgetTexts({});
    for (const id of TREND_WIDGET_IDS) expect(formats[id], id).toEqual({ dateFormat: '', timeFormat: '' });
  });
});

describe('coerceTrendWidgetTexts', () => {
  /**
   * The guard for a response that is not the shape that was asked for — a stale
   * build, a proxy error page, a half-deployed server. Without it the trend page
   * throws on `labels.alarmsTitle` of `undefined` and white-screens over a column
   * heading, which on a monitoring screen is the worst possible trade.
   */
  it('gives the shipped wording for undefined, null and junk', () => {
    for (const payload of [undefined, null, {}, 'nonsense', 7, []]) {
      const { labels, formats } = coerceTrendWidgetTexts(payload);
      expect(labels.alarmsTitle).toBe(TREND_WIDGET_LABEL_DEFAULT.alarmsTitle);
      expect(formats.alarms).toEqual({ dateFormat: '', timeFormat: '' });
    }
  });

  it('keeps a well-formed payload intact', () => {
    const out = coerceTrendWidgetTexts({
      labels: { alarmsTitle: 'Events' },
      formats: { alarms: { dateFormat: 'YYYY-MM-DD', timeFormat: '' } },
    });
    expect(out.labels.alarmsTitle).toBe('Events');
    expect(out.formats.alarms.dateFormat).toBe('YYYY-MM-DD');
    // A key the payload omitted still gets its shipped wording.
    expect(out.labels.alarmsStatusHeading).toBe(TREND_WIDGET_LABEL_DEFAULT.alarmsStatusHeading);
  });

  it('rejects a blank that reached the browser anyway', () => {
    // The server resolves blanks, but this is the one guarantee the components
    // rely on and it must not depend on the server having done its job.
    const out = coerceTrendWidgetTexts({ labels: { alarmsStatusHeading: '' } });
    expect(out.labels.alarmsStatusHeading).toBe(TREND_WIDGET_LABEL_DEFAULT.alarmsStatusHeading);
  });
});

describe('TREND_WIDGET_FIELDS', () => {
  it('accounts for every label key exactly once', () => {
    // The dialog renders from this map and the config def is BUILT from it, so a
    // key missing here is a heading no surface can administer — and one listed
    // twice is a field that appears in two dialogs and fights itself.
    const listed = TREND_WIDGET_IDS.flatMap((id) => [...TREND_WIDGET_FIELDS[id].labelKeys]);
    expect([...listed].sort()).toEqual([...TREND_WIDGET_LABEL_KEYS].sort());
    expect(new Set(listed).size).toBe(listed.length);
  });
});
