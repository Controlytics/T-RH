import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';

/**
 * A sensor offset (2026-10-01) is typed with a + / - choice beside the number
 * — "+ adds, - decreases" — and only a SUPER_ADMIN gets that box (every other
 * role never sees an offset key at all). The swr mock returns module-level
 * constants: a fresh object per call re-runs effects forever.
 */
const SA = { role: 'SUPER_ADMIN' };
const OP = { role: 'OPERATOR' };
// The SERVER names the offset keys (2026-10-26), folded — every profile's.
const OFFSET_KEYS = { keys: ['humid off set', 'temp off set'] };
let me: unknown = SA;
vi.mock('swr', () => ({
  default: (key: string | null) => ({ data: key === '/api/auth/me' ? me : key === '/api/instruments/offset-keys' ? OFFSET_KEYS : undefined }),
}));

const { AttributeValueInput, splitOffset } = await import('../attribute-value-input');

function Harness({ attrKey, initial = '', onValue }: { attrKey: string; initial?: string; onValue: (v: string) => void }) {
  const [v, setV] = useState(initial);
  return <AttributeValueInput attrKey={attrKey} value={v} ariaLabel={attrKey} onChange={(n) => { setV(n); onValue(n); }} />;
}

beforeEach(() => { me = SA; sessionStorage.setItem('access_token', 't'); });

describe('AttributeValueInput', () => {
  it('a SUPER_ADMIN gets the + / - choice for an offset key; + adds, - subtracts', () => {
    const onValue = vi.fn();
    render(<Harness attrKey="Temp Off set" onValue={onValue} />);
    expect(screen.getByTestId('offset-input')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Temp Off set'), { target: { value: '2' } });
    expect(onValue).toHaveBeenLastCalledWith('+2');
    fireEvent.change(screen.getByLabelText('Temp Off set — add or subtract'), { target: { value: '-' } });
    expect(onValue).toHaveBeenLastCalledWith('-2');
  });

  it('shows a stored value as its sign and magnitude', () => {
    render(<Harness attrKey="humid off set" initial="-1.5" onValue={vi.fn()} />);
    expect((screen.getByLabelText('humid off set — add or subtract') as HTMLSelectElement).value).toBe('-');
    expect((screen.getByLabelText('humid off set') as HTMLInputElement).value).toBe('1.5');
  });

  it('every other attribute, and every other role, gets a plain text box', () => {
    render(<Harness attrKey="Location" onValue={vi.fn()} />);
    expect(screen.queryByTestId('offset-input')).toBeNull();
    me = OP;
    render(<Harness attrKey="Temp Off set" onValue={vi.fn()} />);
    expect(screen.queryAllByTestId('offset-input')).toHaveLength(0);
  });

  it('splitOffset: no sign means +', () => {
    expect(splitOffset('2')).toEqual({ sign: '+', magnitude: '2' });
    expect(splitOffset('+0.5')).toEqual({ sign: '+', magnitude: '0.5' });
    expect(splitOffset('-3')).toEqual({ sign: '-', magnitude: '3' });
  });
});
