import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { OverviewRow } from '../use-telemetry';

/**
 * The dashboard's tabular view, and specifically its TWO PLACEMENT COLUMNS.
 *
 * Area and Location are two DIFFERENT facts about where an instrument is (root
 * CLAUDE.md, "Instrument grouping — THREE concepts"), and the pressure on this
 * table will always be to collapse them into one. These tests say which is which:
 *
 *   Area     — `functionalLocationName`, the authoritative Block > Area grouping.
 *   Location — `locationAttribute`, the instrument's own `Location` ATTRIBUTE.
 *              **Never `Instrument.location`**, the superseded column of the same
 *              name; the server resolves the attribute and this row carries no
 *              attribute list to re-derive it from.
 *
 * The third concept, the drawn ROOM, had a column for three days and lost it on
 * 2026-09-01 (operator). It was a duplicate: the cell's primary text was the
 * instrument's `name`, which on this installation equals the `Location` attribute
 * on 100 of the 100 instruments carrying one. The room stays SEARCHABLE and is
 * still the graphical view's whole subject — it is the COLUMN that went.
 *
 * Both new fields are resolved SERVER-side. Whether they survive Fastify's
 * response filter is a different question and cannot be asked from here — that
 * is `src/e2e/telemetry-overview.e2e.test.ts`, over the wire.
 */

const row: OverviewRow = {
  instrumentId: 'i-1',
  code: 'CWH/RDU/001-00',
  name: 'RDU Sensor',
  isActive: true,
  room: { id: 'r-1', code: 'ROOM-9', label: 'Cooling Room', floorplanId: 'f-1' },
  functionalLocationName: 'Raw Material Store',
  locationAttribute: 'Dissolution & UV Room',
  limits: { tempMin: 18, tempMax: 25, rhMin: 40, rhMax: 60 },
  limitSource: 'INSTRUMENT',
  temperature: { key: 'temperature', value: 22.4, ts: '2026-09-01T10:00:00.000Z' },
  humidity: { key: 'humidity', value: 47, ts: '2026-09-01T10:00:00.000Z' },
  decimals: { temperature: 1, humidity: 1 },
  reporting: true,
  status: 'OK',
};

/** Neither placement fact set — both are normal states, and both need a WORD. */
const bare: OverviewRow = {
  ...row,
  instrumentId: 'i-2',
  code: 'CWH/RDU/002-00',
  room: null,
  functionalLocationName: null,
  locationAttribute: null,
};

let rows: OverviewRow[] = [row];

vi.mock('../use-telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../use-telemetry')>()),
  useTelemetryOverview: () => ({ rows, isLoading: false, error: undefined }),
}));

vi.mock('@/hooks/use-failure-text', () => ({
  useSensorWords: () => ({ failure: 'Error', outOfRange: 'OL' }),
}));

const { TelemetryTable, columnWidthTotal } = await import('../telemetry-table');

function renderWith(data: OverviewRow[] = [row]) {
  rows = data;
  return render(<MemoryRouter><TelemetryTable /></MemoryRouter>);
}

