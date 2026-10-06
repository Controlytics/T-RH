import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

/**
 * The rejected-payloads card is the answer to "the device says it is sending
 * but nothing appears", and the answer is IN the payload — which device codes
 * it names, which shape it took. Until 2026-10-06 the cell was `max-w-xs
 * truncate`: one line of a 100-device batch showed, the rest was hidden, and
 * the operator could not read the thing the card exists to show. These pin
 * that the WHOLE payload is in the document, and that the formatted view and
 * its fallback for non-JSON text both work.
 */
vi.mock('@/hooks/use-datetime-format', () => ({
  useDatetimeFormat: () => ({ formatDate: (v: string) => v, formatTime: () => '' }),
}));

const { RejectedPayloadsCard, formatPayload } = await import('../rejected-payloads');

const devices = Array.from({ length: 100 }, (_, i) => ({
  devN: `CWH/RDU/${String(i + 1).padStart(3, '0')}-00`, t: 'NA', h: 'NA',
}));
const batch = JSON.stringify({ ts: '1791279672700', devices });

const rows = [
  { id: 'd-1', transport: 'mqtt', reason: 'Batch (devices) payload from an instrument that is not configured as a gateway', rawPayload: batch, receivedAt: '2026-10-06T09:41:37.662Z' },
  { id: 'd-2', transport: 'http', reason: 'Payload must be a JSON object', rawPayload: 'not json at all', receivedAt: '2026-10-03T06:58:33.310Z' },
  { id: 'd-3', transport: 'http', reason: 'Empty body', rawPayload: null, receivedAt: '2026-10-03T06:58:00.000Z' },
];

describe('RejectedPayloadsCard', () => {
  it('shows the whole payload in the table, not a truncated first line', () => {
    render(<RejectedPayloadsCard dead={{ data: rows, total: 3 }} />);
    const cell = screen.getByTestId('rejected-payload-d-1');
    expect(cell.textContent).toBe(batch);
    // The last device in the batch is the one a truncated cell can never show.
    expect(cell.textContent).toContain('CWH/RDU/100-00');
    expect(cell.className).not.toMatch(/truncate/);
    expect(cell.className).not.toMatch(/max-w-/);
  });

  it('prints a dash for a rejection that stored no payload', () => {
    render(<RejectedPayloadsCard dead={{ data: rows, total: 3 }} />);
    expect(screen.getByTestId('rejected-payload-d-3').textContent).toBe('—');
  });

  it('opens the payload pretty-printed, with the reason, from the Formatted button', () => {
    render(<RejectedPayloadsCard dead={{ data: rows, total: 3 }} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Formatted' })[0]);
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('Batch (devices) payload from an instrument that is not configured as a gateway');
    const pre = screen.getByTestId('rejected-payload-formatted');
    expect(pre.textContent).toBe(JSON.stringify(JSON.parse(batch), null, 2));
    expect(pre.textContent).toContain('"devN": "CWH/RDU/100-00"');
  });

  it('shows non-JSON text as it was sent', () => {
    render(<RejectedPayloadsCard dead={{ data: rows, total: 3 }} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Formatted' })[1]);
    expect(screen.getByTestId('rejected-payload-formatted').textContent).toBe('not json at all');
  });

  it('offers no Formatted button for a row with no payload', () => {
    render(<RejectedPayloadsCard dead={{ data: rows, total: 3 }} />);
    expect(screen.getAllByRole('button', { name: 'Formatted' })).toHaveLength(2);
  });

  it('says so when nothing was rejected', () => {
    render(<RejectedPayloadsCard dead={{ data: [], total: 0 }} />);
    expect(screen.getByText(/Nothing rejected/)).toBeTruthy();
  });
});

describe('formatPayload', () => {
  it('pretty-prints JSON and leaves anything else untouched', () => {
    expect(formatPayload('{"a":1,"b":[1,2]}')).toBe('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}');
    expect(formatPayload('NA')).toBe('NA');
    expect(formatPayload('{"unterminated":')).toBe('{"unterminated":');
  });
});
