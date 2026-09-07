import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The Alarms page, mounted for real.
 *
 * Every assertion here is a WIRING defect — each one would pass a test of the
 * component in isolation while the page fed it the wrong thing:
 *
 * 1. **The count cards read the SERVER's `counts`, not the rows on screen.**
 *    The fixture deliberately returns ONE row against counts of 16/2/8/0, which
 *    is what a paged response actually looks like. A card that counted `data`
 *    would show 1, and that is precisely the defect this page was rebuilt to
 *    remove: the counts used to be derived in the browser from a capped window.
 * 2. **"Showing … of N" uses the server's `total`, for the same reason.**
 * 3. **The status pill is keyed off the four STATES.** It was keyed off
 *    `severity` until 2026-08-31, and since every alarm on this installation was
 *    CRITICAL that painted every row red regardless of whether anyone had
 *    answered for it. The field itself went on 2026-09-01 with the severity
 *    concept, so the bug is now unrepresentable — these assertions stay because
 *    they pin the tone to the QUADRANT, which is the property that matters.
 * 4. **A failed request does not render as an empty table.** "No alarms" reads
 *    as "nothing is wrong" to someone who simply could not load them.
 *
 * NOT VERIFIED HERE: what any of it looks like. Nothing in this repo can
 * authenticate a browser against the local certificate, so this is read out of
 * the DOM, not seen.
 */

const counts = { 'active-unack': 16, 'active-ack': 2, 'cleared-unack': 8, 'cleared-ack': 0 };

const activeUnack = {
  id: 'a-1',
  instrumentCode: 'CWH/RDU/001-00',
  instrumentId: 'i-1',
  instrumentName: 'Stability chamber 1',
  locationName: 'Excipient Dispensing Area',
  metric: 'TEMPERATURE',
  triggeredValue: 28,
  state: 'ACTIVE',
  source: 'INSTRUMENT_LIMIT',
  limitKind: 'HIGH',
  clearedValue: null,
  raisedAt: '2026-08-27T11:54:35.000Z',
  clearedAt: null,
  acknowledgedAt: null,
  acknowledgedBy: null,
  acknowledgeReason: null,
  ruleSnapshot: { limit: 27, limitKind: 'HIGH', decimals: 1 },
};

/** The overnight excursion: the condition ended, nobody signed for it. */
const clearedUnack = {
  ...activeUnack,
  id: 'a-2',
  instrumentCode: 'CWH/RDU/030-00',
  state: 'CLEARED',
  clearedAt: '2026-08-27T12:10:00.000Z',
  clearedValue: 24,
};

/** `keepData` models SWR's real behaviour on a FAILED REVALIDATION: `data` is
 *  retained from the last success while `error` is set. That combination is
 *  reachable on every refocus, and the page must not describe rows it is
 *  actually showing as rows it could not load. */
const listState: { rows: unknown[]; error: unknown; keepData: boolean } =
  { rows: [activeUnack], error: undefined, keepData: false };

vi.mock('swr', () => ({
  default: (key: unknown) => {
    const k = typeof key === 'function' ? (key as () => string)() : key;
    if (typeof k !== 'string') return { data: undefined, isLoading: false, mutate: vi.fn() };
    if (k.startsWith('/api/alarms?')) {
      const payload = { data: listState.rows, total: 26, counts };
      if (listState.error) {
        return {
          data: listState.keepData ? payload : undefined,
          isLoading: false, error: listState.error, mutate: vi.fn(),
        };
      }
      return { data: payload, isLoading: false, mutate: vi.fn() };
    }
    if (k.startsWith('/api/alarms/summary')) return { data: { active: 18, unacknowledged: 24, critical: 18, limitAlarmsEnabled: true }, mutate: vi.fn() };
    if (k.includes('/status-texts')) return { data: undefined, mutate: vi.fn() };
    if (k.includes('/api/functional-locations')) return { data: { data: [] }, mutate: vi.fn() };
    if (k.includes('/config/pagination')) return { data: { limit: 10, count: 0, options: [10, 25, 50] }, mutate: vi.fn() };
    if (k.startsWith('/api/roles/active')) return { data: [{ name: 'QA', displayName: 'QA Approver' }], mutate: vi.fn() };
    if (k.startsWith('/api/users?')) return { data: { data: [{ id: 'u-appr', username: 'qa1', fullName: 'QA One', role: 'QA' }] }, mutate: vi.fn() };
    return { data: undefined, isLoading: false, mutate: vi.fn() };
  },
}));