describe('TelemetryTable — the Area and Location columns', () => {
  it('renders both headings', () => {
    const { container } = renderWith();
    const head = within(container.querySelector('thead')!);
    expect(head.getByText('Area')).toBeInTheDocument();
    expect(head.getByText('Location')).toBeInTheDocument();
  });

  it('has NO Room column, under that name or the old "Location / Room"', () => {
    // Removed 2026-09-01 (operator): a duplicate of Location, since the cell's
    // primary text was the instrument `name` and that equals the `Location`
    // attribute on every instrument here that carries one.
    const head = within(renderWith().container.querySelector('thead')!);
    expect(head.queryByText('Room')).toBeNull();
    expect(head.queryByText('Location / Room')).toBeNull();
  });

  it('does not print the instrument NAME in the row at all', () => {
    // The name was only ever on screen as that column's primary text. This is
    // the assertion that fails if the cell is reinstated somewhere else, which a
    // heading query alone would not catch.
    const { container } = renderWith();
    expect(container.querySelector('tbody')!.textContent).not.toContain('RDU Sensor');
  });

  it('shows the FUNCTIONAL location name in Area and the ATTRIBUTE in Location', () => {
    const { container } = renderWith();
    const cells = container.querySelectorAll('tbody tr td');
    // Column order is Instrument ID, Area, Location, … — asserted by POSITION,
    // because both cells hold plain text and a text query alone would pass with
    // the two swapped.
    expect(cells[1].textContent).toContain('Raw Material Store');
    expect(cells[2].textContent).toContain('Dissolution & UV Room');
    // And the column after Location is a READING, not a third placement cell.
    expect(cells[3].textContent).not.toContain('RDU Sensor');
  });

  it('still SEARCHES the room, though no column shows it', () => {
    // Matching more than is shown costs the caller nothing and can only return
    // rows they could already see; dropping it would silently stop a plan code
    // someone typed from finding anything.
    const { container } = renderWith();
    fireEvent.change(screen.getByPlaceholderText(/Filter by instrument/i), {
      target: { value: 'ROOM-9' },
    });
    expect(container.querySelectorAll('tbody tr').length).toBe(1);
  });

  it('says "Unassigned" and "Not set" rather than leaving the cells blank', () => {
    // Two DIFFERENT absences, worded differently on purpose: no functional
    // location, versus nobody having typed a placement. A blank reads as a
    // rendering fault in both cases. "Unassigned" is the same word
    // `locationText()` prints on the Alarms page for the same state.
    const { container } = renderWith([bare]);
    const cells = container.querySelectorAll('tbody tr td');
    expect(cells[1].textContent).toContain('Unassigned');
    expect(cells[2].textContent).toContain('Not set');
  });

  it('renders both when a cached row predates the fields, without throwing', () => {
    // Both are optional on the client interface precisely so an SWR entry cached
    // before they existed still renders.
    const stale = { ...row } as Partial<OverviewRow>;
    delete stale.functionalLocationName;
    delete stale.locationAttribute;
    const { container } = renderWith([stale as OverviewRow]);
    const cells = container.querySelectorAll('tbody tr td');
    expect(cells[1].textContent).toContain('Unassigned');
    expect(cells[2].textContent).toContain('Not set');
  });
});

describe('TelemetryTable — the search matches every visible text column', () => {
  const search = () => screen.getByPlaceholderText(/filter by instrument/i);

  /**
   * Assert on the CONTENT, never on the row COUNT.
   *
   * A search that matches nothing still renders exactly one `<tr>` — the
   * "No instruments match that filter." message — so `rows.length === 1` is
   * satisfied by a working search and by a search that matches nothing at all.
   * The first version of these two tests counted rows and PASSED with
   * `locationAttribute` deleted from the predicate; that is the whole reason
   * they now name the row they expect and the message they do not.
   */
  function expectOnly(container: HTMLElement, present: string, absent: string) {
    const body = container.querySelector('tbody')!;
    expect(body.textContent).toContain(present);
    expect(body.textContent).not.toContain(absent);
    expect(body.textContent).not.toContain('No instruments match that filter.');
  }

  it('finds a row by its AREA', () => {
    const { container } = renderWith([row, bare]);
    fireEvent.change(search(), { target: { value: 'raw material' } });
    expectOnly(container, 'CWH/RDU/001-00', 'CWH/RDU/002-00');
  });

  it('finds a row by its LOCATION attribute', () => {
    const { container } = renderWith([row, bare]);
    fireEvent.change(search(), { target: { value: 'dissolution' } });
    expectOnly(container, 'CWH/RDU/001-00', 'CWH/RDU/002-00');
  });

  it('still finds a row by its code, and still excludes non-matches', () => {
    const { container } = renderWith([row, bare]);
    fireEvent.change(search(), { target: { value: '002' } });
    expectOnly(container, 'CWH/RDU/002-00', 'CWH/RDU/001-00');
  });

  it('says so when nothing matches, rather than showing an empty table', () => {
    // The positive control for `expectOnly` above: this is the state those
    // tests would otherwise have accepted as a successful search.
    const { container } = renderWith([row, bare]);
    fireEvent.change(search(), { target: { value: 'no such place' } });
    expect(container.querySelector('tbody')!.textContent).toContain('No instruments match that filter.');
  });

  it('names what it matches — a visible column the box ignores reads as a bug', () => {
    renderWith();
    const placeholder = search().getAttribute('placeholder') ?? '';
    expect(placeholder.toLowerCase()).toContain('area');
    expect(placeholder.toLowerCase()).toContain('location');
  });
});

