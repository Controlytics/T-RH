import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import useSWR from 'swr';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { useReauth } from '@/hooks/use-reauth';
import { useToast } from '@/hooks/use-toast';
import { useFieldLabels } from '@/hooks/use-field-labels';
import { useRoleColors } from '@/hooks/use-role-colors';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api-client';
import { ReauthDialog } from '@/components/reauth-dialog';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { usePaginationConfig } from '@/hooks/use-pagination-config';
import type { PasswordPolicyConfig } from '@digilog/shared';
import { generatePassword, DEFAULT_PASSWORD_POLICY } from '../../lib/password-utils';
import { CLIPBOARD_COPY_RESET_MS } from '@/lib/timing-constants';

import { UserStatsBar } from './components/user-stats-bar';
import { UserFilters } from './components/user-filters';
import { UserTable } from './components/user-table';
import { UserActionDialog } from './components/user-action-dialog';
import { UserBulkDeleteDialog } from './components/user-bulk-delete-dialog';
import { UserUnlockDialog } from './components/user-unlock-dialog';
import { Pagination } from '@/components/ui/pagination';

type PendingCount = { count: number };

export function UserListPage() {
  const apiBase = `/api`;
  const { user: currentUser } = useAuth();
  const reauth = useReauth();
  const { toast } = useToast();
  const { userLabels } = useFieldLabels();
  const { formatDate, formatTime } = useDatetimeFormat();
  const paginationOptions = usePaginationConfig();
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(paginationOptions[0]);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [actionDialog, setActionDialog] = useState<{ type: string; userId: string; username: string; fullName?: string } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteDialog, setBulkDeleteDialog] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [unlockDialog, setUnlockDialog] = useState<{ userId: string; username: string } | null>(null);
  const [unlockPassword, setUnlockPassword] = useState('');
  const [showUnlockPassword, setShowUnlockPassword] = useState(false);
  const [unlockCopied, setUnlockCopied] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Debounce search input (300ms)
  useEffect(() => {
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(debounceRef.current);
  }, [search]);

  // Fetch all active roles with dynamic colors
  const { roleColors, rolesData } = useRoleColors();

  // Get available roles for filter, excluding SUPER_ADMIN for Admin users
  const availableRoles = useMemo(() => {
    if (!rolesData) return [];
    const hiddenRoles: string[] = [];
    if (currentUser?.role !== 'SUPER_ADMIN') hiddenRoles.push('SUPER_ADMIN');
    return rolesData.filter(r => !hiddenRoles.includes(r.name));
  }, [rolesData, currentUser?.role]);

  // Build query params - filter by role and status on the server
  const params = new URLSearchParams({ page: String(page), limit: String(perPage) });
  if (debouncedSearch) params.set('search', debouncedSearch);
  if (roleFilter) params.set('role', roleFilter);
  if (statusFilter) params.set('status', statusFilter);

  const { data: rawData, mutate } = useSWR(`${apiBase}/users?${params}`);
  const { data: pendingData } = useSWR<PendingCount>('/api/users/reset-requests/pending');
  const { data: userStatsData, mutate: mutateStats } = useSWR<{ total: number; enabled: number; disabled: number; locked: number; expired: number }>('/api/users/stats');
  const { data: policyData } = useSWR<PasswordPolicyConfig>('/api/config/password-policy', { revalidateOnMount: true, dedupingInterval: 5000 });
  const policy = { ...DEFAULT_PASSWORD_POLICY, ...policyData };

  // Server already filters out higher-privilege roles (SUPER_ADMIN/ADMIN) per caller's role
  const isTopAdmin = currentUser?.role === 'SUPER_ADMIN' || currentUser?.role === 'ADMIN';
  const data = rawData ?? null;

  const handleAction = async () => {
    if (!actionDialog) return;
    const actionMap: Record<string, string> = {
      delete: 'DELETE_USER',
      enable: 'ENABLE_USER',
      disable: 'DISABLE_USER',
    };
    const reauthAction = actionMap[actionDialog.type] || actionDialog.type;
    const { userId, type, username } = actionDialog;
    setActionDialog(null);

    const actionLabels: Record<string, string> = {
      delete: 'deleted',
      enable: 'enabled',
      disable: 'disabled',
    };

    await reauth.execute(reauthAction, async (password?) => {
      if (type === 'delete') {
        if (password) await apiClient.deleteWithReauth(`${apiBase}/users/${userId}`, password);
        else await apiClient.delete(`${apiBase}/users/${userId}`);
      } else {
        if (password) await apiClient.postWithReauth(`${apiBase}/users/${userId}/${type}`, {}, password);
        else await apiClient.post(`${apiBase}/users/${userId}/${type}`, {});
      }
      mutate();
      mutateStats();
      if (type === 'delete') {
        setSelectedIds(prev => {
          const next = new Set(prev);
          next.delete(userId);
          return next;
        });
      }
      toast.success('User updated', `User "${username}" has been ${actionLabels[type] || type} successfully.`);
    }, {
      onError: (err: any) => {
        toast.error('Action failed', err?.message || `Failed to ${type} user "${username}".`);
      },
    });
  };

  // Phase 5C: button gating resolves from the PERMISSION_TREE via useCan(<node>). Each
  // node's `gate` is the REAL backend permission, so FE visibility now matches backend
  // enforcement (no drift). Behavior vs the prior checks:
  //  - users.delete   → gate [] (SUPER_ADMIN-only, Phase 3 M3) — same as the old isSuperAdmin gate
  //  - users.edit / enable_disable / unlock → gate [USER_UPDATE]/[USER_ENABLE_DISABLE]/[USER_UNLOCK]
  //    — same as the old isSuperAdmin||perms.includes() checks
  //  - users.create   → gate [USER_CREATE] — NEW: the Create button was previously ungated
  //    (analysis §3.1 gap); it now correctly hides from users without USER_CREATE.
  const can = useCan();
  const canDeleteUsers = can('users.delete');
  const canEditUsers = can('users.edit');
  const canDisableUsers = can('users.enable_disable');
  const canUnlockUsers = can('users.unlock');
  const canCreateUsers = can('users.create');

  // Get filtered user list for display
  const displayedUsers = data?.data ?? [];

  // Bulk selection helpers
  const selectableUsers = displayedUsers.filter((u: any) =>
    u.id !== currentUser?.id && u.role !== 'SUPER_ADMIN'
  );
  const allSelected = selectableUsers.length > 0 && selectableUsers.every((u: any) => selectedIds.has(u.id));
  const someSelected = selectableUsers.some((u: any) => selectedIds.has(u.id));

  const toggleSelectAll = useCallback(() => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(selectableUsers.map((u: any) => u.id)));
    }
  }, [allSelected, selectableUsers]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleBulkDelete = async () => {
    const ids = Array.from(selectedIds);
    setBulkDeleteDialog(false);

    await reauth.execute('BULK_DELETE_USERS', async (password?) => {
      if (password) await apiClient.postWithReauth(`${apiBase}/users/bulk-delete`, { userIds: ids }, password);
      else await apiClient.post(`${apiBase}/users/bulk-delete`, { userIds: ids });
      setSelectedIds(new Set());
      mutate();
      mutateStats();
      toast.success('Users deleted', `${ids.length} user(s) deleted successfully.`);
    }, {
      onError: (err: any) => {
        toast.error('Bulk delete failed', err?.message || 'Failed to delete selected users.');
      },
    });
  };

  // Clear selection on page/filter change
  useEffect(() => {
    setSelectedIds(new Set());
  }, [page, search, roleFilter, statusFilter]);

  const handleUnlockOpen = useCallback((userId: string, username: string) => {
    const pwd = generatePassword(policy);
    setUnlockPassword(pwd);
    setShowUnlockPassword(false);
    setUnlockCopied(false);
    setUnlockDialog({ userId, username });
  }, [policy]);

  const handleUnlockConfirm = useCallback(async () => {
    if (!unlockDialog) return;
    const { userId, username } = unlockDialog;
    const pwd = unlockPassword;
    setUnlockDialog(null);

    // This call site used to pass no options, unlike the other two reauth.execute
    // sites in this file. use-reauth swallows non-reauth errors when onError is
    // absent, so a failed unlock (403, network drop, reauth cancel) looked
    // exactly like success — the admin would hand out a temp password for an
    // account that was still locked.
    await reauth.execute('UNLOCK_USER', async (password?) => {
      if (password) await apiClient.postWithReauth(`/api/users/${userId}/unlock`, { newPassword: pwd }, password);
      else await apiClient.post(`/api/users/${userId}/unlock`, { newPassword: pwd });
      setUnlockPassword('');
      mutate();
      mutateStats();
      toast.success('Account unlocked', `User "${username}" can now sign in with the temporary password.`);
    }, {
      onError: (err: any) => {
        toast.error('Unlock failed', err?.message || `Failed to unlock user "${username}".`);
      },
    });
  }, [unlockDialog, unlockPassword, reauth, mutate, mutateStats, toast]);

  const handleUnlockCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(unlockPassword);
      setUnlockCopied(true);
      setTimeout(() => setUnlockCopied(false), CLIPBOARD_COPY_RESET_MS);
    } catch {
      const textArea = document.createElement('textarea');
      textArea.value = unlockPassword;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      setUnlockCopied(true);
      setTimeout(() => setUnlockCopied(false), CLIPBOARD_COPY_RESET_MS);
    }
  }, [unlockPassword]);

  const handleUnlockRegenerate = useCallback(() => {
    setUnlockPassword(generatePassword(policy));
    setUnlockCopied(false);
  }, [policy]);

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="p-3 rounded-2xl shadow-lg" style={{ backgroundImage: 'linear-gradient(to bottom right, var(--theme-gradient-from), var(--theme-gradient-to))' }}>
            <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
            </svg>
          </div>
          <div>
            <h1 className="text-2xl font-bold bg-gradient-to-r from-slate-800 to-slate-600 bg-clip-text text-transparent">User Management</h1>
            <p className="text-sm text-slate-500 mt-0.5">Manage system users and their access permissions</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {can('users.reset_password') && (
          <Link to="/users/reset-requests">
            <Button variant="outline" className="gap-2 relative border-amber-200 text-amber-700 hover:bg-amber-50">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
              </svg>
              Password Reset Requests
              {pendingData && pendingData.count > 0 && (
                <span className="absolute -top-2 -right-2 w-6 h-6 flex items-center justify-center text-xs font-bold bg-gradient-to-r from-red-500 to-rose-500 text-white rounded-full shadow-lg shadow-red-500/30">
                  {pendingData.count}
                </span>
              )}
            </Button>
          </Link>
          )}
          {canCreateUsers && (
          <Link to="/users/create">
            <Button className="gap-2 shadow-lg text-white hover:opacity-90" style={{ backgroundImage: 'linear-gradient(to right, var(--theme-gradient-from), var(--theme-gradient-to))' }}>
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
              </svg>
              Create User
            </Button>
          </Link>
          )}
        </div>
      </div>

      {/* Filters */}
      <UserFilters
        search={search}
        setSearch={setSearch}
        roleFilter={roleFilter}
        setRoleFilter={setRoleFilter}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        setPage={setPage}
        availableRoles={availableRoles}
        rolesData={rolesData}
      />

      {/* Stats Summary */}
      {userStatsData && (
        <UserStatsBar stats={userStatsData} />
      )}

      {/* Bulk Selection Toolbar */}
      {canDeleteUsers && selectedIds.size > 0 && (
        <div className="bg-gradient-to-r from-red-50 to-rose-50 rounded-2xl border border-red-200 p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-red-100">
              <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <span className="text-sm font-semibold text-red-800">
              {selectedIds.size} user{selectedIds.size !== 1 ? 's' : ''} selected
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSelectedIds(new Set())}
              className="border-red-200 text-red-600 hover:bg-red-50"
            >
              Clear Selection
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setBulkDeleteDialog(true)}
              className="gap-2 bg-gradient-to-r from-red-500 to-rose-500 hover:from-red-600 hover:to-rose-600"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              Delete Selected
            </Button>
          </div>
        </div>
      )}

      {/* Table */}
      <UserTable
        canDeleteUsers={canDeleteUsers}
        canEditUsers={canEditUsers}
        canDisableUsers={canDisableUsers}
        canUnlockUsers={canUnlockUsers}
        displayedUsers={displayedUsers}
        selectedIds={selectedIds}
        toggleSelect={toggleSelect}
        toggleSelectAll={toggleSelectAll}
        allSelected={allSelected}
        someSelected={someSelected}
        currentUser={currentUser}
        roleColors={roleColors}
        rolesData={rolesData}
        formatDate={formatDate}
        formatTime={formatTime}
        userLabels={userLabels}
        onAction={setActionDialog}
        onUnlock={handleUnlockOpen}
        generatePassword={generatePassword}
        policy={policy}
      />

      {/* Pagination — always rendered so the rows-per-page selector is available */}
      {data && data.total > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200/60 shadow-sm">
          <Pagination
            page={page}
            pageSize={perPage}
            totalItems={data.total}
            onPageChange={setPage}
            onPageSizeChange={setPerPage}
            pageSizeOptions={paginationOptions}
          />
        </div>
      )}

      {/* Confirmation Dialog */}
      <UserActionDialog
        actionDialog={actionDialog}
        onClose={() => setActionDialog(null)}
        onConfirm={handleAction}
      />

      {/* Bulk Delete Confirmation Dialog */}
      <UserBulkDeleteDialog
        open={bulkDeleteDialog}
        selectedIds={selectedIds}
        displayedUsers={displayedUsers}
        bulkDeleting={bulkDeleting}
        onClose={() => setBulkDeleteDialog(false)}
        onConfirm={handleBulkDelete}
      />

      {/* Unlock Account Dialog with Temporary Password */}
      <UserUnlockDialog
        unlockDialog={unlockDialog}
        unlockPassword={unlockPassword}
        showUnlockPassword={showUnlockPassword}
        unlockCopied={unlockCopied}
        onClose={() => setUnlockDialog(null)}
        onToggleShowPassword={() => setShowUnlockPassword(!showUnlockPassword)}
        onCopy={handleUnlockCopy}
        onRegenerate={handleUnlockRegenerate}
        onConfirm={handleUnlockConfirm}
        policy={policy}
      />

      {/* Reauth Dialog */}
      <ReauthDialog
        open={reauth.isOpen}
        password={reauth.password}
        error={reauth.error}
        isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={reauth.cancel}
        actionLabel="User Action"
      />
    </div>
  );
}
