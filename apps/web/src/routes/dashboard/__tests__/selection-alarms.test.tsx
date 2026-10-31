import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The dashboard's "Active alarms in this selection" panel.
 *
 * Rebuilt on 2026-09-01 from a bespoke `<ul>` onto the SHARED alarm cells in
 * `routes/alarms/alarm-table.tsx`. Three things are pinned here, and each one is
 * a bug this repo has actually shipped:
 *
 * **It renders the SHARED cells, not a third copy of the table.** The trend
 * widget was a hand-written copy until 2026-09-01 and it had drifted; a copy here
 * would drift the same way. Asserting the banner and the cell structure is what
 * catches somebody "simplifying" the imports back into local markup.
 *
 * **The status pill is keyed off the four-state QUADRANT, never severity.** That
 * defect shipped on the Alarms page (fixed 2026-08-31) and again in the trend
 * widget (fixed 2026-09-01). On this installation every alarm is CRITICAL, so a
 * severity-keyed pill renders red on every row and the column says nothing.
 * **Asserting the LABEL cannot catch it** — the label comes from `statusText()`,
 * which is state-keyed and reads correctly under both mappings. These assert the
 * tone CLASS.
 *
 * **Every word comes from the administered configs.** The cells accept `texts`
 * as optional and fall back to the shipped wording, so a panel wired with none
 * would look entirely correct until somebody renamed an alarm type. The
 * configured-value cases are what prove the wiring exists.
 */

const active = {
  id: 'a-1',
  instrumentCode: 'CWH/RDU/001-00',
  instrumentId: 'i-1',
  locationName: 'Raw Material Store',
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

/**
 * Live, but somebody has signed for it. The quadrant says `active-ack` → `info`
 * (sky). Under the removed severity mapping this row was `danger` (rose), which
 * is the disagreement this fixture exists to expose — and it is reachable here,
 * unlike the cleared quadrants, because this panel queries `state=ACTIVE` only.
 */
const activeAcked = {
  ...active,
  id: 'a-2',
  acknowledgedAt: '2026-08-10T03:00:00.000Z',
  acknowledgedBy: 'qa.lead',
  acknowledgeReason: 'Chiller door left open; closed and verified.',
};

/**
 * An INACTIVITY alarm — raised by the ABSENCE of a reading, so it has no number
 * to put in the value cell and prints an administered word instead. This is the
 * row shape where passing the texts bag to the dialog actually matters: on a
 * limit alarm the restatement reads the same with or without it.
 */
const inactivity = {
  ...active,
  id: 'a-4',
  metric: 'OFFLINE',
  triggeredValue: null,
  source: 'INACTIVITY',
  limitKind: null,
  ruleSnapshot: { kind: 'INACTIVITY', graceMinutes: 15 },
};

/** No functional location — a real and normal state here. */
const unassigned = { ...active, id: 'a-3', locationName: null };

let alarmRows: unknown[] = [active];
/** Set to a value to simulate the administered configs having loaded. */
let statusTextsResponse: unknown;
let inactivityTextsResponse: unknown;

/**
 * The `alarms.acknowledge` gate, MUTABLE on purpose.
 *
 * A mock hardcoded to `() => true` leaves the gate — the only thing between an
 * operator and a §11 signature — completely unasserted, and the test suite would
 * be just as green with the check deleted from the component. This is flipped in
 * both directions below.
 */
let canAcknowledge = true;
const postWithReauth = vi.fn();
/**
 * This panel's OWN revalidation, the fourth piece of the signature flow.
 *
 * It must be on the SWR mock's return value. Without it `await mutate()` throws
 * "mutate is not a function", the component's own catch swallows it into the
 * dialog error, and the success path silently never completes — while a test
 * that only asserted `postWithReauth` was called still passes. That is exactly
 * what the first version of these tests did.
 */
const mutate = vi.fn();

vi.mock('@/hooks/use-can', () => ({ useCan: () => () => canAcknowledge }));
/** What the SERVER says the selection holds. Deliberately larger than the rows in
 *  hand in the paging test — a count taken from `rows.length` would describe one
 *  page while reading as the selection. */
let alarmTotal = 1;

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }),
}));
vi.mock('@/lib/api-client', () => ({
  apiClient: { postWithReauth: (...args: unknown[]) => postWithReauth(...args) },
}));

