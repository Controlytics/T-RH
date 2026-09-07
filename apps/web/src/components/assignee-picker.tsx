import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { ALL_RECORDS_PARAM } from '@digilog/shared';
import type { Assignee } from '@/lib/report-review';

interface Role { name: string; displayName: string }
interface User { id: string; username: string; role?: string; fullName?: string }

/**
 * "Send to" — a user OR a role — for a report request (2026-09-07). Lifted from
 * the removed `SendForReviewButton`, whose dialog collected the same choice for
 * the workflow this replaces. SUPER_ADMIN is never offered as a role: it is not
 * an approving function, and a request "to any super admin" names nobody.
 *
 * Controlled: the dialog owns the value so it can refuse to submit without one.
 * The select is labelled "Send to" whichever mode is active, so the one control
 * a test or a screen reader looks for is the same in both.
 */
export function AssigneePicker({ value, onChange, disabled }: {
  value: Assignee | null;
  /** `label` is the option's display text — "qa1" or "QA Approver" — for the toast. */
  onChange: (next: Assignee | null, label: string) => void;
  disabled?: boolean;
}) {
  const [mode, setMode] = useState<'role' | 'user'>(value && 'userId' in value ? 'user' : 'role');
  const { data: rolesData } = useSWR<Role[]>('/api/roles/active');
  const { data: usersData } = useSWR<any>(`/api/users?${ALL_RECORDS_PARAM}&status=ENABLED`);
  const roles = useMemo(() => (rolesData ?? []).filter((r) => r.name !== 'SUPER_ADMIN'), [rolesData]);
  const users: User[] = useMemo(() => {
    const raw = Array.isArray(usersData) ? usersData : (usersData?.data ?? usersData?.users ?? []);
    return (raw as User[]).filter((u) => u.username);
  }, [usersData]);

  const switchMode = (next: 'role' | 'user') => { setMode(next); onChange(null, ''); };
  const selected = value ? ('userId' in value ? value.userId : value.role) : '';

  return (
    <div className="space-y-2">
      <div className="seg">
        <button type="button" onClick={() => switchMode('role')} aria-pressed={mode === 'role'} className="seg-btn" disabled={disabled}>
          To a role
        </button>
        <button type="button" onClick={() => switchMode('user')} aria-pressed={mode === 'user'} className="seg-btn" disabled={disabled}>
          To a user
        </button>
      </div>
      {mode === 'role' ? (
        <select
          aria-label="Send to"
          value={selected}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value ? { role: e.target.value } : null, e.target.selectedOptions[0]?.text ?? e.target.value)}
          className="ctl w-full"
        >
          <option value="">Select a role…</option>
          {roles.map((r) => <option key={r.name} value={r.name}>{r.displayName || r.name}</option>)}
        </select>
      ) : (
        <select
          aria-label="Send to"
          value={selected}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value ? { userId: e.target.value } : null, users.find((u) => u.id === e.target.value)?.username ?? e.target.value)}
          className="ctl w-full"
        >
          <option value="">Select a user…</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.username}{u.role ? ` (${u.role})` : ''}</option>)}
        </select>
      )}
    </div>
  );
}
