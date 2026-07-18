import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import useSWR, { mutate as globalMutate } from 'swr';
import { apiClient, api } from '../../lib/api-client';
import { useAuth } from '@/hooks/use-auth';
import { useReauth } from '@/hooks/use-reauth';
import { ReauthDialog } from '@/components/reauth-dialog';

type AhuMode = 'BOTH' | 'SET_A' | 'SET_B' | 'DISABLED';

interface AhuConfigRow {
  ahuId: string;
  ahuName: string;
  mode: AhuMode;
  setACount: number;
  setBCount: number;
  noSetCount: number;
  totalFilters: number;
  hasActiveSchedule: boolean;
}

const MODE_META: Record<AhuMode, { label: string; bg: string; text: string; border: string }> = {
  BOTH:     { label: 'Both Sets',  bg: 'bg-cyan-50',    text: 'text-cyan-700',    border: 'border-cyan-200' },
  SET_A:    { label: 'Only Set A', bg: 'bg-blue-50',    text: 'text-blue-700',    border: 'border-blue-200' },
  SET_B:    { label: 'Only Set B', bg: 'bg-purple-50',  text: 'text-purple-700',  border: 'border-purple-200' },
  DISABLED: { label: 'Disabled',   bg: 'bg-slate-100',  text: 'text-slate-600',   border: 'border-slate-200' },
};

