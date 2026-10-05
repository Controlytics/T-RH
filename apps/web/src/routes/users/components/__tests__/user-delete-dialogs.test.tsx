import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UserActionDialog } from '../user-action-dialog';
import { UserBulkDeleteDialog } from '../user-bulk-delete-dialog';

/**
 * Regression tests for M65 — the delete dialogs described the opposite of what
 * the code does.
 *
 * `userRepository.delete` runs `tx.user.delete` (and `deleteMany` for bulk): a
 * physical row delete, cascading to sessions / password history / template +
 * entity assignments, plus an explicit userConfig wipe. The dialogs promised the
 * account was merely "disabled" and the data "retained for audit purposes" —
 * misleading consent on an irreversible action in a 21 CFR Part 11 system.
 *
 * The hard delete is authorized design, so these lock the COPY to the behaviour.
 * If someone ever makes user delete a soft delete, these should fail and be
 * rewritten — not the other way round.
 */

const deleteDialog = { type: 'delete', userId: 'u1', username: 'jdoe', fullName: 'Jane Doe' };

describe('UserActionDialog — delete copy matches the hard delete it triggers', () => {
  it('tells the admin the record is permanently deleted', () => {
    render(<UserActionDialog actionDialog={deleteDialog} onClose={() => {}} onConfirm={() => {}} />);

    expect(screen.getByText(/permanently deletes the account/i)).toBeInTheDocument();
    expect(screen.getByText(/erased from the database/i)).toBeInTheDocument();
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
  });

  it('does not claim the data is retained', () => {
    render(<UserActionDialog actionDialog={deleteDialog} onClose={() => {}} onConfirm={() => {}} />);

    expect(screen.queryByText(/data will be retained/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/permanently disable the user account/i)).not.toBeInTheDocument();
  });

  it('names what actually survives — the audit trail entry', () => {
    render(<UserActionDialog actionDialog={deleteDialog} onClose={() => {}} onConfirm={() => {}} />);

    expect(screen.getByText(/only the audit trail entry survives/i)).toBeInTheDocument();
  });

  it('points at Disable for the outcome the old copy promised', () => {
    render(<UserActionDialog actionDialog={deleteDialog} onClose={() => {}} onConfirm={() => {}} />);

    expect(screen.getByText(/use Disable instead/i)).toBeInTheDocument();
  });

  // Disable is a real, separate, reversible action — its copy must stay put.
  it('leaves the disable copy describing a disable', () => {
    render(
      <UserActionDialog actionDialog={{ ...deleteDialog, type: 'disable' }} onClose={() => {}} onConfirm={() => {}} />,
    );

    expect(screen.getByText(/terminate all active sessions/i)).toBeInTheDocument();
    expect(screen.getByText(/until re-enabled/i)).toBeInTheDocument();
    expect(screen.queryByText(/erased from the database/i)).not.toBeInTheDocument();
  });
});

describe('UserBulkDeleteDialog — bulk copy matches deleteMany', () => {
  const users = [
    { id: 'u1', username: 'jdoe', fullName: 'Jane Doe', role: 'OPERATOR', status: 'ENABLED' },
    { id: 'u2', username: 'rroe', fullName: 'Richard Roe', role: 'VIEWER', status: 'ENABLED' },
  ];

  const renderBulk = () =>
    render(
      <UserBulkDeleteDialog
        open
        selectedIds={new Set(['u1', 'u2'])}
        displayedUsers={users}
        bulkDeleting={false}
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );

  it('tells the admin every selected record is deleted, not disabled', () => {
    renderBulk();

    expect(screen.getByText(/permanently deletes these accounts/i)).toBeInTheDocument();
    expect(screen.getByText(/erased from the database/i)).toBeInTheDocument();
  });

  it('does not claim the accounts are merely disabled', () => {
    renderBulk();

    expect(screen.queryByText(/permanently disabled/i)).not.toBeInTheDocument();
  });

  it('names what actually survives — the audit trail entries', () => {
    renderBulk();

    expect(screen.getByText(/only the audit trail entries survive/i)).toBeInTheDocument();
  });
});

/**
 * Audit 2026-10-03, DATA-11: a delete or a disable signs with the operator's
 * REASON. The server refuses both without one (400 REASON_REQUIRED), so the
 * dialogs do not confirm until one is typed and hand it to the page — which
 * must never send `{}` for these two actions.
 */
import { fireEvent } from '@testing-library/react';
import { vi } from 'vitest';

describe('UserActionDialog — the reason', () => {
  it('delete: asks for a reason, confirms only once typed, and passes it trimmed', () => {
    const onConfirm = vi.fn();
    render(<UserActionDialog actionDialog={deleteDialog} onClose={() => {}} onConfirm={onConfirm} />);
    const confirm = screen.getByRole('button', { name: /delete user/i });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: '  left the company  ' } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith('left the company');
  });

  it('disable: the same, with the disable wording', () => {
    const onConfirm = vi.fn();
    render(<UserActionDialog actionDialog={{ ...deleteDialog, type: 'disable' }} onClose={() => {}} onConfirm={onConfirm} />);
    const confirm = screen.getByRole('button', { name: /^confirm$/i });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'on leave' } });
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith('on leave');
  });

  it('a whitespace-only reason does not confirm', () => {
    render(<UserActionDialog actionDialog={deleteDialog} onClose={() => {}} onConfirm={() => {}} />);
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: /delete user/i })).toBeDisabled();
  });

  it('enable: no reason is asked for and confirm is live at once', () => {
    const onConfirm = vi.fn();
    render(<UserActionDialog actionDialog={{ ...deleteDialog, type: 'enable' }} onClose={() => {}} onConfirm={onConfirm} />);
    expect(screen.queryByLabelText('Reason')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }));
    expect(onConfirm).toHaveBeenCalledWith('');
  });
});

describe('UserBulkDeleteDialog — the reason', () => {
  const users = [{ id: 'u1', username: 'jdoe', fullName: 'Jane Doe', role: 'OPERATOR', status: 'ENABLED' }];

  it('asks for a reason, confirms only once typed, and passes it', () => {
    const onConfirm = vi.fn();
    render(
      <UserBulkDeleteDialog open selectedIds={new Set(['u1'])} displayedUsers={users} bulkDeleting={false} onClose={() => {}} onConfirm={onConfirm} />,
    );
    const confirm = screen.getByRole('button', { name: /delete 1 user/i });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'contract ended' } });
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith('contract ended');
  });
});
