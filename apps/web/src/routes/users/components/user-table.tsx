import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import type { PasswordPolicyConfig } from '@digilog/shared';

const statusBadge: Record<string, string> = {
  ENABLED: 'bg-gradient-to-r from-emerald-400 to-teal-400 text-white border-0',
  DISABLED: 'bg-gradient-to-r from-red-400 to-rose-400 text-white border-0',
  LOCKED: 'bg-gradient-to-r from-amber-400 to-orange-400 text-white border-0',
  EXPIRED: 'bg-gradient-to-r from-slate-400 to-gray-400 text-white border-0',
};

interface RoleData {
  name: string;
  displayName: string;
}

interface UserLabels {
  fullName: string;
  email: string;
  role: string;
  status: string;
  [key: string]: string;
}

interface UserTableProps {
  canDeleteUsers: boolean;
  /** 2026-05-26 permission-leak fix: each action button is now
   *  individually gated. Pre-fix the table rendered Edit / Disable /
   *  Enable / Unlock unconditionally, so any operator who reached
   *  the Users list could mutate other accounts. */
  canEditUsers: boolean;
  canDisableUsers: boolean;
  canUnlockUsers: boolean;
  displayedUsers: any[];
  selectedIds: Set<string>;
  toggleSelect: (id: string) => void;
  toggleSelectAll: () => void;
  allSelected: boolean;
  someSelected: boolean;
  currentUser: { id: string; role: string } | null | undefined;
  roleColors: Record<string, string>;
  rolesData: RoleData[] | undefined;
  formatDate: (date: string) => string;
  formatTime: (date: string) => string;
  userLabels: UserLabels;
  onAction: (action: { type: string; userId: string; username: string; fullName?: string }) => void;
  onUnlock: (userId: string, username: string, authSource?: string) => void;
  generatePassword: (policy: PasswordPolicyConfig) => string;
  policy: PasswordPolicyConfig;
}