/** The alarms URL this panel asked for — where the paging is observable, since
 *  it is the SERVER that pages. */
let alarmsKey: string | null = null;
/** The SWR options the alarms fetch was made with — the drill-down rule lives there. */
let alarmsOptions: Record<string, unknown> | undefined;
/** Set to make the alarms request fail, as a 403 does for a viewer without ALARM_READ. */
let alarmsError: unknown;
vi.mock('swr', () => ({
  default: (key: string | null, opts?: Record<string, unknown>) => {
    if (typeof key === 'string' && key.startsWith('/api/alarms')) {
      alarmsKey = key;
      alarmsOptions = opts;
      return { data: alarmsError ? undefined : { data: alarmRows, total: alarmTotal }, error: alarmsError, mutate };
    }
    if (key === '/api/config/alarm-limits/status-texts') return { data: statusTextsResponse };
    if (key === '/api/config/inactivity-alarms/display-texts') return { data: inactivityTextsResponse };
    return { data: undefined };
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

const { SelectionAlarms } = await import('../selection-alarms');

function renderWith(rows: unknown[] = [active], total = rows.length) {
  alarmRows = rows;
  alarmTotal = total;
  alarmsKey = null;
  return render(<MemoryRouter><SelectionAlarms functionalLocationId="fl-1" /></MemoryRouter>);
}

beforeEach(() => {
  alarmRows = [active];
  alarmTotal = 1;
  alarmsError = undefined;
  statusTextsResponse = undefined;
  inactivityTextsResponse = undefined;
  canAcknowledge = true;
  postWithReauth.mockReset();
  postWithReauth.mockResolvedValue({});
  mutate.mockReset();
  mutate.mockResolvedValue(undefined);
});

/**
 * The status pill for one row.
 *
 * Scoped to `<tbody>`, not `screen`: the stacked "Generated Value" heading puts
 * a `<span>Value</span>` in the banner, so document-wide text queries can match
 * a heading as well as a cell and throw on the ambiguity.
 */
function pillIn(container: HTMLElement, label: string): HTMLElement {
  const body = container.querySelector('tbody');
  if (!body) throw new Error('no table body rendered');
  return within(body as HTMLElement).getByText(label);
}

describe('SelectionAlarms — it renders the SHARED alarm table, not a bespoke list', () => {
  // Drill-down keeps the previous selection's rows until the next land
  // (2026-09-16, "widgets take 2-3 sec to align") — see drill-down-keeps-data.test.tsx.
  it('keeps the previous selection\'s alarms while the next selection loads', () => {
    renderWith();
    expect(alarmsOptions).toMatchObject({ keepPreviousData: true });
  });

  it('polls on THE dashboards retry policy (R7-11): a failure is retried, a refusal is not, and only the policy reports', () => {
    renderWith();
    const opts = alarmsOptions as {
      refreshInterval?: number; shouldRetryOnError?: (e: unknown) => boolean; onErrorRetry?: unknown; onError?: () => void;
    };
    expect(opts.refreshInterval).toBe(30_000);
    expect(typeof opts.onErrorRetry).toBe('function');
    expect(opts.shouldRetryOnError?.(Object.assign(new Error('down'), { status: 500 }))).toBe(true);
    expect(opts.shouldRetryOnError?.(Object.assign(new Error('Forbidden'), { status: 403 }))).toBe(false);
    // The per-hook onError is silent: the policy reports once per key, not the app handler per failure.
    expect(opts.onError?.()).toBeUndefined();
  });

  it('renders a real table with the shared banner, not the old <ul>', () => {
    const { container } = renderWith();
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.querySelector('ul')).toBeNull();
    // `AlarmTableHead`'s banner is painted from the site theme rather than a
    // hardcoded indigo — the marker that this is the shared head and not a
    // hand-rolled one.
    const head = container.querySelector('thead')!;
    // UI v3 (2026-09-21): the shared band token, derived from the theme's gradient variables.
    expect(head.getAttribute('style')).toContain('var(--band-gradient)');
  });

  it('shows the Alarms page column set, keeping Instrument ID and Location', () => {
    const { container } = renderWith();
    const head = within(container.querySelector('thead')!);
    // This panel spans MANY instruments, so both columns the trend widget drops
    // as redundant are load-bearing here.
    expect(head.getByText('Instrument ID')).toBeInTheDocument();
    expect(head.getByText('Location')).toBeInTheDocument();
    expect(head.getByText('Type')).toBeInTheDocument();
    expect(head.getByText('Raised')).toBeInTheDocument();
    expect(head.getByText('Limit')).toBeInTheDocument();
    expect(head.getByText('Status')).toBeInTheDocument();
    // Stacked one word per line, as on the Alarms page.
    expect(head.getByText('Generated')).toBeInTheDocument();
    expect(head.getByText('Acknowledged')).toBeInTheDocument();
    // The unit legend lives in the HEADER, never on the cells.
    // Twice since 2026-09-25: under Generated Value and under Cleared Value.
    expect(head.getAllByText('(°C / %RH)')).toHaveLength(2);
  });

  it('shows Cleared and Cleared Value — the query spans every state (2026-09-25); Duration still omitted', () => {
    // Operator: "cleared value and cleared time was not there in widget". The
    // panel no longer sends state=ACTIVE, so a cleared alarm is on the
    // dashboard with the time and the reading that ended it.
    const { container } = renderWith();
    const head = within(container.querySelector('thead')!);
    expect(head.getAllByText('Cleared').length).toBeGreaterThanOrEqual(2);
    expect(head.queryByText('Duration')).toBeNull();
    // colSpan on the empty-state row must match the column count, or a hairline
    // of unpainted table shows beside the message.
    // ELEVEN: the ten named columns plus the unlabelled action cell.
    const headers = container.querySelectorAll('thead th');
    expect(headers.length).toBe(11);
  });

  it('asks the server for every state, not state=ACTIVE', () => {
    renderWith([active]);
    expect(alarmsKey).toBeTruthy();
    expect(alarmsKey).not.toContain('state=');
  });
});

describe('SelectionAlarms — the status pill is keyed off STATUS, never severity', () => {
  it('paints a live, unanswered alarm red', () => {
    const { container } = renderWith([active]);
    const pill = pillIn(container, 'Still pending Unacknowledged');
    expect(pill.className).toContain('var(--status-danger-bg)');
  });

  it('paints a live but ACKNOWLEDGED alarm sky, not red', () => {
    // The row is still CRITICAL and still ACTIVE. A severity-keyed pill renders
    // it `danger` and the column stops distinguishing answered from unanswered.
    const { container } = renderWith([activeAcked]);
    const pill = pillIn(container, 'Active — Acknowledged');
    expect(pill.className).toContain('var(--status-info-bg)');
    expect(pill.className).not.toContain('var(--status-danger-bg)');
  });

  it('carries the state marker on the leading Instrument ID cell', () => {
    const { container } = renderWith([activeAcked]);
    const lead = container.querySelector('tbody tr td')!;
    // `ACCENT['info']` — the solid counterpart of the pill's tone, so the row's
    // edge and its pill cannot describe different states.
    expect(lead.querySelector('.bg-sky-500')).not.toBeNull();
  });
});

describe('SelectionAlarms — every word comes from the administered config', () => {
  it('falls back to the shipped wording while the config has not loaded', () => {
    renderWith([active]);
    expect(screen.getByText('Still pending Unacknowledged')).toBeInTheDocument();
  });

  it('renders the CONFIGURED status wording once it has loaded, not the default', () => {
    // The panel must read the same `/alarm-limits/status-texts` the Alarms page
    // does. Omitting the fetch compiles and looks correct until a rename.
    statusTextsResponse = {
      statusActiveUnack: 'Awaiting operator sign-off',
      statusActiveAck: 'Active — Acknowledged',
      statusClearedUnack: 'Cleared — Unacknowledged',
      statusClearedAck: 'Cleared',
    };
    renderWith([active]);
    expect(screen.getByText('Awaiting operator sign-off')).toBeInTheDocument();
    expect(screen.queryByText('Still pending Unacknowledged')).toBeNull();
  });

  it('shows the FUNCTIONAL location, and "Unassigned" rather than a blank', () => {
    const { container } = renderWith([unassigned]);
    const body = within(container.querySelector('tbody')!);
    expect(body.getByText('Unassigned')).toBeInTheDocument();
  });

  it('names the instrument by its code', () => {
    const { container } = renderWith([active]);
    const body = within(container.querySelector('tbody')!);
    expect(body.getByText('CWH/RDU/001-00')).toBeInTheDocument();
    expect(body.getByText('Raw Material Store')).toBeInTheDocument();
  });

  it('says "Awaiting" for an unanswered alarm rather than leaving the cell blank', () => {
    const { container } = renderWith([active]);
    expect(within(container.querySelector('tbody')!).getByText('Awaiting')).toBeInTheDocument();
  });

  it('renders an empty selection as a message, not an empty table', () => {
    renderWith([]);
    expect(screen.getByText('No active alarms here.')).toBeInTheDocument();
  });
});

/**
 * The §11 signature flow.
 *
 * The button was deliberately ABSENT until 2026-09-01 and arrived only with all
 * four pieces behind it — the gate, the re-auth dialog, `postWithReauth` and a
 * revalidation. These tests exist so that stays true: each one fails if a piece
 * is removed, which is the property the original exclusion was protecting.
 */
/**
 * The dialog's own subtree.
 *
 * Needed because the row's trigger and the dialog's submit are BOTH labelled
 * "Acknowledge" — a document-wide role query matches two buttons and throws, and
 * picking `[0]` would silently test the trigger twice.
 */
function dialog(container: HTMLElement): HTMLElement {
  const el = container.querySelector('.fixed.inset-0');
  if (!el) throw new Error('the acknowledge dialog is not open');
  return el as HTMLElement;
}

/** Fill and submit the signature. `#ack-password` by id: the label text
 *  "Password" also appears in the field's own help copy. */
function sign(container: HTMLElement, reason: string, password: string) {
  const d = dialog(container);
  fireEvent.change(within(d).getByLabelText(/reason/i), { target: { value: reason } });
  fireEvent.change(d.querySelector('#ack-password')!, { target: { value: password } });
  fireEvent.click(within(d).getByRole('button', { name: /^acknowledge$/i }));
}

describe('SelectionAlarms — acknowledging is a gated §11 signature', () => {
  it('offers Acknowledge on an unanswered alarm when the role holds the gate', () => {
    renderWith([active]);
    expect(screen.getByRole('button', { name: /acknowledge/i })).toBeInTheDocument();
  });

  it('pins the action cell to the right edge, painted in the ROW\'s own colour (audit 2026-10-03, WEB-7)', () => {
    // Eleven nowrap columns overflow a panel and the only horizontal scrollbar
    // is at the table's foot, so an unpinned Acknowledge was reachable only by
    // scrolling down, then right, with no cue. The cell is sticky like the
    // Alarms page's; `bg-inherit` because the `.alarm-grid` zebra sits on the
    // <tr> — a colour of the cell's own would paint over it.
    const { container } = renderWith([active]);
    const cell = screen.getByRole('button', { name: /acknowledge/i }).closest('td')!;
    for (const cls of ['sticky', 'right-0', 'bg-inherit']) expect(cell.classList.contains(cls)).toBe(true);
    const ths = container.querySelectorAll('thead th');
    const last = ths[ths.length - 1];
    expect(last.classList.contains('sticky')).toBe(true);
    expect(last.classList.contains('right-0')).toBe(true);
  });

  it('HIDES it when the role does not hold alarms.acknowledge', () => {
    // The other direction, and the one a hardcoded `() => true` mock cannot see.
    // Hiding it is presentation — the server's 403 is the control — but a button
    // shown to a role the server will refuse invites an operator to try and fail.
    canAcknowledge = false;
    renderWith([active]);
    expect(screen.queryByRole('button', { name: /acknowledge/i })).toBeNull();
  });

  it('offers nothing on an alarm somebody has already signed for', () => {
    // `needsAcknowledgement` is the second half of the gate. Without it a signed
    // alarm still shows a button, and the second signature is a 409.
    renderWith([activeAcked]);
    expect(screen.queryByRole('button', { name: /acknowledge/i })).toBeNull();
  });

  it('opens the re-auth dialog rather than acknowledging on the click', () => {
    // The click must NOT submit. A §11 signature needs the reason and the
    // password collected together in one deliberate act.
    const { container } = renderWith([active]);
    fireEvent.click(screen.getByRole('button', { name: /acknowledge/i }));
    expect(within(dialog(container)).getByText(/acknowledge alarm/i)).toBeInTheDocument();
    expect(postWithReauth).not.toHaveBeenCalled();
  });

  it('restates the alarm being signed for, in the SAME words as the row', () => {
    // The dialog takes the same administered `texts` bag the rows render from.
    // Without it an inactivity alarm reads "—" on the screen where the signature
    // is actually executed.
    //
    // **All THREE restatement lines, not just the instrument.** `instrumentLabel`
    // is the one field guaranteed present on any row, so asserting it alone
    // passes while `conditionText` and `triggeredText` render "—" — and an
    // operator signing a dialog that does not say what they are signing for is
    // precisely what that dialog's own doc comment exists to prevent.
    const { container } = renderWith([active]);
    fireEvent.click(screen.getByRole('button', { name: /acknowledge/i }));
    const text = dialog(container).textContent ?? '';
    expect(text).toContain('CWH/RDU/001-00');        // instrumentLabel
    expect(text).toContain('temperature out of limit'); // conditionText
    expect(text).toContain('30.0');                   // triggeredText, at the FROZEN precision
    expect(text).not.toContain('—');
  });

  it('restates an INACTIVITY alarm in the ADMINISTERED word, not the shipped default', () => {
    // The dialog's `inactivityTexts` is not decoration. This alarm has no number
    // for the Reading line, so the word comes from config — and it must be the
    // SAME word the row above showed. Without the prop the dialog silently falls
    // back to the shipped wording and the operator signs a restatement that
    // disagrees with the screen they clicked from.
    inactivityTextsResponse = {
      textGeneratedValue: 'Instrument silent',
      textLimit: 'quiet > {minutes}m',
      textClearedValue: 'Data resumed',
    };
    const { container } = renderWith([inactivity]);
    // The row and the dialog, asserted against the same word.
    expect(within(container.querySelector('tbody')!).getByText('Instrument silent')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /acknowledge/i }));
    expect(dialog(container).textContent).toContain('Instrument silent');
  });

  it('posts through postWithReauth with the reason and the password', async () => {
    const { container } = renderWith([active]);
    fireEvent.click(screen.getByRole('button', { name: /acknowledge/i }));
    sign(container, 'Chiller door left open overnight; closed and verified.', 'Secret@123');

    await waitFor(() => expect(postWithReauth).toHaveBeenCalledTimes(1));
    // The URL, the body and the password each separately — a bare
    // `toHaveBeenCalled()` would pass with the wrong alarm id in the path.
    expect(postWithReauth).toHaveBeenCalledWith(
      '/api/alarms/a-1/acknowledge',
      { reason: 'Chiller door left open overnight; closed and verified.' },
      'Secret@123',
    );
  });

  it('revalidates its OWN list and closes the dialog once the signature lands', async () => {
    // The fourth piece. Without it the row keeps its "Awaiting" cell until the
    // 30s poll comes round, so a signature that succeeded looks like one that
    // did nothing. `mutate` is this panel's key only — the Alarms page holds a
    // different query and revalidates itself when next shown.
    const { container } = renderWith([active]);
    fireEvent.click(screen.getByRole('button', { name: /acknowledge/i }));
    sign(container, 'Chiller door left open overnight; closed and verified.', 'Secret@123');

    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(container.querySelector('.fixed.inset-0')).toBeNull());
  });

  it('does NOT revalidate when the signature was refused', async () => {
    // The negative control for the test above: a `mutate` called on both paths
    // would satisfy it while telling the panel to re-read after nothing changed.
    postWithReauth.mockRejectedValue(new Error('Alarm already acknowledged'));
    const { container } = renderWith([active]);
    fireEvent.click(screen.getByRole('button', { name: /acknowledge/i }));
    sign(container, 'Verified against the chart and closed.', 'Secret@123');

    await screen.findByText('Alarm already acknowledged');
    expect(mutate).not.toHaveBeenCalled();
  });

  it('shows the server\'s wrong-password message — a re-auth refusal is a plain object, not an Error', async () => {
    // `apiClient` throws REAUTH_FAILED untouched ({ error, message }) so a dialog can
    // show it; an `instanceof Error` check printed "Could not acknowledge this alarm."
    // for a wrong signature password (OQ review, 2026-10-30).
    postWithReauth.mockRejectedValue({ error: 'REAUTH_FAILED', message: 'Incorrect password. Please try again.' });
    const { container } = renderWith([active]);
    fireEvent.click(screen.getByRole('button', { name: /acknowledge/i }));
    sign(container, 'Verified against the chart and closed.', 'Wrong@123');

    expect(await screen.findByText('Incorrect password. Please try again.')).toBeInTheDocument();
    expect(screen.queryByText('Could not acknowledge this alarm.')).toBeNull();
  });

  it('keeps a failure IN THE DIALOG, never as a toast', async () => {
    // The password is still on screen and has to be corrected in place. A 409
    // means somebody else signed for this alarm first.
    postWithReauth.mockRejectedValue(new Error('Alarm already acknowledged'));
    const { container } = renderWith([active]);
    fireEvent.click(screen.getByRole('button', { name: /acknowledge/i }));
    sign(container, 'Verified against the chart and closed.', 'Secret@123');

    // Still open, with the message inside it.
    expect(await screen.findByText('Alarm already acknowledged')).toBeInTheDocument();
    expect(container.querySelector('.fixed.inset-0')).not.toBeNull();
  });
});

