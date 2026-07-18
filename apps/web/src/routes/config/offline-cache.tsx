import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { offlineCacheConfigSchema, type OfflineCacheConfig } from '@digilog/shared';
import useSWR, { mutate } from 'swr';
import { apiClient } from '@/lib/api-client';
import { useAuth } from '@/hooks/use-auth';
import { useReauth } from '@/hooks/use-reauth';
import { ReauthDialog } from '@/components/reauth-dialog';
import { Button } from '@/components/ui/button';

export function OfflineCacheConfigPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const { data } = useSWR<OfflineCacheConfig>('/api/config/offline-cache', { revalidateOnMount: true, dedupingInterval: 0 });
  const reauth = useReauth();

  const { register, handleSubmit, reset, watch, formState: { isSubmitting, isDirty, errors } } = useForm<OfflineCacheConfig>({
    resolver: zodResolver(offlineCacheConfigSchema),
    values: data ?? undefined,
  });

  const staleness = watch('cacheStalenessHours');
  const hardCutoff = watch('cacheHardCutoffHours');

  // Defense in depth: this page should only be reachable by SUPER_ADMIN. The
  // backend route gate (`requireSuperAdmin()` on PUT) and the config registry
  // manifest filter both already enforce this, but the FE gate gives a
  // clearer message than a 403 surfaced through a SWR error.
  if (user && user.role !== 'SUPER_ADMIN') {
    return (
      <div className="p-8 max-w-2xl mx-auto">
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-6">
          <h2 className="text-lg font-semibold text-amber-900">SUPER_ADMIN only</h2>
          <p className="text-sm text-amber-700 mt-1">Offline cache settings can only be changed by the system owner.</p>
          <Link to="/config" className="text-sm text-indigo-600 hover:text-indigo-700 mt-3 inline-block">← Back to Configuration</Link>
        </div>
      </div>
    );
  }

  const onSubmit = async (formData: OfflineCacheConfig) => {
    setError(''); setSuccess('');
    await reauth.execute('UPDATE_OFFLINE_CACHE_CONFIG', async (password?) => {
      if (password) await apiClient.putWithReauth('/api/config/offline-cache', formData, password);
      else await apiClient.put('/api/config/offline-cache', formData);
      // Refresh both the editor read and the public-read endpoint that
      // every client polls; without the second mutate, the new TTL wouldn't
      // apply until a page reload.
      mutate('/api/config/offline-cache');
      mutate('/api/config/offline-cache/current');
      setSuccess('Offline cache settings updated.');
      reset(formData);
    }, {
      onError: (err: any) => setError(err.message || 'Failed to update'),
    });
  };

  return (
    <div className="space-y-6 max-w-3xl mx-auto p-4 md:p-6">
      <div className="flex items-center gap-3">
        <Link to="/config" className="text-sm text-slate-500 hover:text-slate-700">← Configuration</Link>
      </div>

      <header className="flex items-start gap-4">
        <div className="p-3 rounded-2xl bg-gradient-to-br from-slate-700 to-slate-900 text-white shadow-lg">
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" />
            <line x1="3" y1="3" x2="21" y2="21" strokeLinecap="round" strokeWidth={1.5} stroke="currentColor" />
          </svg>
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Offline Cache & Lockout</h1>
          <p className="text-sm text-slate-500 mt-0.5">Control how long client caches stay fresh and when the app enters read-only mode after losing server contact</p>
        </div>
      </header>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}
      {success && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{success}</div>
      )}

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6 bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
        <section className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-800">Cache Staleness</h2>
            <p className="text-sm text-slate-500 mt-1">After this many hours, the client treats its cached snapshot (filter state, templates, equipment groups) as stale and forces a refetch.</p>
          </div>

          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">cacheStalenessHours</span>
            <input
              type="number"
              step="0.01"
              min={0.01}
              max={168}
              {...register('cacheStalenessHours', { valueAsNumber: true })}
              className="mt-1 w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-800 focus:border-cyan-400 focus:ring-2 focus:ring-cyan-100 outline-none"
            />
            <span className="text-xs text-slate-400 mt-1 block">Range 0.01–168 (one week). Default 24. Current: {staleness}h.</span>
            {errors.cacheStalenessHours && <span className="text-xs text-red-600 mt-1 block">{errors.cacheStalenessHours.message}</span>}
          </label>
        </section>

        <hr className="border-slate-100" />

        <section className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-800">Hard Cutoff (Lockout)</h2>
            <p className="text-sm text-slate-500 mt-1">After this many hours with no successful server contact, the client enters read-only mode. Operators can still see cached data but cannot start cycles, advance stages, or submit checklists until contact resumes.</p>
          </div>

          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">cacheHardCutoffHours</span>
            <input
              type="number"
              step="0.01"
              min={0.01}
              max={168}
              {...register('cacheHardCutoffHours', { valueAsNumber: true })}
              className="mt-1 w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-800 focus:border-cyan-400 focus:ring-2 focus:ring-cyan-100 outline-none"
            />
            <span className="text-xs text-slate-400 mt-1 block">Range 0.01–168 (one week). Default 24. Current: {hardCutoff}h.</span>
            {errors.cacheHardCutoffHours && <span className="text-xs text-red-600 mt-1 block">{errors.cacheHardCutoffHours.message}</span>}
          </label>
        </section>

        <div className="flex items-center gap-3 pt-2">
          <Button type="submit" disabled={isSubmitting || !isDirty}>
            {isSubmitting ? 'Saving…' : 'Save'}
          </Button>
          {isDirty && (
            <button type="button" onClick={() => reset()} className="text-sm text-slate-500 hover:text-slate-700">
              Discard changes
            </button>
          )}
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
        actionLabel="Update Offline Cache Settings"
      />
    </div>
  );
}
