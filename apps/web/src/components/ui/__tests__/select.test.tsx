import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Select } from '../select';

/**
 * The native select primitive. Found 2026-10-03 when the first `Select` was
 * placed on the hero band (Settings: Block / Area) and rendered DARK with
 * its white border: `cn()` runs tailwind-merge, which read the chevron's
 * untyped `bg-[right_0.6rem_center]` as a background COLOUR and dropped the
 * `bg-white` before it as a duplicate. Every Select in the app had been
 * transparent since the chevron landed; on a white card that is invisible.
 * The position is type-hinted now, and this test reads the FINAL class
 * string — the one tailwind-merge emits — for both tokens at every size.
 */
const token = (cls: string, t: string) => new RegExp(`(^|\\s)${t.replace(/[[\]().*+?^$|/\\]/g, '\\$&')}(\\s|$)`).test(cls);

describe('Select', () => {
  it.each(['sm', 'md', 'lg'] as const)('keeps its white background AND the chevron position after tailwind-merge (%s)', (size) => {
    render(<Select aria-label="Pick" selectSize={size}><option>a</option></Select>);
    const cls = screen.getByRole('combobox', { name: 'Pick' }).className;
    expect(token(cls, 'bg-white')).toBe(true);
    expect(/(^|\s)bg-\[position:right_[0-9.]+rem_center\](\s|$)/.test(cls)).toBe(true);
    expect(token(cls, 'text-slate-800')).toBe(true);
  });

  it('a caller may still override the background, which is the one thing merge is for', () => {
    render(<Select aria-label="Pick" className="bg-slate-50"><option>a</option></Select>);
    const cls = screen.getByRole('combobox', { name: 'Pick' }).className;
    expect(token(cls, 'bg-slate-50')).toBe(true);
    expect(token(cls, 'bg-white')).toBe(false);
  });
});
