import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { AlarmAckDialog } from '../alarm-ack-dialog';
import type { AlarmRow } from '../alarm-shared';

/**
 * The two 409 codes mean different things to an operator and must never be
 * collapsed: ALREADY_ACKNOWLEDGED says someone else signed it, ALARM_STATE_CHANGED
 * says nothing was signed and the excursion may be live again. Reporting the
 * first when the second happened sends an operator away from a live alarm.
 *
 * These tests exist because the first cut of this dialog closed itself on both
 * codes — `onStale` unmounted the component on the same commit that set the
 * error, so NEITHER message ever rendered and the two were indistinguishable on
 * screen. tsc and the rest of the suite were green throughout: nothing here is
 * a type error, and there were no component tests. Asserting on the rendered
 * text is the only thing that catches it.
 */

const postWithReauth = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiClient: { postWithReauth: (...args: unknown[]) => postWithReauth(...args) },
}));

const ALARM: AlarmRow = {
  id: 'alarm-1', instrumentId: 'inst-1', key: 'temp', thresholdId: 'thr-1',
  severity: 'CRITICAL', state: 'ACTIVE',
  firstBreachAt: '2026-08-03T10:00:00.000Z', lastBreachAt: '2026-08-03T10:05:00.000Z',
  breachCount: 3, triggerValue: 105, peakValue: 106,
  resolvedAt: null, ackedBy: null, ackedAt: null, ackReason: null, closedAt: null,
  instrument: { id: 'inst-1', name: 'Chamber Probe', code: 'CP-01' },
  threshold: { id: 'thr-1', operator: 'GT', limit: 100, limitLow: null, limitHigh: null },
};

/** Rejects the way api-client does: an Error carrying `.code` from the body. */
function apiError(code: string, message: string) {
  const err = new Error(message);
  (err as Error & { code?: string; status?: number }).code = code;
  (err as Error & { code?: string; status?: number }).status = 409;
  return err;
}

function renderDialog(overrides: Partial<Parameters<typeof AlarmAckDialog>[0]> = {}) {
  const props = {
    alarm: ALARM,
    onClose: vi.fn(),
    onAcknowledged: vi.fn(),
    onRefreshRequested: vi.fn(),
    ...overrides,
  };
  render(<AlarmAckDialog {...props} />);
  return props;
}

// fireEvent rather than user-event: `@testing-library/user-event` is not a
// dependency of this app and a test is not a reason to add one.
function setReason(value: string) {
  fireEvent.change(screen.getByRole('textbox'), { target: { value } });
}
function setPassword(value: string) {
  fireEvent.change(document.querySelector('input[type="password"]')!, { target: { value } });
}

/** Fills reason + password and clicks submit. */
function sign() {
  setReason('Excursion reviewed, product unaffected.');
  setPassword('Admin@123');
  fireEvent.click(screen.getByRole('button', { name: /sign and acknowledge/i }));
}

beforeEach(() => { postWithReauth.mockReset(); });

describe('AlarmAckDialog', () => {
  it('keeps submit disabled until the reason is non-empty after trimming', () => {
    renderDialog();
    const submit = screen.getByRole('button', { name: /sign and acknowledge/i });
    expect(submit).toBeDisabled();

    // Whitespace is not a reason — the signed record must not be blank.
    setReason('   ');
    setPassword('Admin@123');
    expect(submit).toBeDisabled();

    setReason('Reviewed.');
    expect(submit).toBeEnabled();
  });

  it('shows the facts being signed against', () => {
    renderDialog();
    expect(screen.getByText('Chamber Probe', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();     // breach count
    expect(screen.getByText('106')).toBeInTheDocument();   // peak value
  });

  it('posts the password as the always-on e-signature', async () => {
    postWithReauth.mockResolvedValue({});
    const props = renderDialog();
    sign();

    await waitFor(() => expect(postWithReauth).toHaveBeenCalledTimes(1));
    expect(postWithReauth).toHaveBeenCalledWith(
      '/api/alarms/alarm-1/acknowledge',
      { reason: 'Excursion reviewed, product unaffected.' },
      'Admin@123',
    );
    expect(props.onAcknowledged).toHaveBeenCalled();
  });

  it('ALREADY_ACKNOWLEDGED renders its own message and stays open', async () => {
    postWithReauth.mockRejectedValue(
      apiError('ALREADY_ACKNOWLEDGED', 'Alarm is CLOSED and cannot be acknowledged again.'),
    );
    const props = renderDialog();
    sign();

    await waitFor(() => {
      expect(screen.getByText(/already been acknowledged/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/someone else signed it first/i)).toBeInTheDocument();
    // Must NOT claim the alarm changed state — that is the other code.
    expect(screen.queryByText(/re-breached/i)).not.toBeInTheDocument();

    // The caller refreshes the queue but must not close the dialog, or the
    // message above is unmounted before it can be read.
    expect(props.onRefreshRequested).toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('ALARM_STATE_CHANGED renders a DIFFERENT message and stays open', async () => {
    postWithReauth.mockRejectedValue(
      apiError('ALARM_STATE_CHANGED', 'Alarm was ACTIVE when read and is now RESOLVED_UNACKED.'),
    );
    const props = renderDialog();
    sign();

    await waitFor(() => {
      expect(screen.getByText(/changed state while you were signing/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/nothing was signed/i)).toBeInTheDocument();
    // Must NOT tell the operator someone already signed it — the excursion may
    // be live again and that message would send them away from it.
    expect(screen.queryByText(/already been acknowledged/i)).not.toBeInTheDocument();

    expect(props.onRefreshRequested).toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('blocks re-submitting after a 409 — the snapshot it signs against is stale', async () => {
    postWithReauth.mockRejectedValue(apiError('ALARM_STATE_CHANGED', 'changed'));
    renderDialog();
    sign();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /sign and acknowledge/i })).toBeDisabled();
    });
    // Dismiss relabels: there is no longer a pending action to cancel.
    expect(screen.getByRole('button', { name: /^close$/i })).toBeInTheDocument();
    expect(postWithReauth).toHaveBeenCalledTimes(1);
  });

  it('a rejected password stays open, clears the field and allows a retry', async () => {
    postWithReauth.mockRejectedValue(apiError('REAUTH_FAILED', 'Invalid password'));
    const props = renderDialog();
    sign();

    await waitFor(() => {
      expect(screen.getByText(/password was not accepted/i)).toBeInTheDocument();
    });
    expect(document.querySelector('input[type="password"]')).toHaveValue('');
    // A wrong password is not a stale read — retrying must remain possible.
    expect(props.onRefreshRequested).not.toHaveBeenCalled();
  });
});
