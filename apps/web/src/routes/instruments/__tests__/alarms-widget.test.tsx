import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { resolveTrendWidgetTexts } from '@digilog/shared';

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
let canAcknowledge = true;
vi.mock('@/hooks/use-can', () => ({ useCan: () => () => canAcknowledge }));
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }),
}));

/**
 * Every URL requested this render. The period, the page and the page size are all
 * SERVER-side now, so the REQUEST is where those behaviours are observable.
 *
 * All of them, not just the last: `usePaginationDefaults` fetches through SWR too,
 * and it runs after the widget's own call, so a single `let` holds the config
 * URL and every assertion below reads `null`.
 */
const swrKeys: string[] = [];
/** The LATEST alarms request, not the first: the array accumulates across
 *  re-renders, so `find` would read the query from before a filter was typed. */
const alarmsKey = () => [...swrKeys].reverse().find((k) => k.startsWith('/api/alarms'));
vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (key) swrKeys.push(key);
    return { data: { data: swrRows, total: swrRows.length } };
  },
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
  swrKeys.length = 0;
  try {
    return render(
      <AlarmsWidget
        instrumentId="i-1"
        period={period}
        onExportPdf={() => {}}
        statusTexts={undefined}
        inactivityTexts={undefined}
        // The ADMINISTERED headings, from the shared resolver rather than
        // literals — a test that types its own defaults stops testing them.
        labels={resolveTrendWidgetTexts({}).labels}
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
  it('paints the header band from the theme band token, not a hardcoded colour', () => {
    const { container } = renderWith([alarm]);
    const head = container.querySelector('thead');
    // `getAttribute` rather than `.style.backgroundImage`: jsdom's CSS parser
    // does not understand `color-mix()` and drops the declaration from the
    // CSSOM, while the attribute React wrote survives intact.
    // UI v3 (2026-09-21): `--band-gradient`, itself derived from the theme's
    // gradient variables — still the site theme, and no hex anywhere.
    const style = head?.getAttribute('style') ?? '';
    expect(style).toContain('var(--band-gradient)');
    expect(style).not.toContain('#');
  });
});

describe('AlarmsWidget — inactivity column wording', () => {
  it('renders the shipped wording while the config has not loaded', () => {
    renderWith([inactivityAlarm]);
    expect(screen.getByText('No data')).toBeInTheDocument();
    expect(screen.getByText('Data resumed')).toBeInTheDocument();
    // The Limit cell no longer carries the inactivity threshold (operator,
    // 2026-09-01): that column shows the INSTRUMENT's bound for every type, and
    // an OFFLINE alarm names no metric, so it reads a dash. The wording itself
    // is not gone — it still renders in the signed PDF, which has no Condition
    // column and would otherwise lose the threshold entirely.
    expect(screen.queryByText('quiet > 15m')).toBeNull();
  });

  it('renders the CONFIGURED wording when the config has loaded — not the default', () => {
    renderWith([inactivityAlarm], {
      inactivityTexts: { generatedValue: 'Silent', limit: 'no signal {minutes}m', clearedValue: 'Back online' },
    });
    expect(screen.getByText('Silent')).toBeInTheDocument();
    // Configured or not, the Limit cell is the instrument's bound — see above.
    // The assertion that the configured wording APPEARS was removed with it: the
    // substitution of the frozen grace into that template is still exercised, in
    // `alarm-display.test.ts` and on the PDF path, which is where it now renders.
    expect(screen.queryByText('no signal 15m')).toBeNull();
    expect(screen.getByText('Back online')).toBeInTheDocument();
    expect(screen.queryByText('No data')).toBeNull();
  });
});

describe('AlarmsWidget — the type name is administered', () => {
  /**
   * Scoped to the TABLE since 2026-09-01, when a type filter joined the header.
   * The administered name now appears twice on this widget — in the Type column
   * and as an <option> in that filter — so an unscoped `getByText` throws on
   * "multiple elements". Asserting the CELL is also the stricter claim: the two
   * must agree, and only one of them is the record.
   */
  const inTable = () => screen.getByRole('table');

  it('renders the shipped type name while the config has not loaded', () => {
    renderWith([alarm]);
    expect(within(inTable()).getByText('High Temperature')).toBeInTheDocument();
  });

  it('renders the CONFIGURED type name — the same rename the Alarms page shows', () => {
    renderWith([alarm], {
      inactivityTexts: { typeNames: { limitTemperatureHigh: 'Temp Over Spec' } },
    });
    expect(within(inTable()).getByText('Temp Over Spec')).toBeInTheDocument();
    expect(screen.queryByText('High Temperature')).toBeNull();
  });
});

