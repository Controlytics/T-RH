import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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
 * 3. **The status pill is keyed off the four STATES, not off severity.** Every
 *    alarm on this installation is CRITICAL, so a severity-keyed pill rendered
 *    red on every row regardless of whether anyone had answered for it.
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
  roomLabel: null,
  metric: 'TEMPERATURE',
  triggeredValue: 28,
  severity: 'CRITICAL',
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
    return { data: undefined, isLoading: false, mutate: vi.fn() };
  },
}));

vi.mock('@/hooks/use-can', () => ({ useCan: () => () => true }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }) }));

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
  it('names where the alarm happened', () => {
    mount();
    expect(screen.getByText('Excipient Dispensing Area')).toBeInTheDocument();
  });

  it('carries the unit on the reading, since one column holds both metrics', () => {
    mount();
    const row = screen.getByText('CWH/RDU/001-00').closest('tr')!;
    expect(within(row).getByText('°C')).toBeInTheDocument();
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
    // Both rows are CRITICAL. While the pill was keyed off severity these two
    // were the same colour, so the page could not distinguish "nobody has
    // answered this yet" from "the excursion ended and nobody answered".
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