describe('TelemetryTable — the hand-balanced column widths', () => {
  it('still total exactly 100%', () => {
    // The <colgroup> is generated from COLUMN_GROUPS so it cannot drift from the
    // headers, but the PERCENTAGES are hand-set. A column added without
    // rebalancing overflows silently — `table-fixed` scales everything down, so
    // nothing looks broken while every reading column gets narrower.
    expect(columnWidthTotal()).toBe(100);
  });

  it('counts a grouped column once per SUB-column', () => {
    // Temperature and Humidity each render two columns (Actual / Set Point) from
    // one entry, so a sum that counted entries would read 16 points light and
    // call an overflowing table balanced.
    expect(columnWidthTotal([
      { key: 'a', label: 'A', width: '50%', head: 'x' },
      { key: 'b', label: 'B', width: '25%', head: 'x', sub: ['Actual', 'Set Point'] },
    ])).toBe(100);
  });
});

describe('TelemetryTable — readings and set points are highlighted chips (2026-09-25)', () => {
  // Operator: "temperature and humidity values and ranges should be visible
  // like highlighted". Each reading and each set point sits in a `.tv-chip`
  // pill tinted from the cell's own ink; a slot with NO reading prints a plain
  // grey NA (`tv-val-na`) and no chip — a green pill around nothing would claim
  // a reading that was never taken.
  it('wraps both readings in a chip and draws both set points as range badges', () => {
    const { container } = renderWith([row]);
    const chips = Array.from(container.querySelectorAll('td .tv-chip')).map((c) => c.textContent);
    expect(chips).toEqual(['22.4°C', '47.0%']);
    // The badge: two figures and a bar, in the column's hue; the accessible
    // name is still formatSetPoint's string.
    const badges = Array.from(container.querySelectorAll('td.tv-spec .tv-range'));
    expect(badges.map((b) => b.getAttribute('aria-label'))).toEqual(['18.0 - 25.0', '40.0 - 60.0']);
    expect(badges[0].className).toMatch(/(^|\s)tv-range-temp(\s|$)/);
    expect(badges[1].className).toMatch(/(^|\s)tv-range-rh(\s|$)/);
    expect(badges[0].querySelectorAll('.tv-range-v')).toHaveLength(2);
    expect(badges[0].querySelector('.tv-range-sep')).not.toBeNull();
  });

  it('prints a lone bound with its keyword, and a plain NA with no badge for none', () => {
    const silent: OverviewRow = { ...row, instrumentId: 'i-3', code: 'CWH/RDU/003-00', temperature: null, limits: { tempMin: null, tempMax: null, rhMin: null, rhMax: 60 } };
    const { container } = renderWith([silent]);
    const tempCell = container.querySelector('td.tv-val-na');
    expect(tempCell).not.toBeNull();
    expect(tempCell?.textContent).toBe('NA');
    expect(tempCell?.querySelector('.tv-chip')).toBeNull();
    // Humidity: one bound → NMT keyword + one figure, no bar.
    const badges = Array.from(container.querySelectorAll('td.tv-spec .tv-range'));
    expect(badges).toHaveLength(1);
    expect(badges[0].getAttribute('aria-label')).toBe('NMT 60.0');
    expect(badges[0].querySelector('.tv-range-k')?.textContent).toBe('NMT');
    expect(badges[0].querySelector('.tv-range-sep')).toBeNull();
    // Temperature set point: no bound → bare NA, no badge.
    const specCells = Array.from(container.querySelectorAll('td.tv-spec'));
    expect(specCells[0].textContent).toBe('NA');
    expect(specCells[0].querySelector('.tv-range')).toBeNull();
  });
});
