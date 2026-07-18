import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AuditTable } from '../audit-table';

/**
 * Regression tests for M71 — privilege inversion on the audit trail.
 *
 * The Details column (the only way to open a record) used to render behind the
 * same flag as the destructive selection column, which was fed
 * `audit.redact || audit.delete`. An inspector holding AUDIT_READ — who the
 * backend happily serves GET /api/audit/:id — had no way to open a row.
 * Reading must depend on read rights; only DESTROYING depends on destroy rights.
 */

const record = {
  id: 'a1',
  timestamp: '2026-07-15T10:00:00.000Z',
  action: 'USER_LOGIN',
  userId: 'inspector',
  userRole: 'VIEWER',
  ipAddress: '10.0.0.1',
};

const baseProps = {
  data: { data: [record] },
  isLoading: false,
  selectedIds: new Set<string>(),
  toggleSelect: () => {},
  toggleSelectAll: () => {},
  isAllSelected: false,
  sortBy: 'timestamp' as const,
  sortOrder: 'desc' as const,
  toggleSort: () => {},
  formatDate: () => '15 Jul 2026',
  formatTime: () => '10:00',
  getAuditSummary: () => 'User logged in',
  getAuditStatus: () => 'Success' as const,
  templates: {},
  ACTION_COLORS: {} as Record<string, string>,
};

describe('AuditTable — reading is not gated on destroy rights', () => {
  it('shows the Details column + View button to a read-only viewer', () => {
    const onViewRecord = vi.fn();
    render(
      <AuditTable
        {...baseProps}
        canDestroy={false}
        canRedact={false}
        canHardDelete={false}
        onViewRecord={onViewRecord}
        onDeleteRecord={() => {}}
      />,
    );

    expect(screen.getByText('Details')).toBeInTheDocument();
    expect(screen.getByTitle('View record details')).toBeInTheDocument();
  });

  it('hides the selection checkboxes from a viewer who cannot destroy', () => {
    render(
      <AuditTable
        {...baseProps}
        canDestroy={false}
        canRedact={false}
        canHardDelete={false}
        onViewRecord={() => {}}
        onDeleteRecord={() => {}}
      />,
    );

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    // Reading stays available even with every destructive right withheld.
    expect(screen.getByTitle('View record details')).toBeInTheDocument();
  });

  it('shows the selection checkboxes once the viewer can destroy', () => {
    render(
      <AuditTable
        {...baseProps}
        canDestroy
        canRedact
        canHardDelete={false}
        onViewRecord={() => {}}
        onDeleteRecord={() => {}}
      />,
    );

    // Header select-all + the row checkbox.
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(screen.getByTitle('Redact record (mask contents, keep hash chain)')).toBeInTheDocument();
  });

  it('keeps the redact button away from a viewer holding only hard-delete', () => {
    const onHardDeleteRecord = vi.fn();
    render(
      <AuditTable
        {...baseProps}
        canDestroy
        canRedact={false}
        canHardDelete
        onViewRecord={() => {}}
        onDeleteRecord={() => {}}
        onHardDeleteRecord={onHardDeleteRecord}
      />,
    );

    expect(screen.queryByTitle('Redact record (mask contents, keep hash chain)')).not.toBeInTheDocument();
    expect(
      screen.getByTitle('Delete permanently (physically removes the row — breaks the hash chain)'),
    ).toBeInTheDocument();
  });
});

/**
 * Regression tests for M72 — redacted rows were indistinguishable from live ones.
 *
 * Three redacted rows existed in the live 17k-row audit trail, each rendering as
 * an ordinary record: no badge, no reason, no redactor, and the redact button
 * still offered. Redaction is the chain-preserving alternative to deletion and
 * only earns that role if an inspector can SEE it.
 */
const redactedRecord = {
  ...record,
  id: 'a2',
  beforeValue: null,
  afterValue: null,
  redactedAt: '2026-07-02T09:52:20.847Z',
  redactedBy: 'f8e5e6e9-db1b-4f87-99f4-dec13cb1cccb',
  redactedByName: 'superadmin',
  redactionReason: 'contained personal data',
};

describe('AuditTable — redacted rows announce themselves', () => {
  it('badges a redacted row with its redactor and reason', () => {
    render(
      <AuditTable
        {...baseProps}
        data={{ data: [redactedRecord] }}
        canDestroy
        canRedact
        canHardDelete={false}
        onViewRecord={() => {}}
        onDeleteRecord={() => {}}
      />,
    );

    expect(screen.getByText('Payload redacted')).toBeInTheDocument();
    expect(screen.getByText(/superadmin/)).toBeInTheDocument();
    expect(screen.getByText(/contained personal data/)).toBeInTheDocument();
  });

  it('leaves an ordinary row unbadged', () => {
    render(
      <AuditTable
        {...baseProps}
        canDestroy
        canRedact
        canHardDelete={false}
        onViewRecord={() => {}}
        onDeleteRecord={() => {}}
      />,
    );

    expect(screen.queryByText('Payload redacted')).not.toBeInTheDocument();
  });

  it('drops the redact button on an already-redacted row but keeps hard delete', () => {
    render(
      <AuditTable
        {...baseProps}
        data={{ data: [redactedRecord] }}
        canDestroy
        canRedact
        canHardDelete
        onHardDeleteRecord={() => {}}
        onViewRecord={() => {}}
        onDeleteRecord={() => {}}
      />,
    );

    // Re-redacting cost a prompt + reauth only to 409 ALREADY_REDACTED.
    expect(screen.queryByTitle('Redact record (mask contents, keep hash chain)')).not.toBeInTheDocument();
    // A redacted row can still be physically removed.
    expect(screen.getByTitle(/Delete permanently/)).toBeInTheDocument();
    // Reading is never gated.
    expect(screen.getByTitle('View record details')).toBeInTheDocument();
  });

  it('still offers redact on a live row', () => {
    render(
      <AuditTable
        {...baseProps}
        canDestroy
        canRedact
        canHardDelete={false}
        onViewRecord={() => {}}
        onDeleteRecord={() => {}}
      />,
    );

    expect(screen.getByTitle('Redact record (mask contents, keep hash chain)')).toBeInTheDocument();
  });
});