describe('AlarmsWidget — the period is applied by the SERVER', () => {
  it('says so when the window holds no alarms, rather than showing an empty table', () => {
    renderWith([]);
    expect(screen.getByText('No alarms raised in this window.')).toBeInTheDocument();
  });

  /**
   * This widget used to fetch `limit=500` and drop out-of-window rows with an
   * `Array.filter`, and the test here asserted that filter by feeding it a row a
   * year outside the period. That is exactly the shape the Alarms page was rebuilt
   * on 2026-08-31 to remove — a `limit` and a range meeting in one query — so on
   * an instrument with more than 500 alarms the "period" was really its newest
   * 500. It also made paging impossible: the server would page 500-row windows and
   * the browser would thin each one.
   *
   * The window moved to the server on 2026-09-01, so the assertion moved with it.
   * Feeding a row outside the period no longer proves anything — the mock returns
   * whatever it is given, and a real server would not have returned that row. What
   * IS provable, and what actually protects the behaviour, is that the range is
   * SENT.
   */
  it('sends the period as from/to rather than filtering in the browser', () => {
    renderWith([alarm]);
    const url = new URL(alarmsKey()!, 'https://x');
    expect(url.searchParams.get('from')).toBe(period.from);
    expect(url.searchParams.get('to')).toBe(period.to);
    expect(url.searchParams.get('instrumentId')).toBe('i-1');
  });

  it('does NOT send the old 500-row limit', () => {
    // The cap this replaced. Its return would silently reinstate the truncation.
    renderWith([alarm]);
    expect(new URL(alarmsKey()!, 'https://x').searchParams.get('limit')).toBeNull();
  });
});