describe('SelectionAlarms — pagination', () => {
  /**
   * This panel fetched a flat `limit=25` and rendered whatever came back, so on a
   * selection with more than 25 active alarms it showed the newest 25 and said
   * nothing — no count on screen to contradict it, and no way to reach the rest
   * without leaving for the Alarms page. Operator asked for pagination on
   * 2026-09-01.
   */
  it('asks the SERVER for a page rather than a flat limit', () => {
    renderWith([active]);
    const q = new URL(alarmsKey!, 'https://x').searchParams;
    expect(q.get('page')).toBe('1');
    expect(Number(q.get('pageSize'))).toBeGreaterThan(0);
    // The cap this replaced. Its return would silently reinstate the truncation.
    expect(q.get('limit')).toBeNull();
  });

  it('keeps the location scope exactly as it was, and sends no state (every state since 2026-09-25)', () => {
    // Paging changes how many rows are shown at once. It must not change WHICH
    // records a compliance panel is reporting on.
    const q = new URL((renderWith([active]), alarmsKey!), 'https://x').searchParams;
    expect(q.has('state')).toBe(false);
    expect(q.get('functionalLocationId')).toBe('fl-1');
  });

  it('counts the SERVER total, not the rows in hand', () => {
    // One page of 1 row out of 87. A count derived from `rows.length` would read
    // "of 1" and describe the page while appearing to describe the selection —
    // the same defect the Alarms page was rebuilt to remove.
    renderWith([active], 87);
    expect(screen.getByText('87')).toBeInTheDocument();
  });

  it('renders no pager when there is nothing to page', () => {
    // "Showing 0-0 of 0" beneath a "No active alarms" line is two ways of saying
    // nothing, one of them noisier.
    renderWith([], 0);
    expect(screen.queryByText(/Showing/)).toBeNull();
  });
});