export function UserTable({
  canDeleteUsers,
  canEditUsers,
  canDisableUsers,
  canUnlockUsers,
  displayedUsers,
  selectedIds,
  toggleSelect,
  toggleSelectAll,
  allSelected,
  someSelected,
  currentUser,
  roleColors,
  rolesData,
  formatDate,
  formatTime,
  userLabels,
  onAction,
  onUnlock,
}: UserTableProps) {
  return (
    <div className="bg-white rounded-[var(--radius-card)] border border-slate-200/60 shadow-xl shadow-slate-200/40 overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="bg-gradient-to-r from-slate-50 to-white border-b border-slate-100">
            {canDeleteUsers && (
              <TableHead className="w-12">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected; }}
                  onChange={toggleSelectAll}
                  className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                />
              </TableHead>
            )}
            <TableHead className="font-semibold text-slate-600">{userLabels.fullName}</TableHead>
            <TableHead className="font-semibold text-slate-600">{userLabels.email}</TableHead>
            <TableHead className="font-semibold text-slate-600">{userLabels.role}</TableHead>
            <TableHead className="font-semibold text-slate-600">{userLabels.status}</TableHead>
            <TableHead className="font-semibold text-slate-600">Last Login</TableHead>
            <TableHead className="text-right font-semibold text-slate-600">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {displayedUsers.map((user: any) => (
            <TableRow key={user.id} className={`hover:bg-slate-50/50 transition-colors ${selectedIds.has(user.id) ? 'bg-blue-50/50' : ''}`}>
              {canDeleteUsers && (
                <TableCell className="w-12">
                  {user.id !== currentUser?.id && user.role !== 'SUPER_ADMIN' ? (
                    <input
                      type="checkbox"
                      checked={selectedIds.has(user.id)}
                      onChange={() => toggleSelect(user.id)}
                      className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                    />
                  ) : (
                    <span className="w-4 h-4 block" />
                  )}
                </TableCell>
              )}
              <TableCell>
                <div className="flex items-center gap-3">
                  <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-[#1e3a5f] to-[#3b82f6] flex items-center justify-center text-white font-semibold text-sm shadow-md">
                    {user.fullName.split(' ').map((n: string) => n[0]).join('').toUpperCase().slice(0, 2)}
                  </div>
                  <div>
                    <p className="font-semibold text-slate-800">{user.fullName}</p>
                    <div className="flex items-center gap-2">
                      <p className="text-sm text-slate-500 font-mono">@{user.username}</p>
                      {/* Directory-sourced accounts look identical to local ones
                          otherwise, yet behave differently everywhere that
                          touches a password — an admin needs to see which is
                          which before reaching for Reset or Unlock. */}
                      {user.authSource === 'ldap' && (
                        <span
                          title="Signs in with a company Active Directory account. Password and account status are managed in the directory."
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-sky-50 text-sky-700 border border-sky-200"
                        >
                          <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2" /></svg>
                          AD
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </TableCell>
              <TableCell className="text-slate-600">{user.email}</TableCell>
              <TableCell>
                <Badge className={`${roleColors[user.role] ?? 'bg-slate-500 text-white'} shadow-sm`}>
                  {rolesData?.find(r => r.name === user.role)?.displayName || user.role.replace('_', ' ')}
                </Badge>
              </TableCell>
              <TableCell>
                <Badge className={`${statusBadge[user.status] ?? 'bg-slate-100 text-slate-600'} shadow-sm`}>{user.status}</Badge>
              </TableCell>
              <TableCell>
                {user.lastLogin ? (
                  <div>
                    <p className="text-slate-600 text-sm">{formatDate(user.lastLogin)}</p>
                    <p className="text-slate-400 text-xs">{formatTime(user.lastLogin)}</p>
                  </div>
                ) : (
                  <span className="text-slate-400 text-sm">Never</span>
                )}
              </TableCell>
              <TableCell>
                <div className="flex justify-end gap-2">
                  {/* 2026-05-26 permission-leak fix: each action below is
                      gated on its own permission. Pre-fix all four were
                      rendered unconditionally. */}
                  {canEditUsers && (
                    <Link to={`/users/${user.id}`}>
                      <Button variant="outline" size="sm" className="gap-1.5 border-slate-200 hover:bg-slate-50">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                        Edit
                      </Button>
                    </Link>
                  )}
                  {canUnlockUsers && user.status === 'LOCKED' && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 border-emerald-200 text-emerald-600 hover:bg-emerald-50"
                      onClick={() => onUnlock(user.id, user.username, user.authSource)}
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
                      </svg>
                      Unlock
                    </Button>
                  )}
                  {canDisableUsers && user.status === 'ENABLED' && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 border-red-200 text-red-600 hover:bg-red-50"
                      onClick={() => onAction({ type: 'disable', userId: user.id, username: user.username })}
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                      </svg>
                      Disable
                    </Button>
                  )}
                  {canDisableUsers && user.status === 'DISABLED' && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 border-emerald-200 text-emerald-600 hover:bg-emerald-50"
                      onClick={() => onAction({ type: 'enable', userId: user.id, username: user.username })}
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      Enable
                    </Button>
                  )}
                  {/* Delete button - requires USER_DELETE permission, not for own account */}
                  {canDeleteUsers && user.id !== currentUser?.id && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 border-red-300 text-red-600 hover:bg-red-50 hover:border-red-400"
                      onClick={() => onAction({ type: 'delete', userId: user.id, username: user.username, fullName: user.fullName })}
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                      Delete
                    </Button>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
          {displayedUsers.length === 0 && (
            <TableRow>
              <TableCell colSpan={canDeleteUsers ? 7 : 6} className="text-center py-16">
                <div className="flex flex-col items-center gap-4">
                  <div className="p-4 rounded-[var(--radius-card)] bg-slate-100">
                    <svg className="w-10 h-10 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-slate-600 font-semibold">No users found</p>
                    <p className="text-sm text-slate-400 mt-1">Try adjusting your search or filters</p>
                  </div>
                </div>
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
