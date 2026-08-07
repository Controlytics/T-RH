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
  it('states the rules and the disruption up front, not only on error', () => {
    render(<TokenPanel {...base} />);
    fireEvent.click(screen.getByRole('button', { name: /^set token$/i }));
    expect(screen.getByText(/any length over 8 characters/i)).toBeInTheDocument();
    expect(screen.getByText(/letters, digits, dot, dash and underscore only/i)).toBeInTheDocument();
    // The prefix reason is stated, not just the number — "longer than 8" reads
    // as arbitrary until the operator knows the first 8 are shown to viewers.
    expect(screen.getByText(/non-secret prefix to anyone who can view/i)).toBeInTheDocument();
    expect(screen.getByText(/stops sending data/i)).toBeInTheDocument();
  });

  it('accepts lengths the old 32–128 bounds refused', async () => {
    // The point of the 2026-08-06 removal: a credential fixed in a device's
    // firmware is not negotiable, so neither bound may come back.
    const onSetToken = vi.fn(async () => {});
    render(<TokenPanel {...base} onSetToken={onSetToken} />);
    fireEvent.click(screen.getByRole('button', { name: /^set token$/i }));
    const field = screen.getByPlaceholderText(/fixed in firmware/i);

    fireEvent.change(field, { target: { value: 'DEV-KEY-01234' } });   // 13 — under the old floor
    expect(screen.getByRole('button', { name: /save token/i })).toBeEnabled();

    fireEvent.change(field, { target: { value: 'a'.repeat(300) } });   // over the old ceiling
    expect(screen.getByRole('button', { name: /save token/i })).toBeEnabled();
  });

  it('refuses a token the server would reject, without sending it', async () => {
    const onSetToken = vi.fn(async () => {});
    render(<TokenPanel {...base} onSetToken={onSetToken} />);
    fireEvent.click(screen.getByRole('button', { name: /^set token$/i }));
    const field = screen.getByPlaceholderText(/fixed in firmware/i);

    // Boundary-exact: EXACTLY the prefix length, where the public prefix is the
    // whole credential. A test using an obviously-tiny value would still pass
    // with the floor set one too low — which is the error that reopens the leak.
    fireEvent.change(field, { target: { value: 'a'.repeat(8) } });
    expect(screen.getByText(/whole token shows in the prefix/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save token/i })).toBeDisabled();

    // Long enough, forbidden character — a colon is the token-blob separator
    // and a slash is the MQTT topic separator, so the class is not cosmetic.
    fireEvent.change(field, { target: { value: `a:${'x'.repeat(40)}` } });
    expect(screen.getByText(/only letters, digits, dot, dash and underscore/i)).toBeInTheDocument();
    expect(onSetToken).not.toHaveBeenCalled();
  });

  it('submits a valid token', async () => {
    const onSetToken = vi.fn(async () => {});
    render(<TokenPanel {...base} onSetToken={onSetToken} />);
    fireEvent.click(screen.getByRole('button', { name: /^set token$/i }));
    const good = `DEV.${'x'.repeat(40)}`;
    fireEvent.change(screen.getByPlaceholderText(/fixed in firmware/i), { target: { value: good } });
    fireEvent.click(screen.getByRole('button', { name: /save token/i }));
    await waitFor(() => expect(onSetToken).toHaveBeenCalledWith(good));
  });

  it('offers nothing mutable without instruments.edit', () => {
    render(<TokenPanel {...base} canEdit={false} />);
    expect(screen.queryByRole('button', { name: /show token/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^set token$/i })).not.toBeInTheDocument();
    expect(screen.getByText(/do not have permission/i)).toBeInTheDocument();
  });
});
