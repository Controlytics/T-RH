import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { passwordChangeSchema, type PasswordChangeInput, type PasswordPolicyConfig } from '@digilog/shared';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { apiClient } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { useNavigate } from 'react-router-dom';
import useSWR from 'swr';

// Default password policy
const defaultPolicy: PasswordPolicyConfig = {
  minLength: 8,
  maxLength: 128,
  requireUppercase: true,
  requireLowercase: true,
  requireNumbers: true,
  requireSpecialChars: true,
  minUppercase: 1,
  minLowercase: 1,
  minNumbers: 1,
  minSpecialChars: 1,
  preventReuseCount: 12,
  cannotBeUserId: true,
  cannotContainUserId: true,
  passwordExpiryDays: 90,
  expiryNotificationDays: 0,
  maxFailedAttempts: 5,
  autoLogoutEnabled: true,
  idleTimeoutMinutes: 15,
  warningMinutes: 2,
};

export function ChangePasswordPage() {
  const { user, mutate } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [showPasswords, setShowPasswords] = useState({ current: false, new: false, confirm: false });

  // Fetch password policy. Use the PUBLIC `/current` variant, not the bare
  // `/api/config/password-policy` (which requires UPDATE_PASSWORD_POLICY and
  // 403s for non-admins). A forced-change OPERATOR/SUPERVISOR hit that 403 and
  // silently fell back to `defaultPolicy` — so the requirements shown (and the
  // client-side `isValid` gate) could disagree with the server's real policy,
  // letting them submit a password the backend then rejects. `/current` is
  // readable by any authenticated user and is in the forcePasswordChange
  // allow-list, so it resolves for the temp-password / reset / expiry flow.
  const { data: policyData } = useSWR<PasswordPolicyConfig>('/api/config/password-policy/current');
  const policy = { ...defaultPolicy, ...policyData };

  const { register, handleSubmit, watch, formState: { errors, isSubmitting } } = useForm<PasswordChangeInput>({
    resolver: zodResolver(passwordChangeSchema),
  });

  const newPassword = watch('newPassword', '');

  // Password strength indicators based on policy
  const upperCount = (newPassword.match(/[A-Z]/g) || []).length;
  const lowerCount = (newPassword.match(/[a-z]/g) || []).length;
  const numberCount = (newPassword.match(/[0-9]/g) || []).length;
  const specialCount = (newPassword.match(/[^A-Za-z0-9]/g) || []).length;

  const hasLength = newPassword.length >= policy.minLength;
  const hasUpper = !policy.requireUppercase || upperCount >= policy.minUppercase;
  const hasLower = !policy.requireLowercase || lowerCount >= policy.minLowercase;
  const hasNumber = !policy.requireNumbers || numberCount >= policy.minNumbers;
  const hasSpecial = !policy.requireSpecialChars || specialCount >= policy.minSpecialChars;
  const notUserId = !policy.cannotContainUserId || !user?.username || !newPassword.toLowerCase().includes(user.username.toLowerCase());

  const isValid = hasLength && hasUpper && hasLower && hasNumber && hasSpecial && notUserId;

  const onSubmit = async (data: PasswordChangeInput) => {
    setError('');
    try {
      await apiClient.post('/api/auth/change-password', data);
      await mutate();
      // 2026-05-20: tablet users routed here by mobile-login.tsx (temp/forced
      // change password flow) need to land back on /m, not the desktop
      // dashboard. mobile-login stashes the hint before navigating us here.
      //
      // 2026-05-21 hardening: when the sessionStorage hint is missing for any
      // reason (lost during navigation race / WebView storage quirk), detect
      // Capacitor and default to /m instead of /. Without this, tablet users
      // landed on the desktop dashboard or were bounced through the Capacitor
      // auto-redirect (main.tsx) back to /m/login — operators saw a "refresh
      // to login" symptom right after submitting their new password.
      const isCapacitor = !!(window as any).Capacitor?.isNativePlatform?.();
      const hint = sessionStorage.getItem('post_change_password_redirect');
      sessionStorage.removeItem('post_change_password_redirect');
      const redirect = hint || (isCapacitor ? '/m' : '/');
      toast.success('Password changed successfully', 'Your password has been updated.');
      navigate(redirect);
    } catch (err: any) {
      const message = err.message || 'Failed to change password';
      setError(message);
      toast.error('Password change failed', message);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Change Password</CardTitle>
          <CardDescription>
            {user?.isTemporaryPassword
              ? 'You are using a temporary password. You must change it before continuing.'
              : 'Update your password to continue.'}
          </CardDescription>
          {user?.username && (
            <div className="mt-3 flex items-center gap-2 text-sm">
              <span className="text-slate-500">User ID:</span>
              <span className="font-semibold text-slate-700">{user.username}</span>
            </div>
          )}
        </CardHeader>
        <form onSubmit={handleSubmit(onSubmit)}>
          <CardContent className="space-y-4">
            {error && (
              <div className="rounded-xl bg-red-50 border border-red-200 p-3 text-sm text-red-700">{error}</div>
            )}
            {/* Only show current password field if NOT using temporary password */}
            {!user?.isTemporaryPassword && (
              <div className="space-y-2">
                <label className="text-sm font-medium">Current Password</label>
                <div className="relative">
                  <Input
                    {...register('currentPassword')}
                    type={showPasswords.current ? 'text' : 'password'}
                    secureField
                  />
                  <button type="button" className="absolute right-3 top-2.5 text-sm text-slate-500 hover:text-slate-700"
                    onClick={() => setShowPasswords(p => ({ ...p, current: !p.current }))} tabIndex={-1}>
                    {showPasswords.current ? 'Hide' : 'Show'}
                  </button>
                </div>
                {errors.currentPassword && <p className="text-sm text-red-500">{errors.currentPassword.message}</p>}
              </div>
            )}
            <div className="space-y-2">
              <label className="text-sm font-medium">New Password</label>
              <div className="relative">
                <Input
                  {...register('newPassword')}
                  type={showPasswords.new ? 'text' : 'password'}
                  secureField
                />
                <button type="button" className="absolute right-3 top-2.5 text-sm text-slate-500 hover:text-slate-700"
                  onClick={() => setShowPasswords(p => ({ ...p, new: !p.new }))} tabIndex={-1}>
                  {showPasswords.new ? 'Hide' : 'Show'}
                </button>
              </div>
              {errors.newPassword && <p className="text-sm text-red-500">{errors.newPassword.message}</p>}

              {/* Policy-based strength indicators */}
              <div className="mt-3 p-3 bg-slate-50 rounded-xl border border-slate-200">
                <p className="text-xs font-semibold text-slate-600 mb-2">Password Requirements:</p>
                <div className="space-y-1 text-xs">
                  <p className={hasLength ? 'text-emerald-600' : 'text-slate-500'}>
                    {hasLength ? '✓' : '○'} At least {policy.minLength} characters
                  </p>
                  {policy.requireUppercase && (
                    <p className={hasUpper ? 'text-emerald-600' : 'text-slate-500'}>
                      {hasUpper ? '✓' : '○'} At least {policy.minUppercase} uppercase letter{policy.minUppercase > 1 ? 's' : ''}
                    </p>
                  )}
                  {policy.requireLowercase && (
                    <p className={hasLower ? 'text-emerald-600' : 'text-slate-500'}>
                      {hasLower ? '✓' : '○'} At least {policy.minLowercase} lowercase letter{policy.minLowercase > 1 ? 's' : ''}
                    </p>
                  )}
                  {policy.requireNumbers && (
                    <p className={hasNumber ? 'text-emerald-600' : 'text-slate-500'}>
                      {hasNumber ? '✓' : '○'} At least {policy.minNumbers} number{policy.minNumbers > 1 ? 's' : ''}
                    </p>
                  )}
                  {policy.requireSpecialChars && (
                    <p className={hasSpecial ? 'text-emerald-600' : 'text-slate-500'}>
                      {hasSpecial ? '✓' : '○'} At least {policy.minSpecialChars} special character{policy.minSpecialChars > 1 ? 's' : ''}
                    </p>
                  )}
                  {policy.cannotContainUserId && user?.username && (
                    <p className={notUserId ? 'text-emerald-600' : 'text-red-500'}>
                      {notUserId ? '✓' : '✗'} Cannot contain your User ID
                    </p>
                  )}
                </div>
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Confirm New Password</label>
              <div className="relative">
                <Input
                  {...register('confirmPassword')}
                  type={showPasswords.confirm ? 'text' : 'password'}
                  secureField
                />
                <button type="button" className="absolute right-3 top-2.5 text-sm text-slate-500 hover:text-slate-700"
                  onClick={() => setShowPasswords(p => ({ ...p, confirm: !p.confirm }))} tabIndex={-1}>
                  {showPasswords.confirm ? 'Hide' : 'Show'}
                </button>
              </div>
              {errors.confirmPassword && <p className="text-sm text-red-500">{errors.confirmPassword.message}</p>}
            </div>

            {policy.preventReuseCount > 0 && (
              <p className="text-xs text-slate-500">
                Note: Password cannot match any of your last {policy.preventReuseCount} passwords.
              </p>
            )}
          </CardContent>
          <CardFooter>
            <Button type="submit" className="w-full" disabled={isSubmitting || !isValid}>
              {isSubmitting ? 'Changing...' : 'Change Password'}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