describe('SelectionAlarms — no way out of the panel', () => {
  it('has no "All alarms" link', () => {
    // Removed 2026-09-01 (operator). The justification recorded beside it had
    // already half-expired: it was there as the route to "the filters, the four
    // state counts and the paging this panel deliberately does not have", and the
    // panel gained paging and a total earlier the same day.
    renderWith([active]);
    expect(screen.queryByText(/All alarms/i)).toBeNull();
  });

  it('has no link out of the panel at all', () => {
    // Stricter than the text query and the one that survives a rewording: nothing
    // in this panel navigates away. The Alarms page is still on the sidebar.
    const { container } = renderWith([active]);
    expect(container.querySelector('a[href="/alarms"]')).toBeNull();
  });

  it('still shows the rows and the pager it exists for', () => {
    // The negative control. Two assertions that pass on an empty render would
    // look identical to two that pass on a working one.
    renderWith([active], 87);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('87')).toBeInTheDocument();
  });
});

describe('SelectionAlarms — the shared widget filters', () => {
  /**
   * Operator, 2026-09-01: the filters on the trend page's alarms widget should
   * also be here. They are the SAME component, so a change to either reaches
   * both — the lesson from three hand-written alarm tables that drifted.
   */
  it('renders search, type and status', () => {
    renderWith([active]);
    expect(screen.getByRole('searchbox', { name: /search the alarms in this selection/i })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /filter by alarm type/i })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /filter by status/i })).toBeInTheDocument();
  });

  it('offers all FOUR statuses now that the query spans every state', () => {
    // Until 2026-09-25 the query was pinned to state=ACTIVE and the two cleared
    // options could never match, so only the active pair was offered.
    renderWith([active]);
    const status = screen.getByRole('combobox', { name: /filter by status/i });
    const labels = within(status).getAllByRole('option').map((o) => o.textContent);
    expect(labels[0]).toBe('All statuses');
    expect(labels).toHaveLength(5);
    expect(labels.filter((l) => /cleared/i.test(l ?? ''))).toHaveLength(2);
  });

  it('sends each filter to the SERVER, not to the rows in hand', () => {
    // A client-side filter on a paged panel narrows ONE PAGE while reading as a
    // filter of the selection — the defect the Alarms page was rebuilt to remove.
    renderWith([active]);
    fireEvent.change(screen.getByRole('searchbox', { name: /search the alarms in this selection/i }), {
      target: { value: 'CWH/RDU/006' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: /filter by status/i }), {
      target: { value: 'active-unack' },
    });
    const q = new URL(alarmsKey!, 'https://x').searchParams;
    expect(q.get('search')).toBe('CWH/RDU/006');
    expect(q.get('status')).toBe('active-unack');
    // And the scope is still the panel's own: the location, and no state pin.
    expect(q.get('functionalLocationId')).toBe('fl-1');
    expect(q.has('state')).toBe(false);
  });

  it('omits an untouched control rather than sending an empty value', () => {
    // An empty `type=` is a filter the server has to decide how to read. Not
    // sending it is the only form that cannot be misread.
    renderWith([active]);
    const q = new URL(alarmsKey!, 'https://x').searchParams;
    expect(q.has('search')).toBe(false);
    expect(q.has('type')).toBe(false);
    expect(q.has('status')).toBe(false);
  });

  it('returns to page 1 when a filter changes', () => {
    // Page 4 of a five-page result is an empty table once a filter narrows it to
    // two, and an empty table reads as "no alarms" rather than "wrong page".
    renderWith([active], 200);
    fireEvent.click(screen.getByRole('button', { name: /next page/i }));
    expect(new URL(alarmsKey!, 'https://x').searchParams.get('page')).toBe('2');

    fireEvent.change(screen.getByRole('combobox', { name: /filter by alarm type/i }), {
      target: { value: 'TEMP_HIGH' },
    });
    expect(new URL(alarmsKey!, 'https://x').searchParams.get('page')).toBe('1');
  });
});

