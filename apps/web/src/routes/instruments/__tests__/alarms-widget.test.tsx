import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

/**
 * The trend page's "Alarms in this period" widget.
 *
 * Two families of bug are guarded here.
 *
 * **Wording.** Every word on a row comes from `routes/alarms/alarm-display.ts`,
 * and the administered ones (`statusTexts`, the inactivity cells, the type
 * names) must be fed the SAME config the Alarms page reads — not the shipped
 * defaults. A test that only exercised the fallback would pass against exactly
 * that defect, so both cases are asserted for each.
 *
 * **The status pill's TONE.** It must be keyed off the alarm's four-state
 * quadrant. It was keyed off `severity` on the Alarms page until 2026-08-31 and
 * in this widget until 2026-09-01: on an installation where every alarm was
 * CRITICAL, a severity-keyed pill rendered red on every row and the one column
 * that separates an answered alarm from an unanswered one said nothing.
 * **Asserting the LABEL cannot catch it** — the label already comes from
 * `statusText()`, which is state-keyed, and reads correctly under both mappings.
 * These tests assert the tone CLASS.
 *
 * Severity was removed entirely on 2026-09-01 — the field is gone from `AlarmRow`
 * and the API no longer sends it, so that specific bug can no longer be written.
 * The assertions stay because what they actually pin is that the tone follows the
 * QUADRANT, which is still the property that matters and is still easy to break.
 */

const period = { from: '2026-08-01T00:00:00.000Z', to: '2026-08-24T00:00:00.000Z' };

const alarm = {
  id: 'a-1',
  instrumentCode: 'T-1',
  instrumentId: 'i-1',
  metric: 'TEMPERATURE',
  triggeredValue: 30,
  state: 'ACTIVE',
  raisedAt: '2026-08-10T00:00:00.000Z',
  clearedAt: null,
  acknowledgedAt: null,
  acknowledgedBy: null,
  acknowledgeReason: null,
  source: 'INSTRUMENT_LIMIT',
  limitKind: 'HIGH',
  clearedValue: null,
  ruleSnapshot: { limit: 25, decimals: 1 },
};

const inactivityAlarm = {
  ...alarm,
  id: 'a-2',
  metric: 'OFFLINE',
  triggeredValue: null,
  source: 'INACTIVITY',
  limitKind: null,
  state: 'CLEARED',
  clearedAt: '2026-08-11T00:00:00.000Z',
  ruleSnapshot: { kind: 'INACTIVITY', graceMinutes: 15 },
};

/**
 * The condition has ENDED and nobody has signed for it — the overnight excursion,
 * the row that must not look finished. The quadrant says `cleared-unack` →
 * `warn` (amber). Under the removed severity mapping this row was `danger`
 * (rose), which is the disagreement the fixture was built to expose.
 */
const clearedUnacked = {
  ...alarm,
  id: 'a-3',
  state: 'CLEARED',
  clearedAt: '2026-08-10T02:00:00.000Z',
  clearedValue: 22,
  acknowledgedAt: null,
};

/** Ended AND signed for. The quadrant says `cleared-ack` → `ok` (emerald);
 *  the removed severity mapping said `danger`. Disagreed the other way. */
const clearedAcked = {
  ...clearedUnacked,
  id: 'a-4',
  acknowledgedAt: '2026-08-10T03:00:00.000Z',
  acknowledgedBy: 'qa.lead',
  acknowledgeReason: 'Chiller door left open overnight; door closed and verified.',
};

let swrRows: unknown[] = [alarm];
vi.mock('swr', () => ({
  default: () => ({ data: { data: swrRows } }),
}));

vi.mock('@/hooks/use-datetime-format', () => ({
  useDatetimeFormat: () => ({
    formatDate: (v: string) => v,
    formatTime: () => '',
    // The Acknowledged-by cell reads this one. Absent from the mock it is
    // `undefined`, and every fixture with an `acknowledgedAt` throws.
    formatDateTime: (v: string) => v,
  }),
}));

