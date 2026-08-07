import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TokenPanel } from '../token-panel';

const base = {
  code: 'T-1',
  tokenPrefix: 'ABCD1234',
  tokenRevealable: true,
  canEdit: true,
  token: null as string | null,
  onHide: () => {},
  onReveal: () => {},
  onSetToken: async () => {},
  onRegenerate: () => {},
};

describe('TokenPanel', () => {
  it('offers the eye when the credential is recoverable', () => {
    render(<TokenPanel {...base} />);
    expect(screen.getByRole('button', { name: /show token/i })).toBeInTheDocument();
    // The audit consequence is stated BEFORE the operator commits, not after —
    // it is the control the D5 reversal was granted on, so it has to be visible.
    expect(screen.getByText(/records the view in the audit trail/i)).toBeInTheDocument();
  });

  /**
   * The whole point of `tokenRevealable`: a legacy credential (issued before
   * the ciphertext column) or a server with no INSTRUMENT_TOKEN_KEY can only
   * answer a reveal with an error. Rendering the button anyway would spend the
   * operator's password to reach it.
   */
  it('hides Reveal and offers Regenerate for a credential that cannot be shown', async () => {
    const onRegenerate = vi.fn();
    render(<TokenPanel {...base} tokenRevealable={false} onRegenerate={onRegenerate} />);
    expect(screen.queryByRole('button', { name: /show token/i })).not.toBeInTheDocument();
    expect(screen.getByText(/cannot be shown/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /regenerate token/i }));
    // waitFor, not a bare assertion: the click runs through the panel's async
    // busy wrapper, so settling it here is what keeps React's act() warning off
    // the console rather than letting the state update land after the test.
    await waitFor(() => expect(onRegenerate).toHaveBeenCalled());
  });

  it('shows the value, a copy affordance and the audit note once revealed', () => {
    render(<TokenPanel {...base} token="LIVE-TOKEN-VALUE" />);
    expect(screen.getByText('LIVE-TOKEN-VALUE')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^copy$/i })).toBeInTheDocument();
    expect(screen.getByText(/recorded in the audit trail/i)).toBeInTheDocument();
    // No Reveal button while it is already on screen.
    expect(screen.queryByRole('button', { name: /show token/i })).not.toBeInTheDocument();
  });

  it('re-hides on demand', () => {
    const onHide = vi.fn();
    render(<TokenPanel {...base} token="LIVE-TOKEN-VALUE" onHide={onHide} />);
    fireEvent.click(screen.getByRole('button', { name: /hide token/i }));
    expect(onHide).toHaveBeenCalled();
  });

  /**
   * The rules have to be legible before the field is filled, not only as a
   * validation error: the value is usually transcribed from a device's config
   * sheet, and learning after the fact that it is unusable means a second trip
   * to the device.
   */
  /**
   * There is ONE token, so there is one control for it. The separate "Set a
   * specific token" panel — a second field with its own rules and its own
   * warning block, under a row that already showed the token — was removed
   * 2026-08-07. Editing happens in place, on the value being looked at.
   */
  it('edits the shown token in place, with no separate set-token panel', () => {
    render(<TokenPanel {...base} token="LIVE-TOKEN-VALUE" />);
    expect(screen.queryByRole('button', { name: /set token/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    // The field opens PRE-FILLED with the current value: this is an edit, not
    // a blank re-entry, and retyping a 43-character credential to change one
    // character is how transcription errors get into a device.
    expect(screen.getByRole('textbox', { name: /access token/i })).toHaveValue('LIVE-TOKEN-VALUE');
    expect(screen.getByText(/stops sending data/i)).toBeInTheDocument();
  });

  // You cannot edit a mask. With the token still hidden, Edit reveals first —
  // which is the password prompt and the audit row, not a UI detail.
  it('reveals first when Edit is pressed on a masked token', async () => {
    const onReveal = vi.fn(async () => {});
    render(<TokenPanel {...base} onReveal={onReveal} />);
    fireEvent.click(screen.getByRole('button', { name: /^edit…$/i }));
    await waitFor(() => expect(onReveal).toHaveBeenCalled());
  });

  it('accepts any length and any symbol', async () => {
    const onSetToken = vi.fn(async () => {});
    render(<TokenPanel {...base} token="OLD" onSetToken={onSetToken} />);
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    const field = screen.getByRole('textbox', { name: /access token/i });

    for (const value of ['a', 'a'.repeat(300), 'has spaces & symbols !@#$%^*()', 'unicode-\u00e9\u00e8-ok']) {
      fireEvent.change(field, { target: { value } });
      expect(screen.getByRole('button', { name: /save token/i })).toBeEnabled();
    }
  });

  // A line break cannot reach this control at all: a single-line `<input>`
  // strips CR/LF from typed and pasted values alike (verified in jsdom, which
  // matches browsers). The server rule that refuses one is asserted in
  // `packages/shared` where it is enforced, not mocked here.
  it('cannot carry a line break through the field', () => {
    render(<TokenPanel {...base} token="OLD" />);
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    const field = screen.getByRole('textbox', { name: /access token/i });
    fireEvent.change(field, { target: { value: 'abc\ndef' } });
    expect(field).toHaveValue('abcdef');
  });

  /**
   * A short token is now ALLOWED (operator decision) but it is fully disclosed
   * by `token_prefix`, which the INSTRUMENT_READ endpoints return — no password,
   * no audit row. Warned at the point of entry rather than refused after it.
   */
  it('warns when the token is short enough for the public prefix to expose it', () => {
    render(<TokenPanel {...base} token="OLD" />);
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    const field = screen.getByRole('textbox', { name: /access token/i });

    fireEvent.change(field, { target: { value: 'a'.repeat(8) } });
    expect(screen.getByText(/visible\s+as the non-secret prefix/i)).toBeInTheDocument();
    // Warned, NOT blocked — the operator decides.
    expect(screen.getByRole('button', { name: /save token/i })).toBeEnabled();

    fireEvent.change(field, { target: { value: 'a'.repeat(9) } });
    expect(screen.queryByText(/visible\s+as the non-secret prefix/i)).not.toBeInTheDocument();
  });

  it('submits the edited token', async () => {
    const onSetToken = vi.fn(async () => {});
    render(<TokenPanel {...base} token="OLD" onSetToken={onSetToken} />);
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    const good = 'a new credential, any symbols !@#';
    fireEvent.change(screen.getByRole('textbox', { name: /access token/i }), { target: { value: good } });
    fireEvent.click(screen.getByRole('button', { name: /save token/i }));
    await waitFor(() => expect(onSetToken).toHaveBeenCalledWith(good));
  });

  it('offers nothing mutable without instruments.edit', () => {
    render(<TokenPanel {...base} canEdit={false} />);
    expect(screen.queryByRole('button', { name: /show token/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^edit/i })).not.toBeInTheDocument();
    expect(screen.getByText(/do not have permission/i)).toBeInTheDocument();
  });
});
