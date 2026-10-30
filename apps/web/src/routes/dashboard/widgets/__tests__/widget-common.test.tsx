import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../use-widget-data', () => ({}));

import { REFRESH_FAILED, WidgetNotes, answerState, keyColorSlots, refreshFailedText } from '../widget-common';

describe('WidgetNotes — ONE note row for every widget (fix round 1, m-6)', () => {
  it('says nothing when there is nothing to say', () => {
    const { container } = render(<WidgetNotes cap={{ shown: 3, total: 3, noun: 'gauges' }} unsent={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('the cap, the keys with no readings and a failed refresh share ONE wrapping row, in that order', () => {
    render(<WidgetNotes cap={{ shown: 50, total: 57, noun: 'instruments' }} unsent={['Voltage', 'Power']} refreshFailed />);
    const row = screen.getByTestId('widget-notes');
    expect([...row.children].map((c) => c.getAttribute('data-testid'))).toEqual(['widget-cap-note', 'widget-no-readings', 'widget-refresh-failed']);
    expect(row.className.split(/\s+/)).toEqual(expect.arrayContaining(['flex', 'flex-wrap']));
    expect(screen.getByTestId('widget-cap-note').textContent).toBe('Showing 50 of 57 instruments');
    expect(screen.getByTestId('widget-no-readings').textContent).toBe('No readings for Voltage, Power');
    expect(screen.getByTestId('widget-refresh-failed').textContent).toBe(REFRESH_FAILED);
  });

  it('tiles beyond a cap are said as "N more not shown", on the same row', () => {
    render(<WidgetNotes more={200} refreshFailed />);
    const row = screen.getByTestId('widget-notes');
    expect([...row.children].map((c) => c.getAttribute('data-testid'))).toEqual(['widget-more-note', 'widget-refresh-failed']);
    expect(screen.getByTestId('widget-more-note').textContent).toBe('200 more not shown');
  });

  it('M-6: the count beside "more not shown" is grouped like every other count on these widgets', () => {
    render(<WidgetNotes more={1380} />);
    expect(screen.getByTestId('widget-more-note').textContent).toBe(`${(1380).toLocaleString()} more not shown`);
    expect(screen.getByTestId('widget-more-note').textContent).not.toBe('1380 more not shown');
  });

  it('M-2: a failed refresh names what could not be refreshed — readings by default, alarms on the alarm widgets', () => {
    const { unmount } = render(<WidgetNotes refreshFailed />);
    expect(screen.getByTestId('widget-refresh-failed').textContent).toBe(REFRESH_FAILED);
    unmount();
    render(<WidgetNotes refreshFailed refreshNoun="alarms" />);
    expect(screen.getByTestId('widget-refresh-failed').textContent)
      .toBe('These alarms could not be refreshed. Showing the last ones that loaded.');
    expect(refreshFailedText('alarms')).not.toContain('readings');
  });

  it('none hidden says nothing', () => {
    const { container } = render(<WidgetNotes more={0} />);
    expect(container.innerHTML).toBe('');
  });

  it("a failed refresh is said in the trend page's own words", () => {
    expect(REFRESH_FAILED).toBe('These readings could not be refreshed. Showing the last ones that loaded.');
  });
});

describe('answerState — what a present-state widget draws from a polled answer', () => {
  const refused = Object.assign(new Error('HTTP 403'), { status: 403 });
  const down = Object.assign(new Error('HTTP 502'), { status: 502 });
  it('an answer and no failure is drawn', () => expect(answerState(true, undefined)).toBe('fresh'));
  it('nothing yet, nothing failed', () => expect(answerState(false, undefined)).toBe('none'));
  it('a failed refresh keeps the answer it holds, and says so', () => expect(answerState(true, down)).toBe('stale'));
  it('a refusal never keeps what it holds', () => expect(answerState(true, refused)).toBe('failed'));
  it('a failure with nothing held is a failure', () => {
    expect(answerState(false, down)).toBe('failed');
    expect(answerState(false, refused)).toBe('failed');
  });
});

describe('keyColorSlots — no two keys share a colour by accident (fix round 1, m-7)', () => {
  it('keys without a colour take the slots in key order', () => {
    expect(keyColorSlots([{}, {}, {}])).toEqual([0, 1, 2]);
  });

  it('a chosen colour is kept, and the keys without one take the slots NOT chosen — never a collision', () => {
    // Before: [0, 0] — the first key's default slot was the second key's choice.
    expect(keyColorSlots([{}, { color: 0 }])).toEqual([1, 0]);
    expect(keyColorSlots([{ color: 1 }, {}, {}])).toEqual([1, 0, 2]);
    expect(keyColorSlots([{}, { color: 2 }, {}, { color: 0 }])).toEqual([1, 2, 3, 0]);
  });

  it('two keys given the SAME colour keep it — that is their owner\'s choice', () => {
    expect(keyColorSlots([{ color: 3 }, { color: 3 }, {}])).toEqual([3, 3, 0]);
  });

  it('more keys than free slots: the rest wrap round the palette rather than leave it', () => {
    const slots = keyColorSlots([{ color: 0 }, {}, {}, {}, {}, {}, {}]);
    expect(slots.slice(0, 6)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(slots[6]).toBeGreaterThanOrEqual(0);
    expect(slots[6]).toBeLessThan(6);
  });
});