const { AlarmsWidget } = await import('../alarms-widget');

/** Render with one row on the wire, restoring the default fixture afterwards so
 *  a failing assertion cannot leak a fixture into the next test. */
function renderWith(
  rows: unknown[],
  props: Partial<Parameters<typeof AlarmsWidget>[0]> = {},
) {
  swrRows = rows;
  try {
    return render(
      <AlarmsWidget
        instrumentId="i-1"
        period={period}
        onExportPdf={() => {}}
        statusTexts={undefined}
        inactivityTexts={undefined}
        {...props}
      />,
    );
  } finally {
    swrRows = [alarm];
  }
}

/**
 * The status pill for the single row on screen.
 *
 * Scoped to `<tbody>`, not `screen`: the stacked "Cleared Value" heading puts a
 * `<span>Cleared</span>` in the banner, so a document-wide `getByText('Cleared')`
 * matches the header as well as the pill and throws on the ambiguity rather than
 * failing the assertion it was written for.
 */
function pillIn(container: HTMLElement, label: string): HTMLElement {
  const body = container.querySelector('tbody');
  if (!body) throw new Error('no table body rendered');
  return within(body as HTMLElement).getByText(label);
}

describe('AlarmsWidget — configured status wording', () => {
  it('renders the shipped default while the config has not loaded (statusTexts undefined)', () => {
    renderWith([alarm]);
    expect(screen.getByText('Still pending Unacknowledged')).toBeInTheDocument();
  });

  it('renders the CONFIGURED wording when the config has loaded — not the default', () => {
    renderWith([alarm], {
      statusTexts: {
        activeUnack: 'Awaiting operator sign-off',
        activeAck: 'Active — Acknowledged',
        clearedUnack: 'Cleared — Unacknowledged',
        clearedAck: 'Cleared',
      },
    });
    expect(screen.getByText('Awaiting operator sign-off')).toBeInTheDocument();
    expect(screen.queryByText('Still pending Unacknowledged')).toBeNull();
  });
});

describe('AlarmsWidget — the status pill is keyed off STATUS', () => {
  it('paints an alarm that has cleared but is unacknowledged AMBER, not red', () => {
    const { container } = renderWith([clearedUnacked]);
    // The badge span: its text content is the label, and the dot is a sibling
    // with none, so this resolves to the element carrying the tone classes.
    const pill = pillIn(container, 'Cleared — Unacknowledged');
    expect(pill.className).toContain('var(--status-warn-bg)');
    // The bug, stated as an assertion: this row was CRITICAL, so the removed
    // severity-keyed pill was `danger` here. Any future mapping that reaches for
    // "how bad is it" over "has anyone answered" fails the same way.
    expect(pill.className).not.toContain('var(--status-danger-bg)');
  });

  it('paints a CRITICAL alarm that has cleared AND been acknowledged as settled, not red', () => {
    const { container } = renderWith([clearedAcked]);
    const pill = pillIn(container, 'Cleared');
    expect(pill.className).toContain('var(--status-ok-bg)');
    expect(pill.className).not.toContain('var(--status-danger-bg)');
  });

  it('still paints a live, unanswered alarm red', () => {
    const { container } = renderWith([alarm]);
    const pill = pillIn(container, 'Still pending Unacknowledged');
    expect(pill.className).toContain('var(--status-danger-bg)');
  });
});

describe('AlarmsWidget — the row carries the state marker', () => {
  it('marks a cleared-unacknowledged row amber on its leading cell', () => {
    // The marker lives on the Instrument ID cell on the Alarms page; this widget
    // drops that column, so it must ride on Type instead or the restyle loses
    // the one cue that finds an unanswered row without reading across.
    const { container } = renderWith([clearedUnacked]);
    expect(container.querySelector('td.relative span.bg-amber-500')).not.toBeNull();
  });

  it('marks a live, unanswered row red', () => {
    const { container } = renderWith([alarm]);
    expect(container.querySelector('td.relative span.bg-rose-500')).not.toBeNull();
  });
});

