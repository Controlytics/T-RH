import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { datetimeConfigSchema, type DatetimeConfig } from '@digilog/shared';
import useSWR, { mutate } from 'swr';
import { apiClient } from '@/lib/api-client';
import { useAuth } from '@/hooks/use-auth';
import { useReauth } from '@/hooks/use-reauth';
import { ReauthDialog } from '@/components/reauth-dialog';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';

export function DatetimeConfigPage() {
  const navigate = useNavigate();
  // 2026-05-26 audit fix (PA-FE-1): gate Save on CONFIG_UPDATE.
  const { user } = useAuth();
  const perms = (user?.permissions as string[] | undefined) ?? [];
  const isSuperAdmin = user?.role === 'SUPER_ADMIN';
  const canWrite = isSuperAdmin || perms.includes('CONFIG_UPDATE');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const { data } = useSWR('/api/config/datetime', { revalidateOnMount: true, dedupingInterval: 0 });
  const reauth = useReauth();

  const { register, handleSubmit, watch, reset, formState: { isSubmitting, isDirty } } = useForm<DatetimeConfig>({
    resolver: zodResolver(datetimeConfigSchema),
    values: data ?? undefined,
  });

  const watchedDateFormat = watch('dateFormat');
  const watchedTimeFormat = watch('timeFormat');
  const watchedTimezone = watch('timezone');

  const onSubmit = async (formData: DatetimeConfig) => {
    setError(''); setSuccess('');
    await reauth.execute('UPDATE_DATETIME_CONFIG', async (password?) => {
      if (password) await apiClient.putWithReauth('/api/config/datetime', formData, password);
      else await apiClient.put('/api/config/datetime', formData);
      mutate('/api/config/datetime/current');
      setSuccess('Date/time format updated successfully');
      reset(formData);
    }, {
      onError: (err: any) => setError(err.message || 'Failed to update'),
    });
  };

  // Preview function - uses the configured timezone
  const getPreviewDate = () => {
    const date = new Date();
    const tz = watchedTimezone || 'Asia/Kolkata';
    try {
      const opts: Intl.DateTimeFormatOptions = { timeZone: tz };
      const formats: Record<string, string> = {
        'DD/MM/YYYY': date.toLocaleDateString('en-GB', opts),
        'MM/DD/YYYY': date.toLocaleDateString('en-US', opts),
        'YYYY-MM-DD': (() => {
          const y = date.toLocaleString('en-US', { year: 'numeric', timeZone: tz });
          const m = date.toLocaleString('en-US', { month: '2-digit', timeZone: tz });
          const d = date.toLocaleString('en-US', { day: '2-digit', timeZone: tz });
          return `${y}-${m}-${d}`;
        })(),
        'DD-MMM-YYYY': date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', ...opts }).replace(/ /g, '-'),
        'MMM DD, YYYY': date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', ...opts }),
      };
      return formats[watchedDateFormat || 'DD/MM/YYYY'] || date.toLocaleDateString('en-GB', opts);
    } catch {
      return date.toLocaleDateString('en-GB');
    }
  };

  const getPreviewTime = () => {
    const date = new Date();
    const tz = watchedTimezone || 'Asia/Kolkata';
    try {
      if (watchedTimeFormat === '12-hour') {
        return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: tz });
      }
      return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz });
    } catch {
      if (watchedTimeFormat === '12-hour') {
        return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
      }
      return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
    }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link to="/config" className="p-2 rounded-xl hover:bg-slate-100 transition-colors">
            <svg className="w-5 h-5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </Link>
          <div className="p-3 rounded-2xl bg-gradient-to-br from-purple-500 to-pink-600 shadow-lg shadow-purple-500/25">
            <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </div>
          <div>
            <h1 className="text-2xl font-bold bg-gradient-to-r from-slate-800 to-slate-600 bg-clip-text text-transparent">Date/Time Format</h1>
            <p className="text-sm text-slate-500 mt-0.5">Configure how dates and times are displayed</p>
          </div>
        </div>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        {/* Status Messages */}
        {error && (
          <div className="flex items-center gap-3 rounded-xl bg-red-50 border border-red-200 p-4">
            <div className="p-2 rounded-lg bg-red-100">
              <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}
        {success && (
          <div className="flex items-center gap-3 rounded-xl bg-emerald-50 border border-emerald-200 p-4">
            <div className="p-2 rounded-lg bg-emerald-100">
              <svg className="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <p className="text-sm text-emerald-700">{success}</p>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Settings Card */}
          <div className="bg-white rounded-2xl border border-slate-200/60 shadow-xl shadow-slate-200/40 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600">
                  <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-slate-800">Format Settings</h2>
                  <p className="text-sm text-slate-500">Choose your preferred display formats</p>
                </div>
              </div>
            </div>
            <div className="p-6 space-y-6">
              {/* Date Format */}
              <div className="space-y-3">
                <label className="text-sm font-semibold text-slate-700 flex items-center gap-2">
                  <div className="w-6 h-6 rounded-lg bg-purple-100 flex items-center justify-center">
                    <svg className="w-4 h-4 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                  </div>
                  Date Format
                </label>
                <div className="relative group">
                  <div className="absolute left-3 top-1/2 -translate-y-1/2 p-1.5 rounded-lg bg-gradient-to-br from-purple-100 to-pink-100 z-10 pointer-events-none">
                    <svg className="w-4 h-4 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                  </div>
                  <Select {...register('dateFormat')} variant="filled" className="pl-12 h-12">
                    <option value="DD/MM/YYYY">DD/MM/YYYY (25/12/2024)</option>
                    <option value="MM/DD/YYYY">MM/DD/YYYY (12/25/2024)</option>
                    <option value="YYYY-MM-DD">YYYY-MM-DD (2024-12-25) - ISO</option>
                    <option value="DD-MMM-YYYY">DD-MMM-YYYY (25-Dec-2024)</option>
                    <option value="MMM DD, YYYY">MMM DD, YYYY (Dec 25, 2024)</option>
                  </Select>
                </div>
              </div>

              {/* Time Format */}
              <div className="space-y-3">
                <label className="text-sm font-semibold text-slate-700 flex items-center gap-2">
                  <div className="w-6 h-6 rounded-lg bg-blue-100 flex items-center justify-center">
                    <svg className="w-4 h-4 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  Time Format
                </label>
                <div className="relative group">
                  <div className="absolute left-3 top-1/2 -translate-y-1/2 p-1.5 rounded-lg bg-gradient-to-br from-blue-100 to-indigo-100 z-10 pointer-events-none">
                    <svg className="w-4 h-4 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <Select {...register('timeFormat')} variant="filled" className="pl-12 h-12">
                    <option value="24-hour">24-Hour (14:30)</option>
                    <option value="12-hour">12-Hour (02:30 PM)</option>
                  </Select>
                </div>
              </div>

            </div>
          </div>

          {/* Preview Card */}
          <div className="bg-white rounded-2xl border border-slate-200/60 shadow-xl shadow-slate-200/40 overflow-hidden h-fit">
            <div className="px-6 py-4 border-b border-slate-100 bg-gradient-to-r from-amber-50 to-orange-50">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-xl bg-gradient-to-br from-amber-500 to-orange-600">
                  <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-slate-800">Live Preview</h2>
                  <p className="text-sm text-slate-500">See how dates and times will appear</p>
                </div>
              </div>
            </div>
            <div className="p-6">
              <div className="space-y-4">
                {/* Date Preview */}
                <div className="p-5 rounded-xl bg-gradient-to-br from-purple-50 to-pink-50 border border-purple-200">
                  <div className="flex items-center gap-2 text-sm text-purple-600 font-medium mb-2">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                    Date Format
                  </div>
                  <p className="text-3xl font-bold bg-gradient-to-r from-purple-600 to-pink-600 bg-clip-text text-transparent">
                    {getPreviewDate()}
                  </p>
                </div>

                {/* Time Preview */}
                <div className="p-5 rounded-xl bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-200">
                  <div className="flex items-center gap-2 text-sm text-blue-600 font-medium mb-2">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    Time Format
                  </div>
                  <p className="text-3xl font-bold bg-gradient-to-r from-blue-600 to-indigo-600 bg-clip-text text-transparent">
                    {getPreviewTime()}
                  </p>
                </div>

                {/* Combined Preview */}
                <div className="p-5 rounded-xl bg-gradient-to-br from-slate-100 to-slate-50 border border-slate-200">
                  <div className="flex items-center gap-2 text-sm text-slate-600 font-medium mb-2">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    Full Timestamp
                  </div>
                  <p className="text-lg font-semibold text-slate-800">
                    {getPreviewDate()} {getPreviewTime()}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Info Banner */}
        <div className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-xl border border-blue-200 p-4">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-lg bg-blue-100">
              <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div>
              <p className="font-semibold text-blue-800">Global Setting</p>
              <p className="text-sm text-blue-700 mt-1">
                This format applies to ALL users and ALL pages in the application. Changes will be reflected throughout the system immediately.
              </p>
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="flex justify-end gap-3 pt-4 mt-6 border-t border-slate-100">
          <Button type="button" variant="outline" onClick={() => navigate('/config')}>
            Cancel
          </Button>
          <Button type="submit" disabled={!isDirty || isSubmitting || !canWrite}
            title={!canWrite ? 'CONFIG_UPDATE permission required' : undefined}>
            {isSubmitting ? 'Saving...' : 'Save Changes'}
          </Button>
        </div>
      </form>
      <ReauthDialog
        open={reauth.isOpen}
        password={reauth.password}
        error={reauth.error}
        isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={reauth.cancel}
        actionLabel="Update Date/Time Config"
      />
    </div>
  );
}