export function AhuFilterSetConfigPage() {
  // 2026-05-26 audit fix (PA-FE-1): gate the mode-toggle dropdown on
  // PM_UPDATE (since this controls which set counts toward PM
  // completion). Pre-fix any PM_READ + ASSET_VIEW user could mutate
  // here.
  const { user } = useAuth();
  const perms = (user?.permissions as string[] | undefined) ?? [];
  const isSuperAdmin = user?.role === 'SUPER_ADMIN';
  const canWrite = isSuperAdmin || perms.includes('PM_UPDATE') || perms.includes('CONFIG_UPDATE');
  const navigate = useNavigate();
  const { data, mutate: mutateList, isLoading } =
    useSWR<{ ahus: AhuConfigRow[] }>('/api/pm-schedules/ahu-configs');

  const [search, setSearch] = useState('');
  const [savingAhuId, setSavingAhuId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const reauth = useReauth();

  // Audit 2026-05-04 fix #5 (web-routes review H — lower-blast config
  // surfaces). UPDATE_CONFIG_PAGE umbrella; backend mirror in
  // pm-schedules/routes.ts. Note: reauth fires per-row mode change so
  // the password challenge surfaces once per AHU edit (cheap dropdown
  // toggle, not a batched save).
  const handleModeChange = (ahuId: string, newMode: AhuMode) => {
    setSavingAhuId(ahuId);
    setError('');
    setSuccess('');
    const body = { mode: newMode };
    reauth.execute(
      'UPDATE_CONFIG_PAGE',
      async (password?: string) => {
        if (password) await api.putWithReauth(`/api/pm-schedules/ahu-configs/${ahuId}`, body, password);
        else await apiClient.put(`/api/pm-schedules/ahu-configs/${ahuId}`, body);
      },
      {
        onSuccess: async () => {
          await mutateList();
          // Invalidate My Tasks so the change takes effect immediately on any open /my-tasks tab
          globalMutate('/api/pm-schedules/due');
          setSuccess('Saved');
          setTimeout(() => setSuccess(''), 2000);
          setSavingAhuId(null);
        },
        onError: (e: any) => {
          setError(e.message ?? 'Failed to save AHU mode');
          setSavingAhuId(null);
        },
      },
    );
  };

  const ahus = (data?.ahus ?? []) as AhuConfigRow[];
  const visible = ahus.filter(a =>
    !search.trim() || a.ahuName.toLowerCase().includes(search.trim().toLowerCase())
  );

  // Summary counts for the stat row
  const stats = {
    total: ahus.length,
    both: ahus.filter(a => a.mode === 'BOTH').length,
    setA: ahus.filter(a => a.mode === 'SET_A').length,
    setB: ahus.filter(a => a.mode === 'SET_B').length,
    disabled: ahus.filter(a => a.mode === 'DISABLED').length,
  };

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      {/* ─── Header ─── */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-4">
          <div className="p-3 rounded-2xl bg-gradient-to-br from-teal-500 to-cyan-600 shadow-lg shadow-cyan-500/25">
            <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-800">AHU Filter Set Configuration</h1>
            <p className="text-sm text-slate-500 mt-0.5">
              Control which filter set counts toward PM completion in My Tasks, per AHU. Changes apply immediately.
            </p>
          </div>
        </div>
        <button
          onClick={() => navigate('/config')}
          className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 text-slate-700 rounded-xl text-sm font-semibold hover:bg-slate-50"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back to Settings
        </button>
      </div>

      {/* ─── Stat cards ─── */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <div className="bg-gradient-to-br from-teal-500 to-cyan-600 rounded-2xl p-4 text-white shadow-lg shadow-cyan-500/20">
          <div className="text-2xl font-bold">{stats.total}</div>
          <div className="text-cyan-100 text-sm font-medium mt-0.5">Total AHUs</div>
        </div>
        <StatCard label="Both Sets" value={stats.both} bg="bg-cyan-50" color="text-cyan-600" />
        <StatCard label="Only Set A" value={stats.setA} bg="bg-blue-50" color="text-blue-600" />
        <StatCard label="Only Set B" value={stats.setB} bg="bg-purple-50" color="text-purple-600" />
        <StatCard label="Disabled" value={stats.disabled} bg="bg-slate-100" color="text-slate-500" />
      </div>

      {/* ─── Search bar ─── */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search AHU name..."
            className="w-full bg-white border border-slate-200 rounded-xl pl-10 pr-4 py-2.5 text-sm text-slate-700 placeholder:text-slate-400 focus:border-cyan-400 focus:ring-2 focus:ring-cyan-100 outline-none"
          />
        </div>
        {success && (
          <div className="inline-flex items-center gap-1.5 text-sm px-3 py-2 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-xl font-semibold">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
            </svg>
            {success}
          </div>
        )}
      </div>

      {error && (
        <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-xl p-3 text-sm">
          {error}
        </div>
      )}

      {/* ─── Table ─── */}
      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
        <div className="h-1.5 bg-gradient-to-r from-teal-400 to-cyan-500" />

        {isLoading && !data ? (
          <div className="p-4 space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-12 bg-slate-100 rounded-xl animate-pulse" />
            ))}
          </div>
        ) : visible.length === 0 ? (
          <div className="p-16 text-center">
            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-teal-50 to-cyan-50 flex items-center justify-center">
              <svg className="w-8 h-8 text-cyan-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
              </svg>
            </div>
            <p className="text-slate-700 font-semibold">
              {search ? 'No matching AHUs' : 'No AHUs in your organization'}
            </p>
            <p className="text-sm text-slate-400 mt-1">
              {search ? 'Try a different search term' : 'Create AHUs in the Assets page first'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-slate-50/80 border-b border-slate-200">
                  <th className="text-left px-5 py-3.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">AHU</th>
                  <th className="text-left px-5 py-3.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">Filter Counts</th>
                  <th className="text-left px-5 py-3.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">Schedule</th>
                  <th className="text-left px-5 py-3.5 text-xs font-semibold text-slate-500 uppercase tracking-wider w-72">Mode</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visible.map(a => {
                  const isSaving = savingAhuId === a.ahuId;
                  return (
                    <tr key={a.ahuId} className="hover:bg-cyan-50/30 transition-colors">
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-slate-100 to-slate-200 flex items-center justify-center shrink-0">
                            <svg className="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                            </svg>
                          </div>
                          <span className="text-sm font-semibold text-slate-800">{a.ahuName}</span>
                        </div>
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {a.setACount > 0 && (
                            <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md font-semibold bg-blue-50 text-blue-700 border border-blue-100">
                              <span className="w-1 h-1 rounded-full bg-blue-500" />
                              Set A · {a.setACount}
                            </span>
                          )}
                          {a.setBCount > 0 && (
                            <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md font-semibold bg-purple-50 text-purple-700 border border-purple-100">
                              <span className="w-1 h-1 rounded-full bg-purple-500" />
                              Set B · {a.setBCount}
                            </span>
                          )}
                          {a.noSetCount > 0 && (
                            <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md font-semibold bg-slate-100 text-slate-600 border border-slate-200">
                              Unclassified · {a.noSetCount}
                            </span>
                          )}
                          {a.totalFilters === 0 && (
                            <span className="text-[11px] text-slate-400 italic">No filters</span>
                          )}
                        </div>
                      </td>
                      <td className="px-5 py-3.5">
                        {a.hasActiveSchedule ? (
                          <span className="inline-flex items-center gap-1 text-[11px] px-2.5 py-0.5 rounded-full font-semibold bg-emerald-50 text-emerald-700 border border-emerald-100">
                            <span className="w-1 h-1 rounded-full bg-emerald-500" />
                            Scheduled
                          </span>
                        ) : (
                          <span className="text-[11px] text-slate-400">—</span>
                        )}
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-2">
                          <select
                            value={a.mode}
                            disabled={isSaving || !canWrite}
                            title={!canWrite ? 'PM_UPDATE permission required' : undefined}
                            onChange={e => handleModeChange(a.ahuId, e.target.value as AhuMode)}
                            className={`flex-1 px-3 py-2 border rounded-xl text-sm font-semibold outline-none transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${MODE_META[a.mode].bg} ${MODE_META[a.mode].text} ${MODE_META[a.mode].border} focus:ring-2 focus:ring-cyan-100`}
                          >
                            <option value="BOTH">Both Sets (A + B)</option>
                            <option value="SET_A">Only Set A</option>
                            <option value="SET_B">Only Set B</option>
                            <option value="DISABLED">Disabled (skip PM)</option>
                          </select>
                          {isSaving && (
                            <div className="w-4 h-4 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin shrink-0" />
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ─── Explanation card ─── */}
      <div className="bg-slate-50 border border-slate-200 rounded-2xl p-5">
        <h3 className="text-sm font-semibold text-slate-800 mb-3">How the modes behave in My Tasks</h3>
        <div className="grid gap-3 md:grid-cols-2 text-xs text-slate-600">
          <div className="flex gap-2">
            <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded font-semibold bg-cyan-50 text-cyan-700 border border-cyan-200 shrink-0 h-5">Both Sets</span>
            <span>All Set A + Set B + unclassified filters count toward completion. Default for all AHUs.</span>
          </div>
          <div className="flex gap-2">
            <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded font-semibold bg-blue-50 text-blue-700 border border-blue-200 shrink-0 h-5">Set A</span>
            <span>Only Set A filters appear in the task card. Unclassified and Set B filters are ignored.</span>
          </div>
          <div className="flex gap-2">
            <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded font-semibold bg-purple-50 text-purple-700 border border-purple-200 shrink-0 h-5">Set B</span>
            <span>Only Set B filters appear in the task card. Unclassified and Set A filters are ignored.</span>
          </div>
          <div className="flex gap-2">
            <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded font-semibold bg-slate-100 text-slate-600 border border-slate-200 shrink-0 h-5">Disabled</span>
            <span>The AHU is hidden from My Tasks entirely, even if its schedule window is open. Use when the AHU is temporarily out of service.</span>
          </div>
        </div>
      </div>

      <ReauthDialog
        open={reauth.isOpen}
        password={reauth.password}
        error={reauth.error}
        isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={() => { reauth.cancel(); setSavingAhuId(null); }}
        actionLabel="Update AHU Filter-Set Mode"
      />
    </div>
  );
}

// ─── Helper ───────────────────────────────────────────

function StatCard({ label, value, bg, color }: {
  label: string; value: number; bg: string; color: string;
}) {
  return (
    <div className="bg-white rounded-2xl p-4 border border-slate-200 shadow-sm">
      <div className="flex items-center gap-3">
        <div className={`w-10 h-10 rounded-xl ${bg} flex items-center justify-center shrink-0`}>
          <svg className={`w-5 h-5 ${color}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
          </svg>
        </div>
        <div className="min-w-0">
          <div className="text-xl font-bold text-slate-800 leading-tight">{value}</div>
          <div className="text-xs text-slate-400 font-medium truncate">{label}</div>
        </div>
      </div>
    </div>
  );
}
