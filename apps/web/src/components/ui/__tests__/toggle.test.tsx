import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Toggle } from '../toggle';

/**
 * The on/off switch used for every boolean on every dynamic config page.
 *
 * The assertions that matter are about STATE LEGIBILITY, not appearance. Green
 * for on and red for off is the operator's call, and red/green is precisely the
 * pair a colour-blind reader is most likely to lose — so this application's rule
 * is that status colour never travels alone. The switch position, the colour and
 * the word must all say the same thing, and each is asserted on its own: a change
 * that drops the word still leaves the colours passing, which is the drift these
 * tests exist to catch.
 */

const mount = (props: Partial<Parameters<typeof Toggle>[0]> = {}) =>
  render(<Toggle checked={false} onChange={() => {}} label="Raise alarms" {...props} />);

const box = () => document.querySelector('input') as HTMLInputElement;

describe('state is readable three ways', () => {
  it('says the state in words, not colour alone', () => {
    mount({ checked: true });
    expect(screen.getByText('On')).toBeInTheDocument();
    cleanup();
    mount({ checked: false });
    expect(screen.getByText('Off')).toBeInTheDocument();
  });

  it('is green when on and red when off', () => {
    // From the application's own status tokens, not raw hex, so a switch matches
    // the badges on every other screen.
    mount({ checked: true });
    expect(box().className).toContain('checked:bg-[var(--status-ok-dot)]');
    expect(screen.getByText('On').className).toContain('var(--status-ok-ink)');
    cleanup();
    mount({ checked: false });
    expect(screen.getByText('Off').className).toContain('var(--status-danger-ink)');
  });

  it('does NOT paint the state from the site theme', () => {
    // A state colour that changes with the palette stops meaning anything. The
    // focus ring still follows the theme; the track must not.
    mount({ checked: true });
    expect(box().className).not.toContain('checked:bg-[var(--theme-primary');
  });

  it('carries the switch role, so a screen reader says on/off not checked', () => {
    mount({ checked: true });
    expect(screen.getByRole('switch')).toBeInTheDocument();
  });
});

describe('it behaves like the native control it is built on', () => {
  it('reports the change', () => {
    const onChange = vi.fn();
    mount({ onChange });
    fireEvent.click(box());
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('is operable from the label, so the whole row is one hit target', () => {
    const onChange = vi.fn();
    mount({ onChange });
    fireEvent.click(screen.getByText('Raise alarms'));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('greys out rather than showing a state colour when disabled', () => {
    // A disabled control must not look like a live red warning.
    mount({ checked: false, disabled: true });
    expect(screen.getByText('Off').className).toContain('text-slate-400');
  });
});