describe('AlarmsWidget — pagination', () => {
  it('asks the server for a page, not for everything', () => {
    renderWith([alarm]);
    const q = new URL(alarmsKey()!, 'https://x').searchParams;
    expect(q.get('page')).toBe('1');
    expect(Number(q.get('pageSize'))).toBeGreaterThan(0);
  });

  it('shows the pager, counting the SERVER total', () => {
    renderWith([alarm]);
    // "Showing 1–1 of 1" — the numbers come from `total`, not from the rows in
    // hand, which are one page.
    expect(screen.getByText(/Showing/)).toBeInTheDocument();
    expect(screen.getByText('Rows:')).toBeInTheDocument();
  });

  it('renders no pager at all when the window is empty', () => {
    // "Showing 0–0 of 0" under a "No alarms raised in this window." line is two
    // ways of saying nothing, one of them noisier.
    renderWith([]);
    expect(screen.queryByText(/Showing/)).toBeNull();
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

/**
 * Acknowledging from the widget is the SAME §11 signature as from the Alarms
 * page. It was deliberately absent when this widget shipped — it had no gate, no
 * re-auth dialog and no revalidation, and a button that renders but cannot
 * complete a signature invites an operator to try and fail. These pin the four
 * things that had to arrive with it.
 */
describe('AlarmsWidget — acknowledging', () => {
  it('offers Acknowledge on an alarm that still needs answering for', () => {
    canAcknowledge = true;
    renderWith([{ ...alarm, state: 'ACTIVE', acknowledgedAt: null }]);
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeInTheDocument();
  });

  it('does NOT offer it on an alarm already signed for', () => {
    // Cleared AND acknowledged: nothing is owed, so the button would be an
    // invitation to sign twice for one event.
    canAcknowledge = true;
    renderWith([{
      ...alarm, state: 'CLEARED', clearedAt: '2026-08-13T05:00:00Z',
      acknowledgedAt: '2026-08-13T06:00:00Z', acknowledgedBy: 'aoperator',
    }]);
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).toBeNull();
  });

  it('HIDES it from a role without the permission', () => {
    // The gate, asserted rather than assumed. Mocking `useCan` to a constant
    // `true` would leave the one control between an operator and a signature
    // untested on this surface.
    canAcknowledge = false;
    renderWith([{ ...alarm, state: 'ACTIVE', acknowledgedAt: null }]);
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).toBeNull();
    canAcknowledge = true;
  });

  it('opens the re-authentication dialog rather than signing on one click', () => {
    // A §11 signature needs the password and a reason. A button that acknowledged
    // directly would be a signature nobody authenticated.
    canAcknowledge = true;
    renderWith([{ ...alarm, state: 'ACTIVE', acknowledgedAt: null }]);
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    // Asserted on the dialog's own heading and its two required inputs rather
    // than on `role="dialog"`, which this component does not set. Both inputs
    // matter: a reason without a password is not a signature, and a password
    // without a reason is a signature with no stated meaning.
    expect(screen.getByRole('heading', { name: 'Acknowledge Alarm' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Reason/)).toBeInTheDocument();
  });
});

/**
 * Administered wording (2026-09-01).
 *
 * The title and all nine headings come from `system_config['trend-widgets']`
 * through `resolveTrendWidgetTexts`, and the widget must not carry a literal of
 * its own for any of them. Two failures are pinned here, and both look like
 * styling on a rendered page: a rename that never reaches the table, and a blank
 * that leaves a column with no name.
 */
describe('AlarmsWidget — administered wording', () => {
  const shipped = resolveTrendWidgetTexts({}).labels;

  it('prints the shipped wording when nothing is administered', () => {
    renderWith([alarm]);
    expect(screen.getByText(shipped.alarmsTitle)).toBeInTheDocument();
    const head = document.querySelector('thead')!;
    for (const key of ['alarmsTypeHeading', 'alarmsRaisedHeading', 'alarmsLimitHeading',
      'alarmsStatusHeading', 'alarmsDurationHeading'] as const) {
      expect(within(head).getByText(shipped[key]), key).toBeInTheDocument();
    }
  });

  it('a RENAMED heading actually reaches the table', () => {
    // The rename has to arrive in the DOM, not merely be accepted by the config
    // page. Renaming five at once, including a stacked one, so a wiring that
    // reached only the easy single-word headings fails.
    const labels = resolveTrendWidgetTexts({
      alarmsTitle: 'Events in this period',
      alarmsTypeHeading: 'Kind',
      alarmsStatusHeading: 'State',
      alarmsDurationHeading: 'Open for',
      alarmsAcknowledgedByHeading: 'Signed by',
    }).labels;
    renderWith([alarm], { labels });

    expect(screen.getByText('Events in this period')).toBeInTheDocument();
    const head = document.querySelector('thead')!;
    expect(within(head).getByText('Kind')).toBeInTheDocument();
    expect(within(head).getByText('State')).toBeInTheDocument();
    // The shipped words are GONE, not merely joined by the new ones — a widget
    // that rendered both would satisfy a presence-only assertion.
    expect(within(head).queryByText('Type')).toBeNull();
    expect(within(head).queryByText('Status')).toBeNull();
  });

  it('a multi-word heading stacks one word per line, as the shipped ones do', () => {
    // `Th` is `whitespace-nowrap`, so an unstacked two-word heading is the widest
    // cell in the table and drags its column out with it. The three shipped
    // multi-word headings were hand-stacked for that reason; a renamed one must
    // be stacked too, or the rename silently widens the table.
    const labels = resolveTrendWidgetTexts({ alarmsStatusHeading: 'Current State' }).labels;
    renderWith([alarm], { labels });
    const head = document.querySelector('thead')!;
    // Two separate block spans, not one text node.
    expect(within(head).getByText('Current')).toBeInTheDocument();
    expect(within(head).getByText('State')).toBeInTheDocument();
    expect(within(head).queryByText('Current State')).toBeNull();
  });

  it('a BLANK heading falls back to the shipped wording, never an empty column', () => {
    // The resolver is what guarantees this, and the widget is asserted against it
    // rather than trusted to have called it.
    const labels = resolveTrendWidgetTexts({ alarmsStatusHeading: '   ', alarmsTitle: '' }).labels;
    renderWith([alarm], { labels });
    expect(screen.getByText(shipped.alarmsTitle)).toBeInTheDocument();
    expect(within(document.querySelector('thead')!).getByText(shipped.alarmsStatusHeading))
      .toBeInTheDocument();
  });

  it('KEEPS the unit legends and the duration tooltip through a rename', () => {
    // They explain the CELLS, not the column's name. A rename that dropped them
    // would leave a column of bare numbers with no units on a §11 surface.
    const labels = resolveTrendWidgetTexts({
      alarmsGeneratedValueHeading: 'Reading', alarmsDurationHeading: 'Open for',
    }).labels;
    renderWith([alarm], { labels });
    const head = document.querySelector('thead')!;
    expect(within(head).getAllByText('(°C / %RH)').length).toBe(2);
    expect(within(head).getByText('(H/m)')).toBeInTheDocument();
    expect(head.querySelector('th[title="H = hours, m = minutes"]')).not.toBeNull();
  });
});

describe('AlarmsWidget — the toolbar is the SHARED one', () => {
  /**
   * Moved onto `alarm-widget-filters.tsx` on 2026-09-01 so the dashboard's
   * selection panel renders the same three controls. These pin that the move
   * changed no behaviour here — the refactor is only safe if this surface still
   * sends what it sent.
   */
  it('still renders search, type and status', () => {
    renderWith([alarm]);
    expect(screen.getByRole('searchbox', { name: /search this instrument/i })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /filter by alarm type/i })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /filter by status/i })).toBeInTheDocument();
  });

  it('offers ALL FOUR statuses here — this widget is not scoped to active', () => {
    // The counterpart of the dashboard panel's two. That surface is pinned to
    // `state=ACTIVE`; this one shows a period, in which alarms clear.
    renderWith([alarm]);
    const labels = within(screen.getByRole('combobox', { name: /filter by status/i }))
      .getAllByRole('option').map((o) => o.textContent);
    expect(labels).toHaveLength(5);
    expect(labels.some((l) => /cleared/i.test(l ?? ''))).toBe(true);
  });

  it('still sends its filters to the server', () => {
    renderWith([alarm]);
    fireEvent.change(screen.getByRole('searchbox', { name: /search this instrument/i }), {
      target: { value: 'chiller' },
    });
    expect(new URL(alarmsKey()!, 'https://x').searchParams.get('search')).toBe('chiller');
  });

  it('keeps the export icon and the settings pencil beside the filters', () => {
    // They ride in the toolbar's `trailing` slot; a refactor that dropped the
    // slot would take both off the card with no type error.
    renderWith([alarm], { settingsButton: <button type="button">Widget settings</button> });
    expect(screen.getByRole('button', { name: /export/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Widget settings' })).toBeInTheDocument();
  });
});