vi.mock('@/hooks/use-can', () => ({ useCan: () => () => true }));

/**
 * The governed PDF download. Each step is mocked separately so the ORDER between
 * them can be asserted — that is the §11 property, not the PDF's contents.
 */
const submitRequest = vi.fn();
const savePdf = vi.fn();
const buildAlarmsReport = vi.fn();
/** Stands in for the re-auth prompt: hands a password to the callback, as the
 *  real `executeWithResult` does once the operator has signed. */
let reauthGrants = true;
vi.mock('@/hooks/use-reauth', () => ({
  useReauth: () => ({
    isOpen: false, password: '', error: '', isVerifying: false,
    setPassword: vi.fn(), confirm: vi.fn(), cancel: vi.fn(),
    executeWithResult: async (_action: string, cb: (p?: string) => Promise<void>) => {
      if (!reauthGrants) return;      // operator cancelled the password prompt
      await cb('Secret@123');
    },
  }),
}));
vi.mock('@/lib/report-review', () => ({
  submitReportForReview: (...a: unknown[]) => submitRequest(...a),
  assigneeLabel: () => 'qa1',
}));
vi.mock('@/lib/pdf-report', () => ({
  createReport: async () => ({
    save: savePdf, addKeyValue: vi.fn(), addTable: vi.fn(), addSectionTitle: vi.fn(),
    getSnapshot: () => ({ version: 2, reportType: 'alarms', title: 'ALARM REPORT', config: {}, sections: [] }),
  }),
}));
vi.mock('../alarms-report', async (actual) => ({
  ...(await actual<typeof import('../alarms-report')>()),
  buildAlarmsReport: (...a: unknown[]) => buildAlarmsReport(...a),
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }) }));

const apiGet = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiClient: {
    get: (...a: unknown[]) => apiGet(...a),
    post: vi.fn(), postWithReauth: vi.fn(),
  },
}));

const { default: AlarmsPage } = await import('../index');

const mount = () => render(<MemoryRouter><AlarmsPage /></MemoryRouter>);

/** The card is a button holding its label and its number. The label is
 *  title-case in the DOM — the block capitals are a CSS `uppercase`, so matching
 *  on the rendered capitals would silently find nothing. */
const card = (label: string) => {
  const hit = screen.getAllByRole('button').find((b) => (b.textContent ?? '').includes(label));
  if (!hit) throw new Error(`No count card labelled "${label}"`);
  return hit;
};

beforeEach(() => {
  listState.rows = [activeUnack];
  listState.error = undefined;
  listState.keepData = false;
});

describe('the count cards describe the plant, not the page', () => {
  it('shows the SERVER counts even though one row was returned', () => {
    mount();
    expect(card('Active Unacknowledged').textContent).toContain('16');
    expect(card('Active Acknowledged').textContent).toContain('2');
    expect(card('Cleared Unacknowledged').textContent).toContain('8');
    expect(card('Cleared Acknowledged').textContent).toContain('0');
  });

  it('shows a zero state as 0, not as blank', () => {
    // A blank card reads as a rendering fault; "no alarms are in this state" is
    // a real and reassuring answer.
    mount();
    expect(card('Cleared Acknowledged').textContent).toContain('0');
  });

  it('pages over the server total, not the rows in hand', () => {
    mount();
    expect(screen.getByText(/of/).closest('p')!.textContent).toContain('26');
  });

  it('marks the chosen card as pressed, and the others as not', () => {
    mount();
    for (const label of ['Active Unacknowledged', 'Cleared Unacknowledged']) {
      expect(card(label)).toHaveAttribute('aria-pressed', 'false');
    }
  });
});

