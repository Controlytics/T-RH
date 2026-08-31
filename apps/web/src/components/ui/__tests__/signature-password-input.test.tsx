import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { SignaturePasswordInput } from '../signature-password-input';

/**
 * The four anti-autofill measures, asserted individually.
 *
 * This guards a defect with regulatory weight and NO visible symptom on the
 * surface that matters: a browser-filled password means a 21 CFR §11.200
 * signature can be executed by whoever is standing at an unlocked workstation,
 * and the field looks completely normal while it happens.
 *
 * It shipped once already. The Alarms acknowledge dialog used
 * `<input type="password" autoComplete="off">`, which Chrome ignores on
 * credential fields — it filled the password, and because the input was not
 * inside a `<form>` it also scanned the document for a username field and typed
 * the logged-in username into the page's search box.
 *
 * Each measure below defeats a DIFFERENT heuristic, so each is asserted
 * separately: a "simplification" that drops one still passes a test that only
 * checks the others.
 */

const mount = (props: Partial<Parameters<typeof SignaturePasswordInput>[0]> = {}) =>
  render(<SignaturePasswordInput value="" onChange={() => {}} autoFocus={false} {...props} />);

const field = () => document.querySelector('input') as HTMLInputElement;

describe('the password manager finds nothing to fill', () => {
  it('does NOT mount as a password field', () => {
    // The scan runs when the field appears. This is the measure that actually
    // stops the fill — the other three narrow what is left.
    mount();
    expect(field().type).toBe('text');
  });

  it('becomes a password field a tick later, so the value is still masked', async () => {
    mount();
    await waitFor(() => expect(field().type).toBe('password'));
  });

  it('does not use autocomplete="off", which Chrome ignores on credentials', () => {
    mount();
    expect(field().getAttribute('autocomplete')).toBe('one-time-code');
    expect(field().getAttribute('autocomplete')).not.toBe('off');
  });

  it('uses a name the browser has never saved a credential against', () => {
    // A stable name is a key the password manager can store against and offer
    // back. Two mounts must not share one.
    mount();
    const first = field().getAttribute('name');
    cleanup();
    mount();
    const second = field().getAttribute('name');
    expect(first).toBeTruthy();
    expect(first).not.toBe(second);
    expect(first).not.toMatch(/password/i);
  });

  it('keeps its name steady while someone types into it', async () => {
    // Regenerating the name per RENDER would change the field's identity
    // mid-keystroke, which browsers treat as a new field.
    const { rerender } = render(<SignaturePasswordInput value="a" onChange={() => {}} autoFocus={false} />);
    const before = field().getAttribute('name');
    rerender(<SignaturePasswordInput value="ab" onChange={() => {}} autoFocus={false} />);
    expect(field().getAttribute('name')).toBe(before);
  });
});

describe('the field still behaves like a password field', () => {
  it('refuses paste, copy and cut', async () => {
    // Established for e-signature passwords across this app, not new here.
    mount();
    expect(fireEvent.paste(field())).toBe(false); // false = the handler called preventDefault
    expect(fireEvent.copy(field())).toBe(false);
    expect(fireEvent.cut(field())).toBe(false);
  });

  it('can be revealed and hidden again', async () => {
    mount();
    await waitFor(() => expect(field().type).toBe('password'));
    fireEvent.click(screen.getByLabelText('Show password'));
    await waitFor(() => expect(field().type).toBe('text'));
    fireEvent.click(screen.getByLabelText('Hide password'));
    await waitFor(() => expect(field().type).toBe('password'));
  });

  it('keeps the reveal toggle out of the tab order', () => {
    // Tabbing off the password should reach the signing button, not a toggle.
    mount();
    expect(screen.getByLabelText('Show password')).toHaveAttribute('tabindex', '-1');
  });

  it('submits on Enter only when something has been typed', () => {
    const onEnter = vi.fn();
    const { rerender } = render(<SignaturePasswordInput value="" onChange={() => {}} onEnter={onEnter} autoFocus={false} />);
    const press = () => fireEvent.keyDown(field(), { key: 'Enter' });
    press();
    expect(onEnter).not.toHaveBeenCalled();
    rerender(<SignaturePasswordInput value="pw" onChange={() => {}} onEnter={onEnter} autoFocus={false} />);
    press();
    expect(onEnter).toHaveBeenCalledTimes(1);
  });
});
