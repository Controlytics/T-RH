import { useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { updateUserSchema, type UpdateUserInput, type PasswordPolicyConfig, type RoleData } from '@digilog/shared';
import { useAuth } from '@/hooks/use-auth';
import { useReauth } from '@/hooks/use-reauth';
import { useToast } from '@/hooks/use-toast';
import { useFieldLabels } from '@/hooks/use-field-labels';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { apiClient } from '@/lib/api-client';
import { ReauthDialog } from '@/components/reauth-dialog';
import useSWR from 'swr';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { CLIPBOARD_COPY_RESET_MS } from '@/lib/timing-constants';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { generatePassword, DEFAULT_PASSWORD_POLICY } from '../../lib/password-utils';

const statusConfig: Record<string, { color: string; bg: string; icon: string }> = {
  ENABLED: { color: 'text-emerald-700', bg: 'bg-gradient-to-r from-emerald-400 to-teal-400', icon: 'M5 13l4 4L19 7' },
  DISABLED: { color: 'text-red-700', bg: 'bg-gradient-to-r from-red-400 to-rose-400', icon: 'M6 18L18 6M6 6l12 12' },
  LOCKED: { color: 'text-amber-700', bg: 'bg-gradient-to-r from-amber-400 to-orange-400', icon: 'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z' },
  EXPIRED: { color: 'text-slate-700', bg: 'bg-gradient-to-r from-slate-400 to-gray-400', icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z' },
};

export function EditUserPage() {
  const { id } = useParams();
  const { user: currentUser } = useAuth();
  const { toast } = useToast();
  const { userLabels } = useFieldLabels();
  const { formatDate, formatTime } = useDatetimeFormat();
  const navigate = useNavigate();
  // 2026-05-26 permission-leak fix (audit task #12): the route is gated
  // by USER_READ (read-only access), but this page exposed:
  //   - "Save Changes" (PUT /api/users/:id, gated USER_UPDATE on BE)
  //   - "Generate Temporary Password" (POST /api/users/:id/reset-password,
  //     gated USER_RESET_PASSWORD on BE)
  // Backend RBAC stopped the actual writes, but the operator saw a
  // fully editable form and a working reset-password dialog before
  // hitting the 403. Now each action is gated to match the BE.
  const perms: string[] = (currentUser?.permissions as string[] | undefined) ?? [];
  const isSuperAdmin = currentUser?.role === 'SUPER_ADMIN';
  const canEdit = isSuperAdmin || perms.includes('USER_UPDATE');
  const canResetPassword = isSuperAdmin || perms.includes('USER_RESET_PASSWORD');
  const [error, setError] = useState('');
  const [tempPasswordDialog, setTempPasswordDialog] = useState(false);
  const [generatedPassword, setGeneratedPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const reauth = useReauth();

  // Fetch password policy
  const { data: policyData } = useSWR<PasswordPolicyConfig>('/api/config/password-policy', { revalidateOnMount: true, dedupingInterval: 5000 });
  const policy = { ...DEFAULT_PASSWORD_POLICY, ...policyData };

  // Fetch roles that current user can create
  const { data: creatableRolesData } = useSWR<RoleData[]>(
    currentUser?.role ? `/api/roles/${currentUser.role}/creatable` : null,
    { revalidateOnMount: true, dedupingInterval: 0 }
  );
  const creatableRoles = creatableRolesData || [];

  const { data: userData, mutate } = useSWR(id ? `/api/users/${id}` : null);

  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<UpdateUserInput>({
    resolver: zodResolver(updateUserSchema),
    values: userData ? {
      fullName: userData.fullName,
      // Coerce null → '' so the (optional) email field is always a string; the
      // form submits '' for emailless users, which the schema now accepts.
      email: userData.email ?? '',
      department: userData.department ?? '',
      role: userData.role,
      // `status` is deliberately NOT seeded. There is no status input on this
      // form (status changes go through enable/disable/unlock on the list page),
      // and updateUserSchema only accepts ENABLED|DISABLED — so feeding a real
      // LOCKED/EXPIRED user's status in made the resolver reject the form. With
      // no rendered error for that field, Save silently did nothing, for exactly
      // the users most likely to need editing.
    } : undefined,
  });

  const onSubmit = async (data: UpdateUserInput) => {
    setError('');
    await reauth.execute('UPDATE_USER', async (password?) => {
      if (password) await apiClient.putWithReauth(`/api/users/${id}`, data, password);
      else await apiClient.put(`/api/users/${id}`, data);
      toast.success('User updated', 'The user’s details were updated successfully.');
      navigate('/users');
    }, {
      onError: (err: any) => {
        const message = err.message || 'Failed to update user';
        setError(message);
        toast.error('User update failed', message);
      },
    });
  };

  const handleOpenTempPasswordDialog = () => {
    const newPassword = generatePassword(policy);
    setGeneratedPassword(newPassword);
    setShowPassword(false);
    setCopied(false);
    setTempPasswordDialog(true);
  };

  const regeneratePassword = () => {
    const newPassword = generatePassword(policy);
    setGeneratedPassword(newPassword);
    setCopied(false);
  };

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(generatedPassword);
      setCopied(true);
      setTimeout(() => setCopied(false), CLIPBOARD_COPY_RESET_MS);
    } catch {
      // Fallback for older browsers
      const textArea = document.createElement('textarea');
      textArea.value = generatedPassword;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      setCopied(true);
      setTimeout(() => setCopied(false), CLIPBOARD_COPY_RESET_MS);
    }
  };

  const handleGenerateTempPassword = async () => {
    setIsGenerating(true);
    setTempPasswordDialog(false);
    await reauth.execute('RESET_PASSWORD', async (password?) => {
      if (password) await apiClient.postWithReauth(`/api/users/${id}/reset-password`, { newPassword: generatedPassword }, password);
      else await apiClient.post(`/api/users/${id}/reset-password`, { newPassword: generatedPassword });
      setGeneratedPassword('');
      mutate();
    }, {
      onError: (err: any) => setError(err.message || 'Failed to generate temporary password'),
    });
    setIsGenerating(false);
  };

  if (!userData) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="flex items-center gap-3 text-slate-500">
          <svg className="w-5 h-5 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
          </svg>
          <span>Loading user data...</span>
        </div>
      </div>
    );
  }

  const status = statusConfig[userData.status] || statusConfig.ENABLED;

  // Admin can only edit role and email, not fullName and department
  const isAdmin = currentUser?.role === 'ADMIN';

  return (
    <div className="space-y-8 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-[#1e3a5f] to-[#3b82f6] flex items-center justify-center text-white text-xl font-bold shadow-lg shadow-blue-500/25">
            {userData.fullName.split(' ').map((n: string) => n[0]).join('').toUpperCase().slice(0, 2)}
          </div>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold bg-gradient-to-r from-slate-800 to-slate-600 bg-clip-text text-transparent">{userData.fullName}</h1>
              <Badge className={`${status.bg} text-white border-0 shadow-sm`}>{userData.status}</Badge>
            </div>
            <p className="text-sm text-slate-500 mt-0.5 font-mono">@{userData.username}</p>
          </div>
        </div>
        <Link to="/users">
          <Button variant="outline" className="gap-2">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            Back to Users
          </Button>
        </Link>
      </div>

      {/* Form Card */}
      <div className="bg-white rounded-2xl border border-slate-200/60 shadow-xl shadow-slate-200/40 overflow-hidden">
        <form onSubmit={handleSubmit(onSubmit)}>
          {/* Error Message */}
          {error && (
            <div className="mx-6 mt-6 flex items-center gap-3 rounded-xl bg-red-50 border border-red-200 p-4">
              <div className="p-2 rounded-lg bg-red-100">
                <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}

          {/* User Details Section */}
          <div className="p-6 border-b border-slate-100">
            <div className="flex items-center gap-3 mb-6">
              <div className="p-2 rounded-lg bg-slate-100">
                <svg className="w-5 h-5 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                </svg>
              </div>
              <h2 className="text-lg font-semibold text-slate-800">User Information</h2>
            </div>

            <div className="space-y-2 mb-6">
              <label className="text-sm font-semibold text-slate-500">{userLabels.userId} (read-only)</label>
              <Input
                value={userData.username}
                disabled
                className="h-12 bg-slate-50 font-mono"
              />
            </div>

            <div className="grid grid-cols-2 gap-6">
              <div className="space-y-2">
                <label className="text-sm font-semibold text-slate-700">
                  {userLabels.fullName}
                  {isAdmin && <span className="ml-2 text-xs text-slate-400 font-normal">(User can edit)</span>}
                </label>
                <Input
                  {...register('fullName')}
                  disabled={isAdmin}
                  className={`h-12 ${isAdmin ? 'bg-slate-50 text-slate-500' : ''}`}
                />
                {errors.fullName && (
                  <p className="text-sm text-red-500 flex items-center gap-1">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    {errors.fullName.message}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <label className="text-sm font-semibold text-slate-700">{userLabels.email}</label>
                <Input
                  {...register('email')}
                  type="email"
                  className="h-12"
                />
                {errors.email && (
                  <p className="text-sm text-red-500 flex items-center gap-1">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    {errors.email.message}
                  </p>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-6 mt-6">
              <div className="space-y-2">
                <label className="text-sm font-semibold text-slate-700">
                  {userLabels.department}
                  {isAdmin && <span className="ml-2 text-xs text-slate-400 font-normal">(User can edit)</span>}
                </label>
                <Input
                  {...register('department')}
                  disabled={isAdmin}
                  className={`h-12 ${isAdmin ? 'bg-slate-50 text-slate-500' : ''}`}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-semibold text-slate-700">{userLabels.role}</label>
                <div className="relative group">
                  <div className="absolute left-3 top-1/2 -translate-y-1/2 p-1.5 rounded-lg bg-gradient-to-br from-purple-100 to-indigo-100 z-10 pointer-events-none">
                    <svg className="w-4 h-4 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                    </svg>
                  </div>
                  <Select {...register('role')} variant="filled" className="pl-12 h-12">
                    {/* Always offer the user's CURRENT role. /creatable is
                        USER_CREATE-gated, so an editor holding only USER_UPDATE
                        gets a 403 and an empty list — the control then rendered
                        completely blank, showing neither the current role nor
                        any option. (The save itself was never broken: RHF
                        submits from its own form state, not the DOM.) */}
                    {userData.role && !creatableRoles.some((r) => r.name === userData.role) && (
                      <option value={userData.role}>{userData.roleDisplayName || userData.role}</option>
                    )}
                    {creatableRoles.map((r) => (
                      <option key={r.name} value={r.name}>{r.displayName}</option>
                    ))}
                  </Select>
                </div>
              </div>
            </div>
          </div>

                    {/* Account Activity Section */}
          <div className="p-6 bg-gradient-to-r from-slate-50 to-white border-b border-slate-100">
            <div className="flex items-center gap-3 mb-6">
              <div className="p-2 rounded-lg bg-blue-100">
                <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <h2 className="text-lg font-semibold text-slate-800">Account Activity</h2>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="p-4 rounded-xl bg-white border border-slate-200 shadow-sm">
                <div className="flex items-center gap-2 text-slate-500 text-sm mb-2">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                  </svg>
                  Created
                </div>
                <p className="font-semibold text-slate-800">{formatDate(userData.createdAt)}</p>
                <p className="text-xs text-slate-400 mt-1">by {userData.createdBy ?? 'system'}</p>
              </div>
              <div className="p-4 rounded-xl bg-white border border-slate-200 shadow-sm">
                <div className="flex items-center gap-2 text-slate-500 text-sm mb-2">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
                  </svg>
                  Last Login
                </div>
                <p className="font-semibold text-slate-800">
                  {userData.lastLogin ? formatDate(userData.lastLogin) : 'Never'}
                </p>
                {userData.lastLogin && (
                  <p className="text-xs text-slate-400 mt-1">{formatTime(userData.lastLogin)}</p>
                )}
              </div>
              <div className="p-4 rounded-xl bg-white border border-slate-200 shadow-sm">
                <div className="flex items-center gap-2 text-slate-500 text-sm mb-2">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                  </svg>
                  Password Changed
                </div>
                <p className="font-semibold text-slate-800">
                  {userData.passwordChangedAt ? formatDate(userData.passwordChangedAt) : 'Never'}
                </p>
                {userData.passwordChangedAt && (
                  <p className="text-xs text-slate-400 mt-1">{formatTime(userData.passwordChangedAt)}</p>
                )}
              </div>
            </div>
          </div>

          {/* Footer Actions — 2026-05-26 gated per-button */}
          <div className="px-6 py-4 border-t border-slate-100 flex items-center justify-between">
            {canResetPassword ? (
              <Button
                type="button"
                variant="outline"
                onClick={handleOpenTempPasswordDialog}
                className="gap-2 border-amber-200 text-amber-700 hover:bg-amber-50"
              >
                Generate Temporary Password
              </Button>
            ) : (
              <span className="text-xs text-slate-400">Reset password requires USER_RESET_PASSWORD</span>
            )}
            <div className="flex items-center gap-3">
              <Link to="/users">
                <Button type="button" variant="outline">
                  {canEdit ? 'Cancel' : 'Back'}
                </Button>
              </Link>
              {canEdit && (
                <Button type="submit" disabled={isSubmitting}>
                  {isSubmitting ? 'Saving...' : 'Save Changes'}
                </Button>
              )}
            </div>
          </div>
        </form>
      </div>

      {/* Generate Temporary Password Dialog */}
      <Dialog open={tempPasswordDialog} onClose={() => setTempPasswordDialog(false)}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-amber-100">
              <svg className="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
              </svg>
            </div>
            Generate Temporary Password
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-5">
          <div className="flex items-center gap-4 p-4 rounded-xl bg-slate-50 border border-slate-200">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-[#1e3a5f] to-[#3b82f6] flex items-center justify-center text-lg font-semibold text-white">
              {userData.fullName.split(' ').map((n: string) => n[0]).join('').toUpperCase().slice(0, 2)}
            </div>
            <div>
              <p className="font-semibold text-slate-800">{userData.fullName}</p>
              <p className="text-sm text-slate-500 font-mono">@{userData.username}</p>
            </div>
          </div>

          <p className="text-sm text-slate-600">
            A temporary password has been generated. The user must change it on next login.
          </p>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-sm font-semibold text-slate-700">Temporary Password</label>
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" onClick={regeneratePassword} className="gap-1.5">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  Regenerate
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={copyToClipboard} className="gap-1.5">
                  {copied ? (
                    <>
                      <svg className="w-4 h-4 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      <span className="text-emerald-600">Copied!</span>
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                      Copy
                    </>
                  )}
                </Button>
              </div>
            </div>
            <div className="relative">
              <Input
                value={generatedPassword}
                readOnly
                type={showPassword ? 'text' : 'password'}
                className="font-mono text-base bg-slate-50 pr-16 h-12 border-slate-200"
              />
              <button
                type="button"
                className="absolute right-4 top-1/2 -translate-y-1/2 text-sm font-medium text-slate-500 hover:text-slate-700 transition-colors"
                onClick={() => setShowPassword(!showPassword)}
                tabIndex={-1}
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>

          <div className="rounded-xl bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200/60 p-4">
            <div className="flex gap-3">
              <div className="p-2 rounded-lg bg-amber-100 h-fit">
                <svg className="w-4 h-4 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <div>
                <p className="font-semibold text-amber-800 text-sm">Important</p>
                <p className="text-amber-700 text-sm mt-1">
                  Copy the password before confirming. It cannot be retrieved after this dialog closes.
                </p>
              </div>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setTempPasswordDialog(false)}>Cancel</Button>
          <Button
            onClick={handleGenerateTempPassword}
            disabled={isGenerating}
            className="bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 shadow-lg shadow-amber-500/20"
          >
            {isGenerating ? (
              <>
                <svg className="w-4 h-4 mr-2 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
                </svg>
                Setting Password...
              </>
            ) : (
              <>
                <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                Confirm & Set Password
              </>
            )}
          </Button>
        </DialogFooter>
      </Dialog>

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