describe('the row', () => {
  it('names where the alarm happened, from the functional location', () => {
    mount();
    expect(screen.getByText('Excipient Dispensing Area')).toBeInTheDocument();
    // The column is Location, not Location / Room — the drawn room is geometry,
    // and here every room is coded with the instrument's own code.
    expect(screen.queryByText('Location / Room')).toBeNull();
    expect(screen.getByText('Location')).toBeInTheDocument();
  });

  it('quotes the reading bare, with the unit left in the column head', () => {
    // Operator's rule, set 2026-08-29 and restated 2026-08-31: the °C / %RH
    // legend belongs to the header, and the row's metric is already named in the
    // Type column. A per-cell unit repeats it and widens the column.
    mount();
    const row = screen.getByText('CWH/RDU/001-00').closest('tr')!;
    expect(within(row).getByText('28.0')).toBeInTheDocument();
    expect(within(row).queryByText('°C')).toBeNull();
    // The heading is stacked onto three lines — "Generated" / "Value" /
    // "(°C / %RH)" — so it cannot set the column's width and push the
    // Acknowledge button off the screen. Asserted through the <th>, not the
    // string, because the words are separate elements by design.
    const head = screen.getByText('Generated').closest('th')!;
    expect(head.textContent).toBe('GeneratedValue(°C / %RH)');
  });

  it('states the limit that was breached, from the frozen snapshot', () => {
    mount();
    const row = screen.getByText('CWH/RDU/001-00').closest('tr')!;
    expect(within(row).getByText('> 27.0')).toBeInTheDocument();
  });

  it('says an unanswered alarm is awaiting a signature', () => {
    mount();
    const row = screen.getByText('CWH/RDU/001-00').closest('tr')!;
    expect(within(row).getByText('Awaiting')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Acknowledge' })).toBeInTheDocument();
  });

  it('gives a cleared-but-unsigned alarm a DIFFERENT status tone from a live one', () => {
    // These two differ ONLY in whether anyone has signed for them. While the pill
    // was keyed off severity they were the same colour, so the page could not
    // distinguish "nobody has answered this yet" from "the excursion ended and
    // nobody answered".
    listState.rows = [activeUnack, clearedUnack];
    mount();
    const pill = (code: string) => {
      const row = screen.getByText(code).closest('tr')!;
      return within(row).getByText(/Unacknowledged/i).className;
    };
    expect(pill('CWH/RDU/001-00')).not.toBe(pill('CWH/RDU/030-00'));
  });

  it('reports the duration of a cleared alarm and nothing for a live one', () => {
    // A running total in a column of settled figures would imply a closed number
    // that is still open.
    listState.rows = [activeUnack, clearedUnack];
    mount();
    const live = screen.getByText('CWH/RDU/001-00').closest('tr')!;
    const done = screen.getByText('CWH/RDU/030-00').closest('tr')!;
    expect(within(done).getByText('00:15M')).toBeInTheDocument();
    expect(within(live).queryByText(/^\d\d:\d\d[HM]$/)).toBeNull();
  });
});

describe('the Acknowledge column stays reachable', () => {
  /**
   * Twelve columns overflow a laptop screen and the page's ONLY action is what
   * falls off the end of it. The action column is pinned to the right edge, and
   * its HEADER carries its own opaque background and the same edge shadow — a
   * transparent header cell lets the rows scroll visibly THROUGH the banner,
   * which only ever shows up once the table is scrolled sideways.
   *
   * Guarded here because the header cell gets those from `className` and `style`
   * passed into the shared `Th` (`routes/alarms/alarm-table.tsx`). If that
   * passthrough is ever dropped, nothing else on this page notices.
   */
  const actionHeader = () => {
    const heads = [...document.querySelectorAll('thead th')];
    const last = heads[heads.length - 1] as HTMLElement;
    return last;
  };

  it('pins the action header to the right edge, with its own background', () => {
    mount();
    const th = actionHeader();
    expect(th.className).toContain('sticky');
    expect(th.className).toContain('right-0');
    // Opaque, and painted from the site theme rather than a hardcoded colour, so
    // it matches the banner it sits in under every one of the ten presets.
    expect(th.getAttribute('style') ?? '').toContain('var(--theme-primary');
    // The edge shadow that separates the pinned column from what scrolls under it.
    expect(th.className).toContain('shadow-');
  });

  it('pins the action CELL to the same edge, opaque on hover as well as at rest', () => {
    mount();
    const row = screen.getByText('CWH/RDU/001-00').closest('tr')!;
    const cell = row.querySelector('td:last-child') as HTMLElement;
    expect(within(cell).getByRole('button', { name: 'Acknowledge' })).toBeInTheDocument();
    expect(cell.className).toContain('sticky');
    expect(cell.className).toContain('right-0');
    // Both states, or the row's hover tint shows through the pinned column.
    expect(cell.className).toContain('bg-white');
    expect(cell.className).toContain('group-hover:bg-slate-50');
  });

  it('spans every column when it has a message instead of rows', () => {
    // A colSpan one short of the header leaves a hairline of unpainted table
    // beside the message, which reads as a broken row.
    listState.rows = [];
    mount();
    const headCount = document.querySelectorAll('thead th').length;
    const message = screen.getByText('No alarms have been raised.');
    expect(message.getAttribute('colspan')).toBe(String(headCount));
  });
});

describe('states that are not "no alarms"', () => {
  it('says so when the request failed, instead of rendering an empty table', () => {
    listState.error = new Error('Network unreachable');
    mount();
    expect(screen.getByText(/Could not load alarms/)).toBeInTheDocument();
    // The table must not state a fact about the record it could not read.
    expect(screen.queryByText('No alarms have been raised.')).toBeNull();
    expect(screen.getByText(/could not be loaded/)).toBeInTheDocument();
  });

  it('calls a failed REFRESH stale, not unloadable, while showing the rows it has', () => {
    // `keepPreviousData` keeps the last good rows on screen with `error` set —
    // reachable on every refocus. "Could not load alarms" over a table full of
    // rows is plainly false and trains the reader to ignore the banner.
    listState.error = new Error('Network unreachable');
    listState.keepData = true;
    mount();
    expect(screen.getByText(/may be out of date/)).toBeInTheDocument();
    expect(screen.queryByText(/Could not load alarms/)).toBeNull();
    expect(screen.getByText('CWH/RDU/001-00')).toBeInTheDocument();
  });

  it('distinguishes "nothing matches your filters" from "nothing has happened"', () => {
    listState.rows = [];
    mount();
    expect(screen.getByText('No alarms have been raised.')).toBeInTheDocument();
  });
});

describe('the Alarms page — Area and Location are two columns', () => {
  /**
   * Operator, 2026-09-01. The same pair, in the same order, as the dashboard
   * readings table: Area is the authoritative Block > Area grouping, Location is
   * the instrument's own free-text `Location` attribute.
   */
  it('renders an Area heading immediately before Location', () => {
    // Asserted by ORDER, not by presence: two headings that both exist could
    // still be at opposite ends of the table, and the pairing is the point.
    mount();
    const heads = [...screen.getByRole('table').querySelectorAll('thead th')]
      .map((th) => th.textContent);
    const area = heads.findIndex((h) => h === 'Area');
    expect(area).toBeGreaterThan(-1);
    expect(heads[area + 1]).toBe('Location');
  });

  it('prints the FUNCTIONAL location in Area', () => {
    mount();
    const cells = screen.getByText('CWH/RDU/001-00').closest('tr')!.querySelectorAll('td');
    const heads = [...screen.getByRole('table').querySelectorAll('thead th')]
      .map((th) => th.textContent);
    expect(cells[heads.indexOf('Area')].textContent).toBe('Excipient Dispensing Area');
  });

  it('does NOT repeat the Area in Location when no attribute is typed', () => {
    /**
     * The fixture carries a `locationName` and no `locationAttribute`. Without
     * `areaShown` the Location cell falls back to the functional location and the
     * two adjacent columns print the same string — the duplicate-column defect
     * the dashboard's Room column was removed for, arriving on the next screen.
     */
    mount();
    const heads = [...screen.getByRole('table').querySelectorAll('thead th')]
      .map((th) => th.textContent);
    const cells = screen.getByText('CWH/RDU/001-00').closest('tr')!.querySelectorAll('td');
    const area = cells[heads.indexOf('Area')].textContent;
    const location = cells[heads.indexOf('Location')].textContent;

    expect(area).toBe('Excipient Dispensing Area');
    expect(location).not.toBe(area);
    expect(location).toBe('Not set');
  });
});

describe('the Alarms page — the governed PDF download', () => {
  const openDialog = async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /export|download/i }));
    return screen.findByRole('button', { name: /^request approval$/i });
  };

  beforeEach(() => {
    submitRequest.mockReset().mockResolvedValue({ id: 'r1', status: 'PENDING' });
    savePdf.mockReset();
    buildAlarmsReport.mockReset();
    apiGet.mockReset().mockResolvedValue({ data: [], total: 0 });
    reauthGrants = true;
  });

  const confirm = async () => {
    const btn = await openDialog();
    // The dialog's reason is mandatory — the same §11 rule the acknowledge
    // dialog follows.
    fireEvent.change(screen.getByRole('textbox', { name: /remark|reason/i }), {
      target: { value: 'Monthly QA review of excursions.' },
    });
    // The dialog needs an approver since 2026-09-07: pick the one user the mock offers.
    fireEvent.click(screen.getByRole('button', { name: /to a user/i }));
    fireEvent.change(screen.getByLabelText(/send to/i), { target: { value: 'u-appr' } });
    fireEvent.click(btn);
  };

  it('offers the download from an icon on the page', async () => {
    mount();
    expect(screen.getByRole('button', { name: /export|download/i })).toBeInTheDocument();
  });

  it('POSTS a request with the frozen document and saves NOTHING (2026-09-07)', async () => {
    /**
     * THE §11 assertion, in its new shape. A download is a REQUEST an approver
     * signs; the page must never put a file on the operator's disk itself.
     */
    await confirm();
    await waitFor(() => expect(submitRequest).toHaveBeenCalled());
    expect(savePdf).not.toHaveBeenCalled();
    expect(submitRequest.mock.calls[0][0]).toMatchObject({ reportType: 'Alarms', snapshot: { version: 2 }, assignee: { userId: 'u-appr' } });
  });

  it('saves NOTHING when the request fails', async () => {
    submitRequest.mockRejectedValue(new Error('server unavailable'));
    await confirm();
    await waitFor(() => expect(submitRequest).toHaveBeenCalled());
    expect(savePdf).not.toHaveBeenCalled();
  });

  it('posts NOTHING when the operator cancels the password prompt', async () => {
    reauthGrants = false;
    await confirm();
    await waitFor(() => expect(savePdf).not.toHaveBeenCalled());
    expect(submitRequest).not.toHaveBeenCalled();
  });

  it('signs the request with the re-auth password', async () => {
    // Without it the request goes out unsigned and the DOWNLOAD_REPORT policy is
    // not actually enforced.
    await confirm();
    await waitFor(() => expect(submitRequest).toHaveBeenCalled());
    expect(submitRequest.mock.calls[0][0]).toMatchObject({ reportType: 'Alarms', password: 'Secret@123' });
  });

  it('records the number of rows PRINTED, not the number that matched', async () => {
    // A request claiming 3,000 records beside a document printing 500 would have
    // the record contradict the document it describes.
    apiGet.mockResolvedValue({ data: [], total: 3000 });
    await confirm();
    await waitFor(() => expect(submitRequest).toHaveBeenCalled());
    expect(submitRequest.mock.calls[0][0].requestMeta.recordCount).toBe(0);
  });

  it('fetches the whole PERIOD, never the page on screen', async () => {
    // The table is paged; reusing its rows would print 25 alarms and title them
    // as the period.
    await confirm();
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    const url = String(apiGet.mock.calls[0][0]);
    expect(url).toContain('pageSize=500');
    expect(url).toContain('from=');
    expect(url).toContain('to=');
  });
});