describe('SelectionAlarms — the lg size mode (2026-09-25)', () => {
  // Operator: "active alarms in this selection alarm widget make that also
  // proper colorful and table format and fonts size increase and bold". The
  // panel wraps the shared cells in AlarmTableSizeProvider size="lg": each row
  // is washed in its own tone and the type steps up a size and a weight. The
  // Alarms page and the trend widget pass no size and are untouched.
  it('is a bordered grid with the readings table\'s column hues and an extrabold ID', () => {
    renderWith([active]);
    // The grid: lines between every cell and a zebra come from `.alarm-grid`
    // (app.css); the colour from the `.tv-h-*` headers, not a row wash.
    const table = screen.getByRole('table');
    expect(table.className).toMatch(/(^|\s)alarm-grid(\s|$)/);
    const heads = screen.getAllByRole('columnheader');
    expect(heads[0].className).toMatch(/(^|\s)tv-h-id(\s|$)/);
    expect(heads[1].className).toMatch(/(^|\s)tv-h-type(\s|$)/);
    const rows = screen.getAllByRole('row');
    const body = rows[rows.length - 1];
    expect(body.className).not.toMatch(/bg-rose-50/);
    const cells = within(body).getAllByRole('cell');
    expect(cells[0].className).toMatch(/(^|\s)font-extrabold(\s|$)/);
    expect(cells[0].className).toMatch(/(^|\s)text-base(\s|$)/);
    // The reading is a tone chip.
    expect(cells[4].querySelector('.tv-chip')).not.toBeNull();
  });

  it('prints a WORD value as a small pill, not the number chip', () => {
    // Operator: "offline text was not looking good in generated value". An
    // inactivity alarm's Generated Value is a word; the 18px number chip
    // around it read as a shout.
    inactivityTextsResponse = { textGeneratedValue: 'No data', textLimit: 'quiet > {minutes}m', textClearedValue: 'Data resumed' };
    renderWith([inactivity]);
    const rows = screen.getAllByRole('row');
    const cells = within(rows[rows.length - 1]).getAllByRole('cell');
    expect(cells[4].querySelector('.tv-chip')).toBeNull();
    const word = within(cells[4]).getByText('No data');
    expect(word.className).toMatch(/(^|\s)text-sm(\s|$)/);
  });
});

describe('SelectionAlarms — a failed request is not an empty card', () => {
  const forbidden = Object.assign(new Error('Forbidden'), { status: 403 });

  it('a SCOPED table (a built dashboard) prints the load-failed message', () => {
    alarmsError = forbidden;
    alarmRows = []; alarmTotal = 0;
    render(<MemoryRouter><SelectionAlarms scope={{ instrumentIds: ['i-1'] }} /></MemoryRouter>);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load this widget.');
  });

  it('the home panel (no scope) still renders nothing on an error', () => {
    alarmsError = forbidden;
    const { container } = render(<MemoryRouter><SelectionAlarms functionalLocationId="fl-1" /></MemoryRouter>);
    expect(container).toBeEmptyDOMElement();
  });
});