describe('AlarmsWidget — the banner follows the site theme', () => {
  it('paints the header band from --theme-primary, not a hardcoded colour', () => {
    const { container } = renderWith([alarm]);
    const head = container.querySelector('thead');
    // `getAttribute` rather than `.style.backgroundImage`: jsdom's CSS parser
    // does not understand `color-mix()` and drops the declaration from the
    // CSSOM, while the attribute React wrote survives intact.
    expect(head?.getAttribute('style') ?? '').toContain('var(--theme-primary');
  });
});

describe('AlarmsWidget — inactivity column wording', () => {
  it('renders the shipped wording while the config has not loaded', () => {
    renderWith([inactivityAlarm]);
    expect(screen.getByText('No data')).toBeInTheDocument();
    expect(screen.getByText('quiet > 15m')).toBeInTheDocument();
    expect(screen.getByText('Data resumed')).toBeInTheDocument();
  });

  it('renders the CONFIGURED wording when the config has loaded — not the default', () => {
    renderWith([inactivityAlarm], {
      inactivityTexts: { generatedValue: 'Silent', limit: 'no signal {minutes}m', clearedValue: 'Back online' },
    });
    expect(screen.getByText('Silent')).toBeInTheDocument();
    // The frozen grace still comes from the alarm, substituted into the wording.
    expect(screen.getByText('no signal 15m')).toBeInTheDocument();
    expect(screen.getByText('Back online')).toBeInTheDocument();
    expect(screen.queryByText('No data')).toBeNull();
  });
});

describe('AlarmsWidget — the type name is administered', () => {
  it('renders the shipped type name while the config has not loaded', () => {
    renderWith([alarm]);
    expect(screen.getByText('High Temperature')).toBeInTheDocument();
  });

  it('renders the CONFIGURED type name — the same rename the Alarms page shows', () => {
    renderWith([alarm], {
      inactivityTexts: { typeNames: { limitTemperatureHigh: 'Temp Over Spec' } },
    });
    expect(screen.getByText('Temp Over Spec')).toBeInTheDocument();
    expect(screen.queryByText('High Temperature')).toBeNull();
  });
});

describe('AlarmsWidget — the period is applied to the rows', () => {
  it('says so when the window holds no alarms, rather than showing an empty table', () => {
    renderWith([]);
    expect(screen.getByText('No alarms raised in this window.')).toBeInTheDocument();
  });

  it('excludes an alarm raised outside the window', () => {
    // Raised a year before `period.from`. The widget windows on `raisedAt` in
    // the browser; this pins that it still does.
    renderWith([{ ...alarm, raisedAt: '2025-08-10T00:00:00.000Z' }]);
    expect(screen.getByText('No alarms raised in this window.')).toBeInTheDocument();
    expect(screen.queryByText('Still pending Unacknowledged')).toBeNull();
  });
});

describe('AlarmsWidget — the acknowledgement column', () => {
  it('names the signer and when they signed', () => {
    renderWith([clearedAcked]);
    expect(screen.getByText('qa.lead')).toBeInTheDocument();
    expect(screen.getByText('2026-08-10T03:00:00.000Z')).toBeInTheDocument();
  });

  it('says an unanswered alarm is Awaiting, rather than leaving the cell blank', () => {
    renderWith([clearedUnacked]);
    expect(screen.getByText('Awaiting')).toBeInTheDocument();
  });
});

describe('AlarmsWidget — the export menu is untouched', () => {
  it('still offers the instrument-trend PDF export', () => {
    renderWith([alarm]);
    // By ACCESSIBLE NAME, which is what catches an icon button that lost its
    // name — the same rule `trend-downloads.test.tsx` follows.
    expect(screen.getByRole('button', { name: /export/i })).toBeInTheDocument();
  });
});
